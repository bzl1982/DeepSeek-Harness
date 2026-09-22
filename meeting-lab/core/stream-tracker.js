'use strict';
/**
 * core/stream-tracker.js —— streamEnd 信号的真实来源（CDP Network 域）
 *
 * 【为什么必须有它】
 *   原先 completion.js 的 5 个信号里，4 个来自 DOM 探针轮询，
 *   而 streamEnd 是唯一「不依赖 DOM」的信号 —— 也恰恰是
 *   网页改版、Shadow DOM、iframe 穿透失败时最后的救命稻草。
 *
 *   但 v1 只把 driver.onStreamEnd 挂了一个布尔闩锁（web-adapter.js:101），
 *   而且 README 自认「未接入」。于是：
 *     - 信号 D 永远为假（白占一个信号位）
 *     - 真接上后又会永久为真（跨轮不清零，第二轮的回复会被瞬间判定完成）
 *   两个错都得在 Phase 0 修掉。
 *
 * 【判定模型】不猜「哪个请求是回答」，而是看「网络有没有在流」
 *   一次 CDP 会话里可能同时有埋点、心跳、历史拉取等杂音请求，
 *   靠 URL 匹配去挑「哪个才是回答流」既脆又难维护。
 *   改用：活跃流计数 + 静默期。
 *
 *     send() 发射 → arm() 开始观察
 *       ↓ requestWillBeSent          记录，pending+1
 *       ↓ responseReceived(MIME 像流) active+1, pending-1，记住 responseId
 *       ↓ loadingFinished / loadingFailed   active-1
 *       ↓ dataReceived               刷新 lastDataAt（“还在吐字”）
 *       ↓
 *     判定：曾经见过流 && active==0 && pending==0 && 已静默 idleMs
 *           → state = 'ended'
 *
 *   ★ 与「DOM 稳定」的关键差别：
 *     DOM 静默可能只是「还没开始渲染」，网络静默才代表「真的没在传了」。
 *     所以这里的 ended 是强信号，可以直接当作完成判据之一。
 *
 * 纯逻辑 + 注入时钟，无需浏览器 / 无需 Electron 即可单测。
 */

/** 一次流式响应结束后，网络需要安静多久才算「真结束」 */
const DEFAULT_IDLE_MS = 900;

/** 从 send 到第一字节之间允许的宽限期：不在此期间内判 ended */
const DEFAULT_ARM_GRACE_MS = 350;

/**
 * 哪些响应算「可能是 AI 回答流」。
 * 注意这是「放宽」而非「收紧」：宁可多算，不可漏算 ——
 * 漏掉一个流会让 ended 提前为真，多算只会让 ended 稍晚，后者安全。
 */
const DEFAULT_STREAM_URL_RE =
  /(chat|conversation|completion|message|generate|stream|assistant|answer|reply|qianwen|doubao|yuanbao|bard|gemini|kimi|moonshot|deepseek|openai|wenxin|yiyan)/i;

/** SSE / 流式响应常见的 MIME */
const STREAM_MIME_RE = /(event-stream|stream|json|text\/plain)/i;

class StreamTracker {
  /**
   * @param {object} opts
   *   - now            时钟注入（测试用）
   *   - idleMs         流结束后需静默多久（默认 900ms）
   *   - armGraceMs     起手宽限期，期内绝不判 ended（默认 350ms）
   *   - urlMatch       自定义 URL 匹配（RegExp 或 (url)=>boolean）
   *   - matchAll       true = 不筛 URL，任何响应都算（最保守）
   */
  constructor({
    now = () => Date.now(),
    idleMs = DEFAULT_IDLE_MS,
    armGraceMs = DEFAULT_ARM_GRACE_MS,
    urlMatch = DEFAULT_STREAM_URL_RE,
    matchAll = false,
  } = {}) {
    this._now = now;
    this.idleMs = idleMs;
    this.armGraceMs = armGraceMs;
    this._urlMatch = urlMatch;
    this.matchAll = matchAll;

    /** requestId -> { url, phase } */
    this.requests = new Map();
    this.reset();
  }

  /** 清楚所有计数，回到未武装状态 */
  reset() {
    this.requests.clear();
    this.armedAt = null;
    this.pending = 0; // 已发出、还没拿到响应头
    this.active = 0; // 响应头已到、还没结束
    this.seenStream = false; // 本次武装期间是否真见过流
    this.sawData = false; // 是否收到过 dataReceived（真在吐字）
    this.lastDataAt = null; // 最近一次吐字时间
    this.endedAt = null; // 判定结束的时刻
    this.lastUrl = null; // 最近一条匹配到的 URL（诊断用）
    this.events = 0; // 收到过的事件数（诊断用）
    return this;
  }

  /**
   * 武装：一次 send() 之后调用，开始为「这一轮」观察网络。
   * ★ 每次发言都必须 arm()，否则上一轮的 ended 会污染这一轮。
   */
  arm() {
    this.reset();
    this.armedAt = this._now();
    return this;
  }

  /** URL 是否像 AI 回答流 */
  _matches(url) {
    if (this.matchAll) return true;
    if (!url) return false;
    if (typeof this._urlMatch === 'function') return !!this._urlMatch(url);
    if (this._urlMatch instanceof RegExp) return this._urlMatch.test(url);
    return true;
  }

