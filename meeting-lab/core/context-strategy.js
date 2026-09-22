'use strict';
/**
 * core/context-strategy.js —— 上下文策略（分歧 #1 的裁决实现）
 *
 * 第二轮共识裁决：「Hy4 的注入公式 + KIMI 的触发条件」
 *
 *   公式（Hy4）：
 *     prompt = 角色前缀 + [本轮任务] + [最近 N 轮原文 N=2] + [更早历史压缩摘要]
 *
 *   触发条件（KIMI，不是固定 round%3）：
 *     网页端自带上下文是免费的，不要轻易重置。
 *     只在两种情况下触发「重置」：
 *       A. 累计注入量超阈值（默认 6000 字符）→ 压缩成摘要再注入
 *       B. 某 AI 连续 2 轮"跑偏"（被判定跑偏）→ 单点重置（只重置它，不重置其它 8 个）
 *
 * 与 ADR-001 第 7 条「MeetingModel 是唯一事实源，网页端上下文只是缓存」
 * 的关系：本模块决定的是【注入多少、什么时候注入】，不决定【记忆存哪里】。
 * 记忆永远存 MeetingModel。
 */

/**
 * 角色分化前缀（盲点 A 的解法：同一份输入 + 不同角色 = 真多视角，不是 9 个复读机）。
 *
 * ★ 为什么放在这里而不是放在 orchestrator：
 *   角色是「每轮给谁看什么」的一部分，和"最近 N 轮"一样属于注入策略，
 *   必须与注入内容在同一层组装，否则两个 AI 会拿到同样的"角色 + 正文"，分化就失效了。
 */
const DEFAULT_ROLES = {
  'default': '请就本轮问题给出你的完整回答。',
  // 9 个 AI 开会时，可按需给不同 provider 配不同角色。
  // 示例（会议主题：产品需求评审）：
  'deepseek-web': '你是【红队】。只找方案里的漏洞、边界与风险，不要总结，不要客气。',
  'chatgpt-web':  '你是【成本分析师】。只算钱：人力、token、存储、时间。',
  'kimi-web':     '你是【合规审查】。只谈数据/法务/隐私风险。',
  'doubao-web':   '你是【最挑剔的用户】。从使用者角度挑毛病，用大白话。',
  'tongyi-web':   '你是【架构师】。只谈可扩展性、可维护性与演进。',
  'yuanbao-web':  '你是【产品经理】。只谈优先级与取舍，不写代码。',
  'gemini-web':   '你是【数据分析师】。只要能用数字说话的结论。',
  'wenxin-web':   '你是【新人】。假设你刚加入团队，提出最朴素的问题。',
  // 'google-search': '你是【事实核查员】。先搜后答，给出可验证的来源。',
};

/**
 * 组装"喂给某个网页 AI 的完整 prompt"。
 *
 * @param {object} ctx
 * @param {string} ctx.task            本轮任务文本（用户问题 / 会议纪要摘要）
 * @param {string} ctx.role            该 AI 的角色前缀（来自 DEFAULT_ROLES 或调用方）
 * @param {Array<{sender:string, text:string}>} ctx.recentRounds  最近 N 轮原文（默认 N=2，由调用方切片）
 * @param {string} ctx.summary         更早历史的压缩摘要（可空）
 * @param {string} ctx.providerId      该 AI 的 id
 * @returns {string}
 */
function composePrompt({
  task = '',
  role = null,
  recentRounds = [],
  summary = '',
  providerId = 'default',
} = {}) {
  const prefix = role || DEFAULT_ROLES[providerId] || DEFAULT_ROLES.default;
  const parts = [prefix];

  if (summary) {
    parts.push(`【早前讨论摘要】\n${summary}`);
  }
  for (const r of recentRounds) {
    if (r && r.text) {
      parts.push(`【${r.sender || '系统'} 说】\n${r.text}`);
    }
  }
  parts.push(`【本轮任务】\n${task}`);

  return parts.filter(Boolean).join('\n\n');
}

