'use strict';
/**
 * core/transparent-meeting.js —— 「透明广播」会议引擎（用户指定的新形态）
 *
 * 与 modes.js 那套"防锚定、分阶段切片"的设计不同，这里是用户明确要的形态：
 *   1. 每一轮把「除自己外所有人的上一轮发言」汇编成【一条】带说话人标签的消息
 *      （ChatGPT 说… / Gemini 说…），发给每个人 —— 所有人都能听到别人，才有得评。
 *   2. 首条（第 1 轮）消息里写清【全部会议规则】，让接收方知道自己在开会、按什么规则来。
 *   3. 每一轮结束自动生成 MD：round-N.md（本轮每个人的完整回答）+ 会议记录.md（累计汇总）。
 *
 * 复用现有原语（不重写 modes/phase-runner）：
 *   - Meeting            ：会议状态唯一持有者（与网页解耦）
 *   - MeetingOrchestrator.speakTo ：逐人发送带「只属于它的」上下文，不写假 user 消息
 *   - reporter.js        ：落盘 MD
 *
 * 用法：
 *   const tm = new TransparentMeeting({
 *     topic, participants, adapters, names,
 *     rounds, outBaseDir, completionOpts, perTurnTimeoutMs, materials,
 *   });
 *   const { outDir } = await tm.run();
 */

const fs = require('fs');
const path = require('path');
const { Meeting } = require('./meeting-model');
const { MeetingOrchestrator } = require('./orchestrator');
const { STRATEGY } = require('./speaker');
const { ensureDir, slug, writeRoundMarkdown, writeMasterRecord } = require('./reporter');

/** 首轮下发的完整规则（让接收方明确"在开会、按什么规则来"） */
const DEFAULT_RULES = `【会议规则 · 你正在参加一场多 AI 协同会议】
1. 你会收到「本轮议题」，以及「上一轮其他参会者的发言」（都已标注是谁说的）。
2. 你只会看到别人的发言，不会看到你自己上一轮的发言。请基于议题和他人的观点，给出你独立的判断、补充或反驳。
3. 若议题或材料不完整，请明确指出缺什么，不要凭空编造结论。
4. 每轮请完整、客观地输出你的观点；会议会自动生成完整记录，无需你总结。
5. 优先可验证、有依据的内容；避免无根据的断言。`;

const RULES_REMINDER = `【本轮提醒】这是多 AI 协同会议的第 {N} 轮。下方是上一轮其他参会者的发言，请据此给出你本轮观点。`;

class TransparentMeeting {
  /**
   * @param {object} opts
   *   - topic        议题
   *   - participants [providerId] 参会 AI
   *   - adapters     { providerId: adapter }
   *   - names        { providerId: 显示名 }
   *   - rules        自定义首轮规则（默认 DEFAULT_RULES）
   *   - rounds       轮数（默认 2）
   *   - outBaseDir   会议 MD 落盘根目录（默认 meeting-lab/meetings/）
   *   - logger       ({level,msg}) => void
   */
  constructor({
    topic = '',
    participants = [],
    adapters = {},
    names = {},
    rules = DEFAULT_RULES,
    rounds = 2,
    outBaseDir = null,
    completionOpts = { minSignals: 2, timeoutMs: 180000 },
    perTurnTimeoutMs = 180000,
    materials = [],
    logger = null,
  } = {}) {
    this.topic = topic;
    this.participants = participants;
    this.adapters = adapters;
    this.names = names;
    this.rules = rules;
    this.rounds = rounds;
    this.completionOpts = completionOpts;
    this.perTurnTimeoutMs = perTurnTimeoutMs;
    this.materials = materials || [];
    this.logger = logger || (() => {});

    this.meeting = new Meeting({ topic });
    this.outDir = this._initOutDir(outBaseDir);

    /* ★ 暂停 / 停止（用户需求：AI 卡住时不能只能关软件重启）
     *   pause()  ：闸门 —— 各轮/各席位发送前会在 _gate() 等待，直到 resume()
     *   abort()  ：停止 —— _gate() 立刻抛 MEETING_ABORTED，已完成的发言照常落盘 */
    this._paused = false;
    this._aborted = false;
  }

  pause() { this._paused = true; }
  resume() { this._paused = false; }
  abort() { this._aborted = true; this._paused = false; }
  get paused() { return this._paused; }
  get aborted() { return this._aborted; }

