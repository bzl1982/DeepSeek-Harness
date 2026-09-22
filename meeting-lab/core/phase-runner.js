'use strict';
/**
 * core/phase-runner.js —— 阶段编排器：把 planPhases 的**阶段契约真正执行**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须有这一层（此前 plan 与 orchestrator 之间是断的）
 *
 *   modes.js 的 planPhases() 已经产出了一整套契约：
 *       speak        parallel / sequential   —— 「怎么发言」
 *       slice        OTHERS / ALL / …        —— 「每人看什么」
 *       groupSize    组边界                  —— 「组内可见，组间不可见」
 *       groupLeaders 组长标记                —— 「组长代表本组」
 *       produces     产出类型                —— 「这条消息是什么」
 *
 *   但 orchestrator.runTurn() 的语义是**广播**：同一段 text 发给人人。
 *   于是契约在运行期**全部失效**：
 *
 *     ① sequential 接龙名不副实 —— 所有人拿到同一份"阶段前快照"，
 *        第 9 个人根本没看到第 1 个人刚说的话。「层层加码」从未真正发生。
 *     ② 组边界没人执行 —— Q7 的分组降本只活在 plan 里，实际注入量还是 O(N²)。
 *     ③ 归并阶段谁都能看 —— 组内 9 份明细照样灌进归并席，**分了组反而更贵**
 *        （多了一层组长）。estimateCost 里那条 advice 说的就是这个。
 *
 *   本文件把这三件事落地：**plan 出契约，runner 强制契约**。
 * ─────────────────────────────────────────────────────────────────────
 *
 * ★★ 关键机制：阶段来源（provenance）
 *   光有"谁说的"不够，还必须知道**这条消息是哪一阶段产出的** —— 否则：
 *     · 组长会诊时，组长 a 会把"组长 d 在**会诊阶段**的发言"误当成"前面组长的摘要"；
 *     · 归并席会把 9 份组内**明细**全吃进去（分组白做）。
 *   两者都会让实际注入量偏离预估。所以 runner 在每次发言后**比对新消息**，
 *   记下它的出处（阶段名 / 是否组内 / 是否组长 / 属于哪组），供可见性判断使用。
 *
 * ★ 与 estimateCost 的对账（本层唯一可验证的硬指标）
 *   estimateCost() 是静态预估（开跑前告诉你烧多少），本 runner 是实际执行。
 *   注入份数模型必须一致 —— `dryRun()` 的合计必须 === estimateCost().contextPerRound：
 *     顺序接龙(OTHERS/ALL) = Σ_k (baseAccum + k - 1) = n·baseAccum + n(n-1)/2
 *     并行    (OTHERS/ALL) = n · baseAccum
 *     组长会诊             = G·g + G(G-1)/2  （每人读本组 g 份 + 前面组长产出）
 *     材料类(TASK/MATERIAL)= 0（不算"会议上下文注入"）
 *     产物类(DRAFT/CRITIQUES/CONTRACT/CANDIDATES) = 每人 1 份
 *   不等就是有 bug —— 必须查清，不能"差不多"。
 */

const { SLICE, SPEAK, selectSlice, NEVER_IN_MERGE_INPUT } = require('./modes');

/** 归并席的产出模板：**不允许它重新投票**，只允许它确认结论并说明理由 */
const VERDICT_TEMPLATE = [
  '【归并要求】你已经看到全部输入。请输出一份**结论**，不要重新投票、不要复述原文。',
  '必须包含四段，缺一不可：',
  '1. 决议：明确到"做什么"，不写"建议考虑"这类没有动作的话；',
  '2. 分歧：会上没有达成一致的点，写清各方立场；',
  '3. 风险：结论落地后最可能出问题的两处，附触发条件；',
  '4. 待办：谁在什么时候之前做什么（能直接派活）。',
].join('\n');

/* NEVER_IN_MERGE_INPUT 唯一定义在 modes.js（预估与执行必须共用同一份规则），
 * 本文件直接引用并在下方转出，便于调用方从一处 import。 */

/** 默认超量阈值（字符）：超过就先压一次，别把 9 份长文原样塞给归并席 */
const DEFAULT_MAX_MERGE_CHARS = 6000;