/**
 * 滚动注入器：决定"现在该注入多少上下文"。
 *
 * 对应 KIMI 触发条件：
 *   - 累计注入超 threshold → 压缩（调用方提供 compressor）
 *   - 某 AI 连续 N 轮跑偏 → 单点重置（把它的 recentRounds/summary 清空）
 */
class ContextStrategy {
  /**
   * @param {object} opts
   *   - recentRounds          保留最近几轮原文（默认 2）
   *   - injectThresholdChars 累计注入字符超此值就触发压缩（默认 6000）
   *   - compressor            (recentRounds, oldSummary) => Promise<string>
   *                           把"最近几轮 + 旧摘要"压成更短的新摘要
   *   - now                   时钟注入
   */
  constructor({
    recentRounds = 2,
    injectThresholdChars = 6000,
    compressor = null,
    now = () => Date.now(),
  } = {}) {
    this.recentRounds = recentRounds;
    this.injectThresholdChars = injectThresholdChars;
    this.compressor = compressor;
    this._now = now;

    /** 每个 provider 独立的注入预算（避免 9 个 AI 共用一个预算互相挤） */
    this.budgets = new Map(); // providerId -> { summary, injected: number, deviations: number }
  }

  /** 为某 AI 初始化一条预算（幂等） */
  ensure(providerId) {
    if (!this.budgets.has(providerId)) {
      this.budgets.set(providerId, { summary: '', injected: 0, deviations: 0, lastReset: 0 });
    }
    return this.budgets.get(providerId);
  }

  /**
   * 取某 AI 本轮要注入的上下文。
   *
   * ★ 跨轮积累机制（这是"滚动压缩"的核心）：
   *   每次调用，若未压缩，则把"本轮切片 + 旧摘要"追加进 b.summary。
   *   这样多轮下来 b.summary 会单调增长 → 终于触发阈值 A → 压缩 → 收缩。
   *   这是 KIMI「滚动压缩」裁决的直接实现，不是每轮重新算，而是跨轮累积。
   *
   * @returns {Promise<{summary:string, recentRounds:Array, injectedNow:number}>}
   */
  async getInjection(providerId, { rounds = [], markDeviated = false } = {}) {
    const b = this.ensure(providerId);

    // ---- 触发条件 B：连续 2 轮跑偏 → 单点重置（清掉旧摘要，重新开始）----
    if (markDeviated) b.deviations += 1;
    else b.deviations = 0;
    if (b.deviations >= 2) {
      b.summary = '';
      b.injected = 0;
      b.lastReset = this._now();
      b.deviations = 0;
      return { summary: '', recentRounds: [], injectedNow: 0, reset: true };
    }

    // ---- 未压缩路径：把本轮切片累进摘要（跨轮增长）----
    const slice = rounds.slice(-this.recentRounds);
    const sliceChars = slice.reduce((n, r) => n + (r.text ? r.text.length : 0), 0);
    if (!b.summary) b.summary = '';
    if (sliceChars > 0) b.summary = (b.summary + '\n' + slice.map((r) => `[${r.sender || '系统'}] ${r.text}`).join('\n')).trim();

    const runningTotal = b.summary.length;

    // ---- 触发条件 A：累计注入超阈值 → 压缩 ----
    if (runningTotal > this.injectThresholdChars && this.compressor) {
      const newSummary = await this.compressor(slice, b.summary);
      b.summary = newSummary || '';
      b.injected += b.summary.length;
      return { summary: b.summary, recentRounds: slice, injectedNow: sliceChars, compressed: true };
    }

    b.injected += runningTotal;
    return { summary: b.summary, recentRounds: slice, injectedNow: runningTotal };
  }

  /** 散会：清空某 AI 的预算（对应"新开会"） */
  reset(providerId) {
    this.ensure(providerId).summary = '';
    this.ensure(providerId).injected = 0;
    this.ensure(providerId).deviations = 0;
  }

  toJSON() {
    return {
      recentRounds: this.recentRounds,
      injectThresholdChars: this.injectThresholdChars,
      budgets: [...this.budgets.entries()].map(([pid, v]) => ({ providerId: pid, ...v })),
    };
  }
}

module.exports = { DEFAULT_ROLES, composePrompt, ContextStrategy };
