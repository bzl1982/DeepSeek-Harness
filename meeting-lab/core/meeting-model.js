'use strict';
/**
 * core/meeting-model.js —— 会议消息模型 + per-AI 状态机
 *
 * 设计要点（对应《评审与定案》§4.4）：
 *   1. 会议状态【独立于网页】——刷新/崩溃/重启/掉线，会议记录都还在
 *   2. 一个文件 = 一个 attachmentId（9 个 AI 共用同一份引用）
 *   3. 每个 AI 有自己的状态机，异常可定位、可单独重试
 *
 * 纯 Node、无 GUI 依赖，可被 node --test 直接测试。
 */

/** ---------- per-AI 状态机 ---------- */

/** 正常流转链路 */
const FLOW = [
  'OFFLINE',
  'LOADING',
  'LOGIN_REQUIRED',
  'READY',
  'UPLOADING',
  'SENDING',
  'THINKING',
  'STREAMING',
  'COMPLETED',
];

/** 异常态（可从任何非终态进入） */
const ERROR_STATES = [
  'NETWORK_ERROR',
  'RATE_LIMIT',
  'CAPTCHA_REQUIRED',
  'LOGIN_EXPIRED',
  'UPLOAD_FAILED',
  'DOM_CHANGED',
  'TIMEOUT',
  'UNKNOWN_ERROR',
];

/** 终结态：到达后本轮不再变化，需显式 reset */
const TERMINAL_STATES = ['COMPLETED', ...ERROR_STATES];

const AGENT_STATES = Object.freeze({
  ...Object.fromEntries([...FLOW, ...ERROR_STATES].map((s) => [s, s])),
});

const FLOW_INDEX = Object.fromEntries(FLOW.map((s, i) => [s, i]));

class AgentStateMachine {
  constructor(providerId, { onChange } = {}) {
    this.providerId = providerId;
    this.state = 'OFFLINE';
    this.history = [{ state: 'OFFLINE', ts: 0, note: 'init' }];
    this._onChange = onChange || null;
    this.error = null;
  }

  /** 是否为终结态（本轮已完成或已失败） */
  isTerminal() {
    return TERMINAL_STATES.includes(this.state);
  }

  /** 是否处于异常态 */
  isError() {
    return ERROR_STATES.includes(this.state);
  }

  /**
   * 合法性判定：正常链路只能前进（允许跳步，如 READY→THINKING），
   * 异常态可从任何非终态进入，异常态可 reset 回 READY 重试。
   */
  canTransition(to) {
    if (!AGENT_STATES[to]) return false;
    if (to === this.state) return false;
    if (ERROR_STATES.includes(to)) return !this.isTerminal() || this.isError();
    if (to === 'OFFLINE') return true; // 显式下线
    // 注意：READY 不是"万能目标"。要重试/重开一轮请用 reset()，
    //       否则会掩盖"状态倒退"这类真实 bug。
    const from = FLOW_INDEX[this.state];
    const next = FLOW_INDEX[to];
    if (from === undefined || next === undefined) return false;
    return next > from;
  }

  transition(to, meta = {}) {
    if (!this.canTransition(to)) {
      return { ok: false, error: `illegal transition ${this.state} -> ${to}` };
    }
    const prev = this.state;
    this.state = to;
    if (ERROR_STATES.includes(to)) {
      this.error = { code: to, message: meta.message || '', ts: meta.ts || 0 };
    } else if (to === 'READY' || to === 'COMPLETED') {
      this.error = null;
    }
    const entry = { state: to, ts: meta.ts || 0, from: prev, note: meta.message || '' };
    this.history.push(entry);
    if (this._onChange) {
      try { this._onChange(entry); } catch (e) { /* 观察者异常不得影响主流程 */ }
    }
    return { ok: true, from: prev, to };
  }

  /**
   * 显式重置为 READY（用于单点重试 / 开新一轮）。
   * 这是唯一允许"状态倒退"的入口——故意的、显式的，不是偷偷摸摸的。
   */
  reset(meta = {}) {
    const ts = meta.ts || 0;
    if (this.state === 'READY') {
      return { ok: true, from: 'READY', to: 'READY', noop: true };
    }
    const prev = this.state;
    this.state = 'READY';
    this.error = null;
    const entry = { state: 'READY', ts, from: prev, note: meta.message || 'reset' };
    this.history.push(entry);
    if (this._onChange) {
      try { this._onChange(entry); } catch (e) { /* 观察者异常不得影响主流程 */ }
    }
    return { ok: true, from: prev, to: 'READY' };
  }

  toJSON() {
    return { providerId: this.providerId, state: this.state, error: this.error, history: this.history };
  }
}

/** ---------- 附件引用 ---------- */

/** 一个文件 = 一个 attachmentId，9 个 AI 共用同一份引用 */
function createAttachmentRef({ attachmentId, name, size, mime, sha256, localPath }) {
  if (!attachmentId) throw new Error('createAttachmentRef: attachmentId required');
  return {
    attachmentId,
    name: name || 'unnamed',
    size: Number(size) || 0,
    mime: mime || 'application/octet-stream',
    sha256: sha256 || '',
    localPath: localPath || '',
  };
}

/** ---------- 会议消息模型 ---------- */