/** picker（主席点名）席位的人数静态算不出来，按此预估（与 estimateCost 同源） */
const DEFAULT_PICKER_ESTIMATE = 3;

/** 该阶段是不是"收敛/归并"阶段（ALL 切片 = 看全部） */
function isConvergenceStage(stage) {
  return !!stage && stage.slice === SLICE.ALL;
}

/** 该阶段是否受组边界约束（组内会诊） */
function isGroupInnerStage(stage) {
  return !!stage && !!stage.groupSize && !stage.groupLeaders;
}

/**
 * 本阶段"注入了几份会议上下文"—— **必须按切片语义算**，不是"可见几条算几条"。
 * TASK/MATERIAL 给的是原始任务/材料，不是会议上下文，预估里算 0 份。
 */
function injectedCount(sliceKind, visibleCount, sliceText) {
  switch (sliceKind) {
    case SLICE.NONE:
    case SLICE.TASK:
    case SLICE.MATERIAL:
      return 0;
    case SLICE.DRAFT:
    case SLICE.CRITIQUES:
    case SLICE.CONTRACT:
    case SLICE.CANDIDATES:
      return sliceText ? 1 : 0;   // 每人看一份固定产物
    case SLICE.OTHERS:
    case SLICE.ALL:
    default:
      return visibleCount;        // 真正的 O(N²) 在这一类
  }
}