  /**
   * 喂入一个 CDP Network 事件。
   * 事件名与 CDP 一致，方便 Electron 侧直接转发。
   *
   * @param {string} method Network.requestWillBeSent | Network.responseReceived
   *                        | Network.dataReceived | Network.loadingFinished
   *                        | Network.loadingFailed
   * @param {object} params CDP 原始 params（不裁剪，保持零适配成本）
   */
  handleEvent(method, params = {}) {
    if (this.armedAt == null) return this; // 没武装就完全忽略
    this.events += 1;

    switch (method) {
      case 'Network.requestWillBeSent': {
        const { requestId, request } = params;
        if (requestId) this.requests.set(requestId, { url: (request && request.url) || '', phase: 'pending' });
        break;
      }

      case 'Network.responseReceived': {
        const { requestId, response, type } = params;
        const url = (response && response.url) || '';
        const mime = (response && response.mimeType) || '';
        const rec = this.requests.get(requestId);

        // type 为 XHR/Fetch 才可能是流；EventSource 也走 Fetch
        const typeOk = !type || type === 'XHR' || type === 'Fetch' || type === 'EventSource';
        const looksStream = this._matches(url) && (STREAM_MIME_RE.test(mime) || !mime);

        if (typeOk && looksStream) {
          // 先记下「之前」的相位，再改 —— 否则会重复计数
          const wasPending = !!rec && rec.phase === 'pending';
          if (rec) rec.phase = 'active';
          else this.requests.set(requestId, { url, phase: 'active' });
          this.active += 1;
          if (wasPending && this.pending > 0) this.pending -= 1;
          this.seenStream = true;
          this.lastUrl = url;
        } else if (rec && rec.phase === 'pending') {
          rec.phase = 'ignored';
          if (this.pending > 0) this.pending -= 1;
        }
        break;
      }

      case 'Network.dataReceived': {
        const { requestId } = params;
        const rec = this.requests.get(requestId);
        if (rec && rec.phase === 'active') {
          this.sawData = true;
          this.lastDataAt = this._now();
        }
        break;
      }

      case 'Network.loadingFinished':
      case 'Network.loadingFailed': {
        const { requestId } = params;
        const rec = this.requests.get(requestId);
        if (rec && rec.phase === 'active') {
          rec.phase = 'done';
          if (this.active > 0) this.active -= 1;
          this.lastDataAt = this._now(); // 结束本身也算一次活动
        } else if (rec && rec.phase === 'pending') {
          rec.phase = 'done';
          if (this.pending > 0) this.pending -= 1;
        }
        break;
      }

      default:
        break;
    }
    return this;
  }

  /** 便捷：Electron webContents debugger 的 'message' 事件直接丢进来 */
  handleCdpMessage(_event, method, params) {
    return this.handleEvent(method, params);
  }

  /** 当前活跃流数（含未拿到响应头的） */
  inflight() {
    return this.pending + this.active;
  }

  /**
   * 状态判定。
   * @returns {{state:'idle'|'streaming'|'ended', streamEnd:boolean, ...}}
   *   - idle       没见过流，且已过宽限期（可能还没开始，或压根不是流式接口）
   *   - streaming  有流在飞 / 刚吐过字、静默不够久
   *   - ended      ★ 见过流 + 全部结束 + 静默够久 → streamEnd:true
   */
  status() {
    if (this.armedAt == null) {
      return this._snap('idle', false, 'not armed');
    }

    const now = this._now();
    const sinceArm = now - this.armedAt;
    const lastAct = this.lastDataAt == null ? this.armedAt : this.lastDataAt;
    const quietFor = now - lastAct;

    // 已经判定过结束 —— 保持稳定，不因后续杂音反复横跳
    if (this.endedAt != null) {
      return this._snap('ended', true, `ended after ${this.endedAt - this.armedAt}ms`);
    }

    // 还在飞 → 明确没完
    if (this.inflight() > 0) {
      return this._snap('streaming', false, `inflight=${this.inflight()}`);
    }

    // 见过流且全部收尾，但要静默够久
    if (this.seenStream && quietFor >= this.idleMs) {
      this.endedAt = now;
      return this._snap('ended', true, `quiet ${quietFor}ms, sawData=${this.sawData}`);
    }

    // 见过流但还在静默期
    if (this.seenStream) {
      return this._snap('streaming', false, `quiet ${quietFor}ms < idleMs ${this.idleMs}`);
    }

    // 没见过流：宽限期内算 streaming（给页面时间发起请求），过了算 idle
    if (sinceArm < this.armGraceMs) {
      return this._snap('streaming', false, `grace ${sinceArm}ms`);
    }
    return this._snap('idle', false, `no stream after ${sinceArm}ms (non-streaming page?)`);
  }

  /** 当前 streamEnd 信号值（喂给 CompletionDetector.feed） */
  isStreamEnd() {
    return this.status().streamEnd;
  }

  _snap(state, streamEnd, reason) {
    return {
      state,
      streamEnd,
      pending: this.pending,
      active: this.active,
      inflight: this.inflight(),
      seenStream: this.seenStream,
      sawData: this.sawData,
      lastUrl: this.lastUrl,
      events: this.events,
      reason,
    };
  }
}

module.exports = {
  StreamTracker,
  DEFAULT_IDLE_MS,
  DEFAULT_ARM_GRACE_MS,
  DEFAULT_STREAM_URL_RE,
  STREAM_MIME_RE,
};
