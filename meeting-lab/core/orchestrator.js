'use strict';
/**
 * core/orchestrator.js —— 会议编排器（两阶段：先上传握手，再并发发言）
 *
 * 【这是 Phase 0 要验证的后两个不确定性】
 *   现状：广播后 fire-and-forget，一个 AI 卡住没人知道，一个报错静默吞掉。
 *   目标：9 个 AI 各自独立推进；任何一个卡死/掉线/超时，其余照常完成；
 *        失败者被标记进"闭麦"名单，可单独重试。
 *
 * ★ 关键顺序（v1 曾在这里写反，导致门闩永远等不到 ACK 的死锁）：
 *     Phase A：并发把附件投递给每个 AI（uploadFiles → ACK 回流）
 *     Phase B：【门闩】等所有 ACK 到齐（或超时降级）
 *     Phase C：并发放行发送 + 等回复（完成检测）
 *   绝不能"先等 ACK 再上传"。
 *
 * 设计：
 *   - 每个 participant 一条独立的 async 流水线（不共享状态）
 *   - 全流程 try/catch 收敛为"异常态"，绝不外泄炸掉整场会议
 *   - 用 Promise.allSettled 汇总，对外永不 reject
 *
 * 依赖注入：adapters 由外部传入，测试时可塞假 adapter（可控延迟/失败）。
 */

const { CompletionDetector, RESULT } = require('./completion');
const { AttachmentBus } = require('./attachment-bus');
const { MODE, STRATEGY, createStrategy } = require('./speaker');
const { createAttachmentRef } = require('./meeting-model');

/** 把任意异常映射到 per-AI 异常态 */
function classifyError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (/captcha|验证码|robot|challenge/.test(msg)) return 'CAPTCHA_REQUIRED';
  if (/rate|limit|429|频繁/.test(msg)) return 'RATE_LIMIT';
  if (/login|auth|登录|unauthor/.test(msg)) return 'LOGIN_EXPIRED';
  if (/timeout|timed out|超时/.test(msg)) return 'TIMEOUT';
  if (/network|econn|fetch failed|离线/.test(msg)) return 'NETWORK_ERROR';
  if (/upload|上传|file/.test(msg)) return 'UPLOAD_FAILED';
  if (/selector|dom|not found|元素/.test(msg)) return 'DOM_CHANGED';
  return 'UNKNOWN_ERROR';
}

class MeetingOrchestrator {
  /**
   * @param {object} opts
   *   - meeting             Meeting 实例（会议状态唯一持有者）
   *   - adapters            Map<providerId, adapter> 或普通对象
   *   - strategy            发言策略名或 SpeakerStrategy 实例（默认 broadcast）
   *   - strategyOpts        传给 createStrategy 的参数（如 llm_selector 的 select 函数）
   *   - completionOpts      传给 CompletionDetector 的参数
   *   - attachmentBusOpts   传给 AttachmentBus 的参数
   *   - logger              ({level, msg, data}) => void
   */
  constructor({
    meeting,
    adapters = {},
    strategy = STRATEGY.BROADCAST,
    strategyOpts = {},
    completionOpts = {},
    attachmentBusOpts = {},
    logger = null,
  } = {}) {
    if (!meeting) throw new Error('MeetingOrchestrator: meeting required');
    this.meeting = meeting;
    this.adapters = adapters;
    this.completionOpts = completionOpts;
    this.attachmentBus = new AttachmentBus(attachmentBusOpts);
    this.strategy = typeof strategy === 'string' ? createStrategy(strategy, strategyOpts) : strategy;
    this.logger = logger || (() => {});

    /** 失败/超时的 AI（"闭麦"名单） */
    this.silenced = new Map(); // providerId -> { reason, ts }
  }

  getAdapter(providerId) {
    if (this.adapters instanceof Map) return this.adapters.get(providerId) || null;
    return this.adapters[providerId] || null;
  }

  participantsOf(ids = null) {
    const all = this.adapters instanceof Map ? [...this.adapters.keys()] : Object.keys(this.adapters);
    if (!ids) return all;
    return ids.filter((id) => all.includes(id));
  }