/** 默认压缩器：不调 API，纯截断（真压缩由调用方注入，如走 API 的摘要器） */
function defaultCompress(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

class PhaseRunner {
  /**
   * @param {object} opts
   *   - meeting        Meeting 实例（消息事实源）；也可不传，改用 ctx.messages 注入
   *   - orchestrator   MeetingOrchestrator（取它的 speakTo 作为默认发送通道）
   *   - speakTo        (providerId, { text, kind, round, timeoutMs }) => Promise<result>
   *                    ★ 可注入：测试时用假的，记录"每个人到底收到了什么文本"
   *   - compress       (text, limit) => Promise<string>|string
   *   - logger         ({ level, msg, data }) => void
   *   - maxMergeChars  归并输入字符上限
   */
  constructor({
    meeting = null,
    orchestrator = null,
    speakTo = null,
    compress = null,
    logger = null,
    maxMergeChars = DEFAULT_MAX_MERGE_CHARS,
    verdictTemplate = VERDICT_TEMPLATE,
    pickerEstimate = DEFAULT_PICKER_ESTIMATE,
  } = {}) {
    this.meeting = meeting;
    this.orchestrator = orchestrator;
    this._speakTo = speakTo
      || (orchestrator && typeof orchestrator.speakTo === 'function' ? orchestrator.speakTo.bind(orchestrator) : null);
    if (!this._speakTo) throw new Error('PhaseRunner: 需要 speakTo 或带 speakTo 的 orchestrator');
    this.compress = compress;
    this.logger = logger || (() => {});
    this.maxMergeChars = maxMergeChars;
    this.verdictTemplate = verdictTemplate;
    this.pickerEstimate = pickerEstimate;

    /** messageId -> 阶段出处（见文件头"阶段来源"） */
    this._origin = new Map();
    /** 已执行过的"只该跑一次"的守恒阶段：`${round}|${stage.name}` */
    this._done = new Set();
  }

  /* ══════════════════════════════════════════════════════════════
     可见集合：**阶段契约的唯一执行点**
     ══════════════════════════════════════════════════════════════ */

  /** 会议记录里的"发言"（排除 user：用户输入走 task 字段；保留 external：外部咨询结论全员可见） */
  _allMessages(ctx) {
    const raw = typeof ctx.messages === 'function'
      ? ctx.messages()
      : (ctx.messages || (this.meeting ? this.meeting.messages : []));
    return (raw || [])
      .filter((m) => m && (m.senderType === 'agent' || m.senderType === 'external'))
      .map((m, i) => ({
        id: m.id || `m${i}`,
        senderId: m.senderId,
        senderType: m.senderType,
        content: m.content,
        kind: m.kind,
        round: m.round,
      }));
  }

  _originOf(m, ctx) {
    if (ctx.originOf) return ctx.originOf(m);
    return this._origin.get(m.id) || null;
  }

  /**
   * 某个发言者在本阶段**能看到哪些发言**。四条规则，按优先级：
   *
   *   R1 组长阶段（groupLeaders）
   *      = 本组全部明细（**含自己**）+ 之前已发言组长的**本阶段**产出。
   *      为什么含自己：组长是本组代表，要引用本组结论（含自己那句）；
   *      它的 OTHERS 语义作用在"组长之间互看"上，不作用在组内。
   *      ★ "前面组长"必须限定为**本阶段**产出 —— 否则会把别的组长在会诊阶段的
   *        发言也算进来，注入量虚高（第一版就踩了这个坑：3 份算成 5 份）。
   *   R2 组内阶段（groupSize）
   *      = 只取**本组成员**的发言（组间不可见）。这是降本的物理前提。
   *   R3 归并阶段（ALL）且本场启用了分组
   *      = **只取组长产出**（+ external）。
   *      ★ 漏掉这条，9 份组内明细照样灌进归并席 —— 分组反而比不分组更贵。
   *   R4 其它：全部可见（selfId 过滤交给 selectSlice 按 slice 语义处理）。
   *
   * 未标记出处的消息（不是本 runner 产出的，例如外部注入 / 历史消息）
   * 一律按"全局可见"处理 —— 保守取全，宁可多给不可丢。
   */
  _visible(stage, providerId, ctx) {
    const all = this._allMessages(ctx);
    const grouped = !!ctx.grouped;
    const myGroup = ctx.groupOf ? ctx.groupOf(providerId) : [providerId];

    if (stage.groupLeaders) {
      const own = all.filter((m) => {
        if (m.senderType === 'external') return true;
        const o = this._originOf(m, ctx);
        if (!o) return myGroup.includes(m.senderId);          // 未标记：按成员归属判断
        return o.groupInner && sameGroup(o.group, myGroup);
      });
      const priorLeaders = all.filter((m) => {
        if (m.senderId === providerId) return false;
        const o = this._originOf(m, ctx);
        return !!o && o.leaders;
      });
      return dedupeBy([...own, ...priorLeaders]);
    }

    if (isGroupInnerStage(stage)) {
      return all.filter((m) => stage.speakers.includes(m.senderId) || m.senderType === 'external');
    }

    if (isConvergenceStage(stage) && grouped) {
      return all.filter((m) => {
        if (m.senderType === 'external') return true;
        const o = this._originOf(m, ctx);
        if (!o) return false;                                  // 分组时未标记的明细不进归并（防白做）
        return !!o.leaders;
      });
    }

    return all;
  }

  /** 归并阶段剔除 ballot/verdict/score（防跟票 / 防抄结论） */
  _applyInputWhitelist(list, stage) {
    if (!isConvergenceStage(stage)) return list;
    return list.filter((m) => !NEVER_IN_MERGE_INPUT.includes(m.kind));
  }

  /* ══════════════════════════════════════════════════════════════
     组装"某人这一轮到底收到什么"
     ══════════════════════════════════════════════════════════════ */

  async _buildTurn(stage, providerId, ctx) {
    const visible = this._applyInputWhitelist(this._visible(stage, providerId, ctx), stage);

    /* 组长阶段的可见集合已由 R1 决定（含本组全部明细），不能再按 selfId 过滤掉组长自己那份
     * —— 所以这里用 ALL 语义拼接；其它阶段按 plan 给的 slice 走。 */
    const sliceKind = stage.groupLeaders ? SLICE.ALL : stage.slice;
    const slice = selectSlice(sliceKind, {
      task: ctx.task || '',
      material: ctx.material || ctx.task || '',
      draft: ctx.draft || '',
      critiques: ctx.critiques || [],
      messages: visible,
      selfId: providerId,
      contract: ctx.contract || null,
      candidates: ctx.candidates || null,
    });

    let text = slice.text || '';
    let compressed = false;
    let compressedFrom = 0;

    if (isConvergenceStage(stage) && text.length > this.maxMergeChars) {
      compressedFrom = text.length;
      /* eslint-disable-next-line no-await-in-loop */
      text = await this._compress(text, this.maxMergeChars);
      compressed = true;
      this.log('warn', `归并输入超量，已压缩：${compressedFrom} → ${text.length} 字`, { stage: stage.name });
    }

    if (stage.produces === 'verdict') {
      text = [text, this.verdictTemplate].filter(Boolean).join('\n\n');
    }

    return {
      text,
      slice,
      /** ★ 本发言者看到的份数（与 estimateCost 同口径） */
      injected: injectedCount(sliceKind, visible.length, slice.text),
      visibleSenderIds: visible.map((m) => m.senderId),
      compressed,
      compressedFrom,
    };
  }

  async _compress(text, limit) {
    if (this.compress) {
      try {
        const out = await this.compress(text, limit);
        if (out) return out;
      } catch (e) {
        this.log('error', `归并压缩失败，回退截断：${e && e.message}`, {});
      }
    }
    return defaultCompress(text, limit);
  }

  _stageInfo(stage, ctx) {
    return {
      stageKey: `${ctx.round != null ? ctx.round : 1}|${stage.name}`,
      name: stage.name,
      groupInner: isGroupInnerStage(stage),
      leaders: !!stage.groupLeaders,
      group: (stage.groupLeaders ? ctx.groupOf(stage.speakers[0]) : stage.speakers) || [],
    };
  }

  /* ══════════════════════════════════════════════════════════════
     执行
     ══════════════════════════════════════════════════════════════ */

  /**
   * 跑一个阶段。
   *
   * @param {object} stage  planPhases 的一个阶段
   * @param {object} ctx    { task, material, draft, critiques, contract, candidates,
   *                          round, messages, timeoutMs, groups, leaderIds, grouped }
   * @param {object} opts   { force } force=true 时忽略"归并只跑一次"
   * @returns {Promise<object>} { name, speak, slice, injected, calls, ok, failed, results, skipped }
   */
  async runStage(stage, ctx = {}, { force = false } = {}) {
    const round = ctx.round != null ? ctx.round : (this.meeting ? this.meeting.round : 1);
    const isConv = isConvergenceStage(stage);
    const onceKey = `${round}|${stage.name}`;
    const base = {
      name: stage.name, index: stage.index, speak: stage.speak, slice: stage.slice,
      produces: stage.produces || null,
    };

    /* ★ 归并阶段默认"一轮只跑一次"：重复执行会往会议记录里塞第二份结论，
     *   后续切片会同时看到两份互相矛盾的 verdict。 */
    if (isConv && !force && this._done.has(onceKey)) {
      this.log('info', `归并阶段「${stage.name}」已执行过，跳过（幂等）`, { round });
      return { ...base, injected: 0, calls: 0, ok: [], failed: [], results: [], skipped: true, skipReason: 'already-run' };
    }

    const speakers = stage.speakers || [];
    if (!speakers.length) {
      return { ...base, injected: 0, calls: 0, ok: [], failed: [], results: [], skipped: true, skipReason: 'no-speakers' };
    }

    /* ★ 并行阶段：快照**冻结**在阶段开始之前 —— 人人看同一份，防锚定。
     *   （第一版写成 `() => this._allMessages(ctx)`，那是"重新读"而不是"冻结"，
     *     结果并行也变成了接龙 —— 实测用例抓到了这个错。） */
    const frozen = this._allMessages(ctx);
    const stageCtx = stage.speak === SPEAK.SEQUENTIAL
      ? ctx
      : { ...ctx, messages: () => frozen };

    const info = this._stageInfo(stage, { ...ctx, round });
    const results = [];
    let injected = 0;

    for (const pid of speakers) {
      /* ★ 顺序接龙：每人间**重新取快照**（ctx.messages 每次调用都重取），
       *   于是第 k 人天然看到前 k-1 人刚写回会议记录的产出。 */
      /* eslint-disable-next-line no-await-in-loop */
      const turn = await this._buildTurn(stage, pid, stageCtx);
      injected += turn.injected;

      const before = new Set(this._allMessages(stageCtx).map((m) => m.id));
      let r;
      try {
        /* eslint-disable-next-line no-await-in-loop */
        r = await this._speakTo(pid, {
          text: turn.text,
          kind: stage.produces || null,
          round,
          timeoutMs: ctx.timeoutMs || 180000,
        });
      } catch (err) {
        // speakTo 理论不抛（异常已收敛），这里只是最后一道保险：一个炸了不停整场
        r = { providerId: pid, ok: false, state: 'UNKNOWN_ERROR', error: String((err && err.message) || err) };
      }

      // ★ 记下本阶段新产出的消息（provenance）—— 组长/归并的可见性全靠它
      for (const m of this._allMessages(stageCtx)) {
        if (!before.has(m.id) && !this._origin.has(m.id)) this._origin.set(m.id, info);
      }

      results.push({
        providerId: pid,
        ok: !!(r && r.ok),
        state: (r && r.state) || 'UNKNOWN_ERROR',
        // ★ 带上回复正文：调用方（UI / 出标匿名化 / 判据）都要用它
        text: (r && r.text) || '',
        error: (r && r.error) || null,
        durationMs: (r && r.durationMs) || 0,
        injected: turn.injected,
        visibleSenderIds: turn.visibleSenderIds,
        compressed: turn.compressed,
      });
      this.log('info', `${pid} ${r && r.ok ? '✔' : '✗'} 阶段「${stage.name}」看到 ${turn.injected} 份`, {
        stage: stage.name, pid, injected: turn.injected,
      });
    }

    const ok = results.filter((x) => x.ok).map((x) => x.providerId);
    const failed = results.filter((x) => !x.ok).map((x) => x.providerId);

    /* 只有"至少有一人成功产出"才算这个归并阶段真的执行过；
     * 全军覆没时保持"未执行"，下次还能再来（否则一次超时就永久锁死归并）。 */
    if (isConv && ok.length) this._done.add(onceKey);

    return { ...base, injected, calls: results.length, ok, failed, results, skipped: false };
  }

  /** 跑完一整个 plan；解析分组结构供各阶段做组边界判断（R1/R2/R3） */
  async runPlan(plan, ctx = {}) {
    const full = this._withGroups(plan, ctx);
    const stages = [];
    for (const st of plan) {
      /* eslint-disable-next-line no-await-in-loop */
      stages.push(await this.runStage(st, full, {}));
    }
    return {
      stages,
      injectedTotal: stages.reduce((a, s) => a + s.injected, 0),
      calls: stages.reduce((a, s) => a + s.calls, 0),
      ok: stages.flatMap((s) => s.ok),
      failed: stages.flatMap((s) => s.failed),
    };
  }

  /**
   * ★ 试算（dry-run）：**完全不发消息**，只按契约算出"每个阶段会注入多少份"。
   *   用途：① 与 estimateCost 对账；② 开跑前给用户看"这场会每一步各看多少"。
   *   假设所有人成功（= 最坏情况），与 estimateCost 的假设一致。
   */
  dryRun(plan, ctx = {}) {
    const round = ctx.round != null ? ctx.round : 1;
    const full = this._withGroups(plan, { ...ctx, round });
    const originLocal = new Map();
    const virtual = this._allMessages({ ...full, messages: ctx.messages }).map((m) => ({ ...m }));

    const stages = [];
    for (const st of plan) {
      const speakers = st.speakers || [];
      const info = this._stageInfo(st, full);

      /* ★ 并行阶段必须用**阶段前快照**：否则第 2 个人会"看到"第 1 个人刚产出的
       *   虚拟消息，试算会算成接龙（第一版就这么把广播算成了 36 份）。 */
      const stageMessages = st.speak === SPEAK.SEQUENTIAL ? () => virtual.slice() : () => frozen.slice();
      const frozen = virtual.slice();

      const runCtx = {
        ...full,
        messages: stageMessages,
        originOf: (m) => originLocal.get(m.id) || null,
      };

      let injected = 0;
      const per = [];
      const isPickerish = !speakers.length;

      if (isPickerish) {
        /* picker 席位人数运行期才知道（主持人点名）→ 与 estimateCost 同源预估，
         * 并标 estimated:true，避免被读成"真的只有 0 份"。 */
        const n = this.pickerEstimate;
        const baseAccum = virtual.length;
        injected = n * baseAccum + (n * (n - 1)) / 2;
        stages.push({
          name: st.name, index: st.index, speak: st.speak, slice: st.slice,
          injected, calls: n, per: [], skipped: true, estimated: true,
        });
        continue;
      }

      for (const pid of speakers) {
        const visible = this._applyInputWhitelist(this._visible(st, pid, runCtx), st);
        const sliceKind = st.groupLeaders ? SLICE.ALL : st.slice;
        const slice = selectSlice(sliceKind, {
          task: full.task || '', material: full.material || full.task || '',
          draft: full.draft || '', critiques: full.critiques || [],
          messages: visible, selfId: pid, contract: full.contract || null, candidates: full.candidates || null,
        });
        const n = injectedCount(sliceKind, visible.length, slice.text);
        injected += n;
        per.push({ providerId: pid, injected: n });

        const vm = { id: `dry:${round}:${st.name}:${pid}`, senderId: pid, senderType: 'agent', content: '(dry-run)', kind: st.produces || null, round };
        originLocal.set(vm.id, info);
        virtual.push(vm);
      }

      stages.push({
        name: st.name, index: st.index, speak: st.speak, slice: st.slice,
        injected, calls: speakers.length, per, skipped: false,
      });
    }

    return { stages, injectedTotal: stages.reduce((a, s) => a + s.injected, 0) };
  }

  /** 对"闭麦"的单个发言者重试（不重跑整个阶段） */
  async retrySpeaker(stage, providerId, ctx = {}) {
    const full = this._withGroups(ctx.plan || [stage], ctx);
    const turn = await this._buildTurn(stage, providerId, full);
    return this._speakTo(providerId, {
      text: turn.text,
      kind: stage.produces || null,
      round: full.round != null ? full.round : (this.meeting ? this.meeting.round : 1),
      timeoutMs: full.timeoutMs || 180000,
    });
  }

  /**
   * 把 plan 的分组结构解析进 ctx（groups / leaderIds / grouped / groupOf）。
   * ★ 供调用方复用：UI 层是**自己按阶段循环**的（要插入匿名化等逻辑），
   *   不能直接调 runPlan，但同样需要这套组边界信息。
   */
  prepare(plan, ctx = {}) {
    return this._withGroups(plan, ctx);
  }

  _withGroups(plan, ctx) {
    const groups = ctx.groups || groupsOfPlan(plan);
    const leaderIds = ctx.leaderIds || (plan || []).filter((p) => p.groupLeaders).flatMap((p) => p.speakers || []);
    return {
      ...ctx,
      groups,
      leaderIds,
      grouped: ctx.grouped != null ? ctx.grouped : groups.length > 1,
      groupOf: ctx.groupOf || ((pid) => groups.find((g) => g.includes(pid)) || [pid]),
    };
  }

  log(level, msg, data) {
    try { this.logger({ level, msg, data }); } catch (e) { /* ignore */ }
  }
}

/* ────────────────────────── 工具函数 ────────────────────────── */

/** 从 plan 里还原分组结构（形如 [[a,b,c],[d,e,f],[g,h,i]]） */
function groupsOfPlan(plan = []) {
  return (plan || [])
    .filter((p) => !!p.groupSize && !p.groupLeaders)
    .map((p) => p.speakers || [])
    .filter((g) => g.length);
}

/** 两组是不是同一组（用"有无交集"判断，不依赖顺序） */
function sameGroup(a = [], b = []) {
  if (!a.length || !b.length) return false;
  return a.some((x) => b.includes(x));
}

function dedupeBy(list) {
  const seen = new Set();
  const out = [];
  for (const m of list) {
    const key = `${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

module.exports = {
  PhaseRunner,
  isConvergenceStage,
  isGroupInnerStage,
  injectedCount,
  groupsOfPlan,
  VERDICT_TEMPLATE,
  NEVER_IN_MERGE_INPUT,
  DEFAULT_MAX_MERGE_CHARS,
};