  /** 闸门：暂停时在此等待；停止时抛 MEETING_ABORTED（并发任务各自经过） */
  async _gate() {
    while (this._paused && !this._aborted) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this._aborted) {
      this._cancelAll();
      const err = new Error('MEETING_ABORTED');
      err.code = 'MEETING_ABORTED';
      throw err;
    }
  }

  /** 停止时尽量叫停已在路上的网页请求（尽力而为，不阻断流程） */
  _cancelAll() {
    for (const a of Object.values(this.adapters || {})) {
      try { if (a && typeof a.cancel === 'function') a.cancel(); } catch (_) { /* 尽力而为 */ }
    }
  }

  /** 主持人插话：作为一条 user 消息进会议记录，下一轮汇编进每个人的提示 */
  pushChairMessage(text) {
    const { createMessage } = require('./meeting-model');
    const msg = createMessage({
      meetingId: this.meeting.meetingId,
      senderType: 'user',
      senderId: 'chair',
      content: String(text || ''),
      round: this.meeting.round,
      kind: 'chair',
    });
    this.meeting.pushMessage(msg);
    return msg;
  }

  _initOutDir(outBaseDir) {
    const base = outBaseDir || path.join(__dirname, '..', 'meetings');
    const dir = path.join(base, `${slug(this.topic)}-${this.meeting.meetingId}`);
    return ensureDir(dir);
  }

  /**
   * 上一轮「除自己外」所有人的发言，汇编成一段带标签的文本。
   * 第 1 轮（无上一轮）返回空串。
   * @param {number} round         当前轮
   * @param {string} excludeId     排除的发言者（自己）
   */
  _othersBlock(round, excludeId) {
    if (round < 2) return '';
    const prev = this.meeting
      .messagesInRound(round - 1)
      .filter((m) => m.senderType === 'agent' && m.status === 'completed' && m.senderId !== excludeId);
    if (!prev.length) return '';
    const L = ['【上一轮其他参会者的发言】'];
    for (const m of prev) {
      const who = this.names[m.senderId] || m.senderId;
      L.push(`\n### ${who} 说：\n${(m.content || '').trim()}`);
    }
    return L.join('\n');
  }

  /** 主持人此前的发言（round < 当前轮），汇编成一段（让所有人看到主持人指示） */
  _chairBlock(round) {
    const msgs = this.meeting.messages
      .filter((m) => m.senderType === 'user' && m.senderId === 'chair' && m.round < round && m.content);
    if (!msgs.length) return '';
    const L = ['【主持人发言】'];
    for (const m of msgs) L.push(`\n### 主持人说：\n${String(m.content).trim()}`);
    return L.join('\n');
  }

  /** 组装发给某人的本轮提示：规则/提醒 + 议题 + （第 ≥2 轮）其他人发言汇编 */
  _buildPrompt(round, providerId) {
    const parts = [];
    parts.push(round === 1
      ? this.rules
      : RULES_REMINDER.replace('{N}', String(round)));
    parts.push(`\n【本轮议题】\n${this.topic}`);
    const block = this._othersBlock(round, providerId);
    if (block) parts.push(`\n${block}`);
    const chair = this._chairBlock(round);
    if (chair) parts.push(`\n${chair}`);
    parts.push(round === 1
      ? '\n请给出你的初始观点。'
      : '\n请基于以上（他人的观点 + 议题），给出你本轮的观点（可补充、反驳或提出新角度）。不要重复你自己的上一轮发言。');
    return parts.join('\n');
  }

  /** 把议题资料（用户提供的文件）拷进会议文件夹，便于归档与追溯 */
  copyMaterials() {
    if (!this.materials || !this.materials.length) return [];
    const copied = [];
    for (const src of this.materials) {
      try {
        if (!fs.existsSync(src)) { this.logger({ level: 'warn', msg: `[资料] 不存在，跳过：${src}` }); continue; }
        const name = path.basename(src);
        const dest = path.join(this.outDir, name);
        fs.copyFileSync(src, dest);
        copied.push(dest);
        this.logger({ level: 'info', msg: `[资料] 已归档：${name}` });
      } catch (e) {
        this.logger({ level: 'error', msg: `[资料] 拷贝失败：${src} → ${e.message}` });
      }
    }
    return copied;
  }

  /** 跑一轮：并发发给所有人（各自拿到含「其他人发言」的提示），随后落盘 MD */
  async runRound(round) {
    this.meeting.round = round;
    await this._gate();   // 暂停 / 停止闸门（整轮发送前）
    const settled = await Promise.allSettled(
      this.participants.map(async (pid) => {
        await this._gate();   // 每个席位发送前再过一次闸门
        return this.orch.speakTo(pid, { text: this._buildPrompt(round, pid), timeoutMs: this.perTurnTimeoutMs, kind: 'answer', round });
      })
    );

    const roundFile = writeRoundMarkdown({ outDir: this.outDir, meeting: this.meeting, round, names: this.names, topic: this.topic });
    const masterFile = writeMasterRecord({ outDir: this.outDir, meeting: this.meeting, names: this.names });
    return { round, settled, roundFile, masterFile };
  }

  /** 跑完整场会议 */
  async run() {
    this.orch = new MeetingOrchestrator({
      meeting: this.meeting,
      adapters: this.adapters,
      strategy: STRATEGY.BROADCAST,
      completionOpts: this.completionOpts,
      logger: this.logger,
    });

    this.copyMaterials();

    try {
      for (let r = 1; r <= this.rounds; r++) {
        /* eslint-disable-next-line no-await-in-loop */
        await this.runRound(r);
        if (r < this.rounds) this.meeting.nextRound();
      }
    } catch (e) {
      // 停止：已完成的发言照常落盘（不丢已花掉的内容），异常继续抛给调用方
      if (this.aborted) {
        try {
          writeMasterRecord({ outDir: this.outDir, meeting: this.meeting, names: this.names });
        } catch (_) { /* 落盘失败不遮蔽原异常 */ }
      }
      throw e;
    }
    return { outDir: this.outDir, meeting: this.meeting };
  }
}

module.exports = { TransparentMeeting, DEFAULT_RULES, RULES_REMINDER };