  /**
   * 一次会议发言（一轮）。
   *
   * @param {object} opts
   *   - text          用户/系统要广播的文本
   *   - files         [{ name, size, mime, localPath }] 附件（走握手协议）
   *   - participants  指定参会 AI（默认全部）
   *   - timeoutMs     单个 AI 等待回复的上限
   *   - allowDegrade  附件上传失败时是否降级放行
   * @returns {Promise<object>} 本轮汇总
   */
  async runTurn({
    text = '',
    files = [],
    participants = null,
    timeoutMs = 120000,
    allowDegrade = true,
    kind = null,       // 本阶段产出类型（透传进 message.kind，供 CANDIDATES 切片筛选）
    round = null,      // 覆盖轮次（不传则用 meeting.round）
  } = {}) {
    const speakers = this.participantsOf(participants);

    // ---- 1) 会议层登记消息与附件（会议状态独立于网页）----
    const attRefs = [];
    for (const f of files) {
      const ref = createAttachmentRef({
        attachmentId: f.attachmentId || `att_${Math.random().toString(36).slice(2, 10)}`,
        name: f.name,
        size: f.size,
        mime: f.mime,
        sha256: f.sha256,
        localPath: f.localPath,
      });
      this.meeting.registerAttachment(ref);
      this.attachmentBus.register(ref);
      attRefs.push(ref);
    }

    const userMsg = this.meeting.appendMessage({
      senderType: 'user',
      senderId: 'human',
      content: text,
      attachments: attRefs,
      status: 'completed',
    });

    // ---- 2) 策略决定谁发言、并发还是串行 ----
    let decision;
    try {
      decision = await this.strategy.decide({
        participants: speakers,
        meeting: this.meeting,
        round: this.meeting.round,
        text,
      });
    } catch (err) {
      decision = { mode: MODE.PARALLEL, speakers, reason: `strategy failed: ${err.message}` };
    }

    const targets = decision.speakers.filter((s) => !!this.getAdapter(s));
    if (!targets.length) {
      return { round: this.meeting.round, mode: decision.mode, results: [], reason: 'no targets', decision };
    }

    // ---- 3) Phase A + B：附件握手（先并发投递，再等 ACK 到齐）----
    let uploadGate = { action: 'PROCEED', okCount: 0, total: 0 };
    if (attRefs.length) {
      this.attachmentBus.openBatch(targets);

      // Phase A：并发把附件投递给每个 AI（ACK 在此过程中回流）
      const uploads = await Promise.allSettled(
        targets.map((pid) => this._uploadForAgent(pid, attRefs)),
      );

      // Phase B：【门闩】等所有 ACK 到齐；未到齐则轮询等待，超时降级
      uploadGate = await this._awaitUploadAcks({ targets, allowDegrade, timeoutMs });

      this.log('info', 'attachment gate resolved', {
        action: uploadGate.action,
        ok: uploadGate.okCount,
        total: uploadGate.total,
        degraded: uploadGate.degraded || [],
        uploads: uploads.map((u) => (u.status === 'fulfilled' ? u.value && u.value.ok : false)),
      });
    }

    // ---- 4) Phase C：并发/串行放行发言 ----
    const runOne = (pid) => this._sendAndWaitForAgent({ providerId: pid, text, attRefs, uploadGate, timeoutMs, kind });

    let results;
    if (decision.mode === MODE.SEQUENTIAL) {
      results = [];
      for (const pid of targets) {
        // 串行：一个失败不影响后续（逐个 try/catch 已收敛）
        /* eslint-disable-next-line no-await-in-loop */
        results.push(await runOne(pid));
      }
    } else {
      const settled = await Promise.allSettled(targets.map((pid) => runOne(pid)));
      results = settled.map((s, i) =>
        s.status === 'fulfilled'
          ? s.value
          : {
              providerId: targets[i],
              ok: false,
              state: 'UNKNOWN_ERROR',
              error: String(s.reason && s.reason.message),
              durationMs: 0,
            },
      );
    }

    // ---- 5) 汇总 ----
    const okList = results.filter((r) => r.ok).map((r) => r.providerId);
    const failList = results.filter((r) => !r.ok).map((r) => r.providerId);
    for (const r of results) {
      if (!r.ok) this.silenced.set(r.providerId, { reason: r.state || 'ERROR', ts: Date.now() });
    }

    return {
      round: this.meeting.round,
      mode: decision.mode,
      decision,
      userMessageId: userMsg.id,
      attachmentGate: uploadGate,
      ok: okList,
      failed: failList,
      silenced: [...this.silenced.keys()],
      results,
    };
  }

  /**
   * Phase A：单个 AI 的附件投递。
   * 即使抛错也【必须】把失败 ACK 回报给总线，否则门闩会一直等到超时。
   */
  async _uploadForAgent(providerId, attRefs) {
    const adapter = this.getAdapter(providerId);
    const sm = this.meeting.addAgent(providerId);
    const ack = (attachmentId, ok, meta) => this.attachmentBus.ack(providerId, attachmentId, ok, meta);

    this._ensureReady(sm, Date.now());
    const r = sm.transition('UPLOADING', { ts: Date.now() });
    if (!r.ok && sm.state === 'UPLOADING') {
      // 已在上传态（重复调用）—— 无害
    }

    try {
      return await adapter.uploadFiles(attRefs, { onAck: ack });
    } catch (err) {
      const code = classifyError(err);
      for (const a of attRefs) ack(a.attachmentId, false, { error: code });
      this.log('error', `${providerId} 附件投递异常：${err && err.message}`, { code });
      return { ok: false, error: String((err && err.message) || err), code };
    }
  }

