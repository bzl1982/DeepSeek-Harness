'use strict';
/**
 * core/completion.js —— 完成检测器（多信号联合）
 *
 * 【为什么必须有这个】
 *   网页版 AI 的回答是流式渲染的，"什么时候算答完"是整个系统稳定性的命门。
 *   六份外部咨询里讲得最浅的恰恰是这一点：
 *     - 固定 sleep(5秒)        → 长回答必然截断
 *     - 消息节点数增加          → 生成中就会出现节点，抓半截
 *     - 文本连续 3 次相同       → 流式段间短暂稳定，照样误判
 *
 * 【本实现的判定】
 *   5 个信号（由 Adapter 在页面侧采集后喂进来）：
 *     A stopGone      Stop generating 按钮消失
 *     B sendReady     Send 按钮恢复可用
 *     C domStable     assistant 节点内容连续 N ms 无变化
 *     D streamEnd     流式网络请求结束（CDP Network 域）
 *     E genFlagGone   页面"生成中"标志位消失
 *
 *   满足 >= minSignals 个信号 → COMPLETED
 *   超时 → TIMEOUT（不阻塞整场会议，交由编排层标记"闭麦"）
 *
 * 纯逻辑 + 可注入时钟，因此无需浏览器即可单测。
 */

const SIGNALS = Object.freeze({
  STOP_GONE: 'stopGone',
  SEND_READY: 'sendReady',
  DOM_STABLE: 'domStable',
  STREAM_END: 'streamEnd',
  GEN_FLAG_GONE: 'genFlagGone',
});

const ALL_SIGNALS = Object.values(SIGNALS);

const RESULT = Object.freeze({
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  TIMEOUT: 'TIMEOUT',
});

class CompletionDetector {
  /**
   * @param {object} opts
   *   - minSignals   需要满足几个信号才算完成（默认 2）
   *   - stableMs     DOM 需要连续静止多久才算稳定（默认 1200ms）
   *   - timeoutMs    总超时（默认 120000ms）
   *   - now          时钟注入（测试用）
   */
  constructor({ minSignals = 2, stableMs = 1200, timeoutMs = 120000, now = () => Date.now() } = {}) {
    this.minSignals = Math.min(Math.max(minSignals, 1), ALL_SIGNALS.length);
    this.stableMs = stableMs;
    this.timeoutMs = timeoutMs;
    this._now = now;

    this.startedAt = null;
    this.signals = new Map(); // name -> { value, ts }
    this.lastContentChangeAt = null;
    this.result = RESULT.PENDING;
    this.reason = '';
  }

  start() {
    this.startedAt = this._now();
    this.lastContentChangeAt = this.startedAt;
    this.signals.clear();
    this.result = RESULT.PENDING;
    this.reason = '';
    return this;
  }

  /**
   * 喂入一个信号。
   * @param {string} name   SIGNALS.*
   * @param {boolean} value 该信号当前是否满足
   */
  feed(name, value) {
    if (!ALL_SIGNALS.includes(name)) {
      throw new Error(`CompletionDetector.feed: unknown signal "${name}"`);
    }
    const prev = this.signals.get(name);
    // 只在状态变化时更新 ts，避免"持续为真"被误当成"刚刚变化"
    if (!prev || prev.value !== !!value) {
      this.signals.set(name, { value: !!value, ts: this._now() });
    }
    return this;
  }

  /** 批量喂入：{ stopGone: true, sendReady: false, ... } */
  feedAll(obj = {}) {
    for (const [k, v] of Object.entries(obj)) {
      if (ALL_SIGNALS.includes(k)) this.feed(k, v);
    }
    return this;
  }

  /** 回答内容发生了变化（由页面 MutationObserver 调用）——重置 DOM 稳定计时 */
  touchContent() {
    this.lastContentChangeAt = this._now();
    return this;
  }

  /** 已满足的信号数 */
  satisfiedCount() {
    let n = 0;
    for (const s of ALL_SIGNALS) {
      const v = this.signals.get(s);
      if (v && v.value) n += 1;
    }
    return n;
  }

  /** 当前满足的信号名列表（用于诊断"为什么还没判定完成"） */
  satisfiedSignals() {
    return ALL_SIGNALS.filter((s) => {
      const v = this.signals.get(s);
      return !!(v && v.value);
    });
  }

  /** 是否已超时 */
  isTimedOut() {
    if (this.startedAt == null) return false;
    return this._now() - this.startedAt >= this.timeoutMs;
  }

  /**
   * 评估当前状态。
   * @returns {{result:string, reason:string, signals:string[], elapsedMs:number}}
   */
  evaluate() {
    if (this.result !== RESULT.PENDING) {
      return this.snapshot();
    }
    if (this.startedAt == null) {
      this.reason = 'not started';
      return this.snapshot();
    }

    // 超时优先判定
    if (this.isTimedOut()) {
      this.result = RESULT.TIMEOUT;
      this.reason = `timeout after ${this.timeoutMs}ms`;
      return this.snapshot();
    }

    const satisfied = this.satisfiedSignals();

    // domStable 是"派生信号"：需要真正静止够久，而不是此刻为真
    const effective = satisfied.filter((s) => {
      if (s !== SIGNALS.DOM_STABLE) return true;
      const quietFor = this._now() - (this.lastContentChangeAt || this.startedAt);
      return quietFor >= this.stableMs;
    });

    if (effective.length >= this.minSignals) {
      this.result = RESULT.COMPLETED;
      this.reason = `signals: ${effective.join(', ')}`;
    }
    return this.snapshot();
  }

  /** 便捷：是否已完成 */
  isCompleted() {
    return this.evaluate().result === RESULT.COMPLETED;
  }

  /** 是否已终结（完成或超时） */
  isSettled() {
    const r = this.evaluate().result;
    return r === RESULT.COMPLETED || r === RESULT.TIMEOUT;
  }

  snapshot() {
    return {
      result: this.result,
      reason: this.reason,
      signals: this.satisfiedSignals(),
      elapsedMs: this.startedAt == null ? 0 : this._now() - this.startedAt,
    };
  }
}

module.exports = { SIGNALS, ALL_SIGNALS, RESULT, CompletionDetector };
