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
 *   const tm = new TransparentMeeting({ topic, participants, adapters, names, rounds, outBaseDir });
 *   await tm.run();
 */

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
    logger = null,
  } = {}) {
    this.topic = topic;
    this.participants = participants;
    this.adapters = adapters;
    this.names = names;
    this.rules = rules;
    this.rounds = rounds;
    this.logger = logger || (() => {});

    this.meeting = new Meeting({ topic });
    this.outDir = this._initOutDir(outBaseDir);
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

  /** 组装发给某人的本轮提示：规则/提醒 + 议题 + （第 ≥2 轮）其他人发言汇编 */
  _buildPrompt(round, providerId) {
    const parts = [];
    parts.push(round === 1
      ? this.rules
      : RULES_REMINDER.replace('{N}', String(round)));
    parts.push(`\n【本轮议题】\n${this.topic}`);
    const block = this._othersBlock(round, providerId);
    if (block) parts.push(`\n${block}`);
    parts.push(round === 1
      ? '\n请给出你的初始观点。'
      : '\n请基于以上（他人的观点 + 议题），给出你本轮的观点（可补充、反驳或提出新角度）。不要重复你自己的上一轮发言。');
    return parts.join('\n');
  }

  /** 跑一轮：并发发给所有人（各自拿到含「其他人发言」的提示），随后落盘 MD */
  async runRound(round) {
    this.meeting.round = round;
    const settled = await Promise.allSettled(
      this.participants.map((pid) =>
        this.orch.speakTo(pid, { text: this._buildPrompt(round, pid), timeoutMs: 180000, kind: 'answer', round })
      )
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
      completionOpts: { minSignals: 2, timeoutMs: 120000 },
      logger: this.logger,
    });

    for (let r = 1; r <= this.rounds; r++) {
      /* eslint-disable-next-line no-await-in-loop */
      await this.runRound(r);
      if (r < this.rounds) this.meeting.nextRound();
    }
    return { outDir: this.outDir, meeting: this.meeting };
  }
}

module.exports = { TransparentMeeting, DEFAULT_RULES, RULES_REMINDER };