  /** 门闩：等待所有 AI 的附件 ACK，直到就绪/降级/耗尽超时 */
  async _awaitUploadAcks({ targets, allowDegrade, timeoutMs }) {
    const budget = Math.min(timeoutMs || 120000, this.attachmentBus.defaultTimeoutMs + 15000);
    const deadline = Date.now() + budget;

    /* eslint-disable-next-line no-constant-condition */
    while (true) {
      const gate = this.attachmentBus.gate({ allowDegrade });
      if (gate.action === 'PROCEED' || gate.action === 'DEGRADE' || gate.action === 'ABORT') {
        return gate;
      }
      if (Date.now() >= deadline) {
        const final = this.attachmentBus.gate({ allowDegrade: true });
        return { ...final, action: final.action === 'WAIT' ? 'DEGRADE' : final.action };
      }
      /* eslint-disable-next-line no-await-in-loop */
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * ★ 逐人发送（阶段编排层专用）：**给指定的一个 AI 送一段"只属于它的"文本**。
   *
   * 为什么必须有它（而不是复用 runTurn）：
   *   runTurn 的语义是"广播"——同一段 text 发给人人。
   *   但模式层（modes.js）的 `speak` / `slice` 契约要求**每人看到不同的前文**：
   *     · sequential 接龙 → 第 k 人必须看到前 k-1 人**本阶段刚产出**的内容
   *     · slice OTHERS   → 每个人拿到的上下文不同（不含自己）
   *   用 runTurn 跑接龙，所有人都拿同一份阶段前快照，"接龙"名不副实。
   *
   * 与 runTurn 的两处刻意差异：
   *   1. **不写 user 消息**。文本是运行时按人组装的上下文，不是用户输入；
   *      若每人写一条，9 人一场会就会往会议记录里塞 9 条假的"用户发言"。
   *   2. `round` 可覆盖（阶段编排器要保证同一阶段的产出落在同一轮）。
   *
   * 附件仍走完整两阶段握手（先投递、后等 ACK）。
   */
  async speakTo(providerId, { text = '', files = [], timeoutMs = 120000, kind = null, round = null } = {}) {
    if (!this.getAdapter(providerId)) throw new Error(`speakTo: no adapter for ${providerId}`);

    const attRefs = [];
    for (const f of files) {
      const ref = createAttachmentRef({
        attachmentId: f.attachmentId || `att_${Math.random().toString(36).slice(2, 10)}`,
        name: f.name,
        size: f.size,
        mime: f.mime,
        sha256: f.sha256,
        localPath: f.localPath,
      });
      this.meeting.registerAttachment(ref);
      this.attachmentBus.register(ref);
      attRefs.push(ref);
    }

    let uploadGate = { action: 'PROCEED', okCount: 0, total: 0 };
    if (attRefs.length) {
      this.attachmentBus.openBatch([providerId]);
      await this._uploadForAgent(providerId, attRefs);
      uploadGate = await this._awaitUploadAcks({ targets: [providerId], allowDegrade: true, timeoutMs });
    }

    return this._sendAndWaitForAgent({ providerId, text, attRefs, uploadGate, timeoutMs, kind, round });
  }

  /**
   * Phase C：单个 AI 的发送 + 等待回复。
   * 绝不允许抛错——一切异常收敛为 { ok:false, state:<异常态> }。
   */
  async _sendAndWaitForAgent({ providerId, text, attRefs, uploadGate, timeoutMs, kind = null, round = null }) {
    const started = Date.now();
    const sm = this.meeting.addAgent(providerId);
    const adapter = this.getAdapter(providerId);
    const out = {
      providerId,
      ok: false,
      state: sm.state,
      text: '',
      completion: null,
      upload: null,
      durationMs: 0,
      error: null,
    };

    try {
      this._ensureReady(sm, started);

      // 记录本 AI 的上传结果（供 UI 显示）
      if (attRefs.length) {
        const degraded = Array.isArray(uploadGate.degraded) && uploadGate.degraded.includes(providerId);
        out.upload = degraded
          ? { skipped: true, reason: 'degraded' }
          : { ok: true, count: attRefs.length };
      }

      // ---- 发送 ----
      sm.transition('SENDING', { ts: Date.now() });
      await adapter.sendText(this._composeIncoming(text, attRefs, uploadGate, providerId));

      // ---- 等待回复（完成检测器在这里发挥作用）----
      sm.transition('THINKING', { ts: Date.now() });
      const limit = timeoutMs || this.completionOpts.timeoutMs || 120000;
      const detector = new CompletionDetector({ ...this.completionOpts, timeoutMs: limit });
      detector.start();
      sm.transition('STREAMING', { ts: Date.now() });

      const resp = await adapter.waitForResponse({ detector, timeoutMs: limit });

      out.text = (resp && resp.text) || '';
      out.completion = (resp && resp.completion) || detector.snapshot();

      const result = (out.completion && out.completion.result) || RESULT.PENDING;
      if (result === RESULT.COMPLETED) {
        sm.transition('COMPLETED', { ts: Date.now() });
        out.ok = true;
        out.state = 'COMPLETED';
      } else if (result === RESULT.TIMEOUT) {
        sm.transition('TIMEOUT', { message: out.completion.reason, ts: Date.now() });
        out.state = 'TIMEOUT';
        out.error = out.completion.reason;
      } else {
        sm.transition('UNKNOWN_ERROR', { message: 'no completion verdict', ts: Date.now() });
        out.state = 'UNKNOWN_ERROR';
        out.error = 'no completion verdict';
      }

      // ---- 写回会议记录（会议状态独立于网页）----
      if (out.text) {
        this.meeting.appendMessage({
          senderType: 'agent',
          senderId: providerId,
          content: out.text,
          /* ★ kind = 本阶段「产出什么」（来自 mode.phases[].produces，由调用方透传）。
           *   它是 CANDIDATES 切片的筛选依据：
           *     出标阶段 → 'candidate'（候选方案，会被匿名后发给评标者）
           *     评标阶段 → 'ballot'   （名次表，**绝不能**被当成候选再发出去 → 会跟票）
           *   没有这个字段，环切片的输入侧就接不上 —— 这是第五轮发现的"贯通性缺口"。 */
          kind: kind || undefined,
          round: round != null ? round : this.meeting.round,
          status: out.ok ? 'completed' : 'failed',
        });
      }
    } catch (err) {
      const state = classifyError(err);
      try {
        if (!sm.isTerminal()) sm.transition(state, { message: err && err.message, ts: Date.now() });
      } catch (e) { /* 状态迁移失败不影响汇总 */ }
      out.ok = false;
      out.state = state;
      out.error = String((err && err.message) || err);
      this.log('error', `${providerId} 失败：${out.error}`, { state });
    }

    out.durationMs = Date.now() - started;
    return out;
  }

  /** 保证状态机处于可推进的位置（首次 / 上一轮已终结 / 异常后都归位到 READY） */
  _ensureReady(sm, ts) {
    if (sm.state === 'READY' || sm.state === 'UPLOADING') return;
    if (sm.state === 'OFFLINE' || sm.isTerminal() || sm.isError()) {
      sm.reset({ ts });
    }
  }

  /**
   * 组装"这个 AI 实际看到的内容"。
   * ★ 这里就是解决"网页自带上下文 vs 会议记录注入"冲突的边界：
   *   - 默认（第一轮/短会）：只发当前这一条，尊重网页自己的上下文
   *   - 需要交叉讨论时：由调用方组装带会议纪要的文本再传进来
   */
  _composeIncoming(text, attRefs, uploadGate, providerId) {
    const parts = [];
    const degraded = Array.isArray(uploadGate.degraded) && uploadGate.degraded.includes(providerId);
    if (degraded && attRefs.length) {
      parts.push(
        `[系统] 附件上传未完成，以下为文件摘要占位：${attRefs.map((a) => a.name).join('、')}`,
      );
    }
    parts.push(text);
    return parts.filter(Boolean).join('\n\n');
  }

  /** 对"闭麦"的 AI 单独重试（不重开整场会议） */
  async retryAgent(providerId, { text = '', files = [], timeoutMs = 120000, kind = null, round = null } = {}) {
    if (!this.getAdapter(providerId)) throw new Error(`retryAgent: no adapter for ${providerId}`);
    const prev = this.silenced.get(providerId);
    const sm = this.meeting.getAgent(providerId);
    if (sm && !sm.isTerminal()) {
      try { sm.reset({ message: `retry after ${prev ? prev.reason : 'unknown'}` }); } catch (e) { /* ignore */ }
    } else if (sm) {
      sm.reset({ message: `retry after ${prev ? prev.reason : 'unknown'}` });
    }

    this.silenced.delete(providerId);

    // 重试也走完整两阶段（有附件时先握手）—— 复用 speakTo，避免两条路径行为漂移
    return this.speakTo(providerId, { text, files, timeoutMs, kind, round });
  }

  log(level, msg, data) {
    try { this.logger({ level, msg, data }); } catch (e) { /* ignore */ }
  }
}

module.exports = { MeetingOrchestrator, classifyError };