let _seq = 0;
function nextId(prefix) {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}${_seq.toString(36).padStart(2, '0')}`;
}

/**
 * 允许的消息来源类型。
 *
 * ★ 'external' 是第五轮的补洞（详见 core/external.js 的长注释）：
 *   用户在浏览器里问完外部 AI（元宝/谷歌/千问…）再**手工粘贴回来**。
 *   这些回答必须与 agent 消息**平级**，否则：
 *     - 归为 'user' → 被切片当用户输入排除（后面的 AI 看不到外面怎么说）
 *     - 伪装成 'agent' → 看不出"这条是哪家给的"，审计说不清，也无法匿名
 */
const SENDER_TYPES = ['user', 'agent', 'system', 'external'];

function createMessage({
  meetingId,
  senderType = 'user',
  senderId = 'human',
  content = '',
  attachments = [],
  round = 1,
  turn = 0,
  timestamp = Date.now(),
  status = 'completed',
  kind = null,       // ★ 产出类型（'candidate'/'ballot'/'verdict'/'artifact'/…）
                     //   来源：mode.phases[].produces，由编排层透传。
                     //   用途：CANDIDATES 切片靠它区分"候选方案"与"评标意见"。
  external = null,   // ★ 外部来源详情 { provider, model, url, question, note }
                     //   仅 senderType==='external' 时使用。
  id = null,
} = {}) {
  if (!meetingId) throw new Error('createMessage: meetingId required');
  if (!SENDER_TYPES.includes(senderType)) {
    throw new Error(`createMessage: bad senderType ${senderType}`);
  }
  /* ★ 双向校验：external 字段与 senderType 必须同时出现。
   *   只写一个都是 bug —— 有类型没来源（审计说不清），有来源没类型（切片看不见）。 */
  if (external && senderType !== 'external') {
    throw new Error("createMessage: external 字段只能配 senderType='external'");
  }
  if (senderType === 'external' && !external) {
    throw new Error("createMessage: senderType='external' 必须带 external 来源信息");
  }
  return {
    id: id || nextId('msg'),
    meetingId,
    senderType,
    senderId,
    content,
    kind: kind || undefined,
    external: external
      ? {
        provider: external.provider || null,
        model: external.model || null,
        url: external.url || null,
        question: external.question || null,
        note: external.note || null,
      }
      : undefined,
    attachments: Array.isArray(attachments) ? attachments : [],
    round: Number(round) || 1,
    turn: Number(turn) || 0,
    timestamp,
    status,
  };
}

/**
 * Meeting —— 会议状态的唯一持有者。
 * 网页只是"手"，会议记录在这里，与网页生命周期解耦。
 */
class Meeting {
  constructor({ meetingId = null, topic = '' } = {}) {
    this.meetingId = meetingId || nextId('meeting');
    this.topic = topic;
    this.messages = [];
    this.attachments = new Map(); // attachmentId -> AttachmentRef
    this.agents = new Map(); // providerId -> AgentStateMachine
    this.round = 1;
    this.turn = 0;
    this.status = 'idle'; // idle | running | paused | closed
    this.createdAt = Date.now();
  }

  /** 注册参会 AI（每个 provider 一个状态机） */
  addAgent(providerId) {
    if (!this.agents.has(providerId)) {
      this.agents.set(providerId, new AgentStateMachine(providerId));
    }
    return this.agents.get(providerId);
  }

  getAgent(providerId) {
    return this.agents.get(providerId) || null;
  }

  /** 登记附件（同一文件在会议内只登记一次） */
  registerAttachment(ref) {
    if (!this.attachments.has(ref.attachmentId)) {
      this.attachments.set(ref.attachmentId, ref);
    }
    return this.attachments.get(ref.attachmentId);
  }

  resolveAttachments(ids = []) {
    return ids.map((id) => this.attachments.get(id)).filter(Boolean);
  }

  /** 追加消息（自动分配 turn） */
  appendMessage(input) {
    const msg = createMessage({
      meetingId: this.meetingId,
      round: input.round != null ? input.round : this.round,
      turn: input.turn != null ? input.turn : this.turn++,
      ...input,
    });
    this.messages.push(msg);
    return msg;
  }

  /** 用外部构造好的消息追加（供编排层复用） */
  pushMessage(msg) {
    if (msg.meetingId !== this.meetingId) {
      throw new Error('pushMessage: meetingId mismatch');
    }
    this.messages.push(msg);
    return msg;
  }

  /** 开启新一轮 */
  nextRound() {
    this.round += 1;
    this.turn = 0;
    return this.round;
  }

  /** 某轮内某个 AI 的发言 */
  messagesOf(providerId) {
    return this.messages.filter((m) => m.senderId === providerId);
  }

  /** 某轮的全体发言 */
  messagesInRound(round = this.round) {
    return this.messages.filter((m) => m.round === round);
  }

  /** 汇总各 AI 当前状态（给 UI 显示状态灯） */
  stateSummary() {
    const out = {};
    for (const [pid, sm] of this.agents) out[pid] = sm.state;
    return out;
  }

  /** 判断本轮是否全部终结（完成或失败） */
  isRoundSettled(round = this.round) {
    const speakers = new Set(this.messagesInRound(round).map((m) => m.senderId));
    const participants = [...this.agents.keys()].filter((p) => speakers.has(p));
    if (!participants.length) return false;
    return participants.every((p) => {
      const sm = this.agents.get(p);
      return sm && sm.isTerminal();
    });
  }

  /** 序列化（存档/回放用） */
  toJSON() {
    return {
      meetingId: this.meetingId,
      topic: this.topic,
      round: this.round,
      turn: this.turn,
      status: this.status,
      createdAt: this.createdAt,
      messages: this.messages,
      attachments: [...this.attachments.values()],
      agents: [...this.agents.values()].map((a) => a.toJSON()),
    };
  }
}

module.exports = {
  AGENT_STATES,
  FLOW,
  ERROR_STATES,
  TERMINAL_STATES,
  SENDER_TYPES,
  AgentStateMachine,
  createAttachmentRef,
  createMessage,
  nextId,
  Meeting,
};
