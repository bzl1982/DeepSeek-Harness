'use strict';
/**
 * core/summarizer.js —— 会议纪要压缩器（盲点 C 的落地）
 *
 * 第二轮共识：「每轮结束产出轮纪要（≤300 字/轮）+ 每 5 轮做一次全局压缩」。
 *
 * 为什么必须做成「纯逻辑、可单测、可注入压缩器」：
 *   - 压缩本身调 API（共识 #6：纪要压缩走真实 API，不走网页版）
 *   - 但「何时压缩、压缩谁、预算怎么算」是确定性逻辑，必须不依赖网络就能测
 *   - 因此这里只写「决定」，把「执行」通过 compressor 注入（同 ContextStrategy 的分工）
 */

/** 轮纪要长度上限（字符，按中文字符粗估） */
const PER_ROUND_SUMMARY_LIMIT = 300;

/** 全局压缩触发间隔：每 N 轮做一次全局压缩 */
const GLOBAL_COMPRESS_EVERY = 5;

/**
 * 创建一个"纪要账本"：跨轮记录每轮的压缩摘要，供全局压缩取用。
 *
 * @param {object} opts
 *   - roundCompressor   (messages[]) => Promise<string>  把一轮的 9 条回答压成 ≤300 字轮纪要
 *   - globalCompressor  (roundSummaries[]) => Promise<string>  把多轮纪要压成一份全局摘要
 *   - now               时钟注入
 */
class SummaryLedger {
  constructor({ roundCompressor = null, globalCompressor = null, now = () => Date.now() } = {}) {
    this.roundCompressor = roundCompressor;
    this.globalCompressor = globalCompressor;
    this._now = now;

    /** round -> { summary, source: 'compressed' | 'raw' } */
    this.rounds = new Map();
    this.lastGlobalAt = 0;
  }

  /**
   * 一轮结束后调用。
   * @param {number} round
   * @param {Array<{senderId:string, content:string}>} messages  本轮 9 个 AI 的回答
   * @returns {Promise<string>}  本轮纪要（压缩成功给压缩版，否则给"截断"兜底）
   */
  async sealRound(round, messages = []) {
    let summary = '';
    if (this.roundCompressor) {
      try {
        summary = await this.roundCompressor(messages);
      } catch (e) {
        summary = '';
      }
    }
    if (!summary) {
      // 兜底：没有压缩器 / 压缩失败 → 截断原文，保证"轮纪要 ≤300 字"的约束不被破坏
      const raw = messages.map((m) => `[${m.senderId}] ${m.content || ''}`).join('\n');
      summary = raw.length > PER_ROUND_SUMMARY_LIMIT
        ? raw.slice(0, PER_ROUND_SUMMARY_LIMIT - 1) + '…'
        : raw;
    }
    this.rounds.set(round, { summary, source: this.roundCompressor ? 'compressed' : 'raw', ts: this._now() });
    return summary;
  }

  /**
   * 全局压缩：当距上次全局压缩已满 N 轮，把 N 份轮纪要压成一份全局摘要。
   * 返回 { shouldCompress, globalSummary }
   */
  async maybeGlobalCompress(currentRound) {
    if (!this.globalCompressor) return { shouldCompress: false, globalSummary: '' };
    if (currentRound - this.lastGlobalAt < GLOBAL_COMPRESS_EVERY) {
      return { shouldCompress: false, globalSummary: '' };
    }
    const since = [...this.rounds.entries()]
      .filter(([r]) => r > this.lastGlobalAt && r <= currentRound)
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v.summary);
    if (!since.length) return { shouldCompress: false, globalSummary: '' };

    let global = '';
    try {
      global = await this.globalCompressor(since);
    } catch (e) {
      global = '';
    }
    this.lastGlobalAt = currentRound;
    return { shouldCompress: true, globalSummary: global };
  }

  /** 当前所有轮纪要（给 UI / 存档） */
  listRounds() {
    return [...this.rounds.entries()].sort((a, b) => a[0] - b[0]).map(([r, v]) => ({ round: r, ...v }));
  }

  toJSON() {
    return {
      rounds: this.listRounds(),
      lastGlobalAt: this.lastGlobalAt,
    };
  }
}

/** 默认兜底压缩器：不调 API，纯文本截断（离线 / 测试用） */
function defaultRoundCompressor(messages) {
  const raw = messages.map((m) => `[${m.senderId}] ${m.content || ''}`).join('\n');
  return raw.length > PER_ROUND_SUMMARY_LIMIT
    ? raw.slice(0, PER_ROUND_SUMMARY_LIMIT - 1) + '…'
    : raw;
}

module.exports = {
  SummaryLedger,
  defaultRoundCompressor,
  PER_ROUND_SUMMARY_LIMIT,
  GLOBAL_COMPRESS_EVERY,
};
