'use strict';
/**
 * core/attachment-bus.js —— 附件总线（"先上传齐、再统一发送"的门闩）
 *
 * 【这是本次要验证的头号问题】
 *   现状（错的）：
 *     用户拖文件 → 9 个 webview 各自处理 → upload → sleep(3000ms) → 发送
 *                                                    ↑ 靠猜，没有确认
 *   症状：9 个 AI 偶尔有人收不到文件 / 收到半截 / 顺序错乱
 *
 *   改成（对的）：
 *     会议层统一接管 drop
 *       → 登记 attachmentId（一个文件一个 id，9 个 AI 共用）
 *       → fan-out uploadFiles() 到 N 个 Adapter
 *       → ★ 每个 AI 必须回报 ACK（DOM 出现附件卡片 / 上传 100%）
 *       → 【门闩】等到全部 ACK 到齐（或超时降级），才统一放行 sendText()
 *
 * 纯逻辑 + 可注入时钟，无需浏览器即可单测。
 */

const ACK = Object.freeze({
  OK: 'OK',
  FAILED: 'FAILED',
  TIMEOUT: 'TIMEOUT',
  NOT_EXPECTED: 'NOT_EXPECTED',
});

/** 上传失败的分类（对应 meeting-model 的异常态） */
const UPLOAD_ERROR = Object.freeze({
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  LOGIN_EXPIRED: 'LOGIN_EXPIRED',
  DOM_CHANGED: 'DOM_CHANGED',
  TOO_LARGE: 'TOO_LARGE',
  UNSUPPORTED: 'UNSUPPORTED',
});

class AttachmentBus {
  /**
   * @param {object} opts
   *   - now           时钟注入（测试用）
   *   - defaultTimeoutMs 单个 AI 上传 ACK 的等待上限
   *   - maxRetries    单点重试次数
   */
  constructor({ now = () => Date.now(), defaultTimeoutMs = 45000, maxRetries = 2 } = {}) {
    this._now = now;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxRetries = maxRetries;

    /** attachmentId -> ref */
    this.attachments = new Map();
    /** `${providerId}::${attachmentId}` -> { status, ts, error, attempts } */
    this.acks = new Map();
    /** 本批次期望参与的 provider */
    this.expected = new Set();
    this.openedAt = null;
  }

  _key(providerId, attachmentId) {
    return `${providerId}::${attachmentId}`;
  }

  /** 登记一个附件（幂等） */
  register(ref) {
    if (!ref || !ref.attachmentId) throw new Error('AttachmentBus.register: ref.attachmentId required');
    if (!this.attachments.has(ref.attachmentId)) {
      this.attachments.set(ref.attachmentId, { ...ref, registeredAt: this._now() });
    }
    return this.attachments.get(ref.attachmentId);
  }

  listAttachments() {
    return [...this.attachments.values()];
  }

  /**
   * 开启一次"上传批"。门闩由此开始计时。
   * @param {string[]} providerIds 本次要投递的 AI
   */
  openBatch(providerIds = []) {
    this.expected = new Set(providerIds);
    this.openedAt = this._now();
    for (const pid of providerIds) {
      for (const att of this.attachments.values()) {
        this.acks.set(this._key(pid, att.attachmentId), {
          status: null,
          ts: null,
          error: null,
          attempts: 0,
        });
      }
    }
    return { expected: [...this.expected], attachments: this.listAttachments().length };
  }

  /**
   * Adapter 上传完成后回报。
   * @param {string} providerId
   * @param {string} attachmentId
   * @param {boolean} ok
   * @param {object} meta  { error }
   */
  ack(providerId, attachmentId, ok, meta = {}) {
    if (!this.expected.has(providerId)) {
      return { accepted: false, status: ACK.NOT_EXPECTED };
    }
    const key = this._key(providerId, attachmentId);
    const cur = this.acks.get(key);
    if (!cur) return { accepted: false, status: ACK.NOT_EXPECTED };
    if (cur.attempts > this.maxRetries) {
      return { accepted: false, status: ACK.FAILED, reason: 'max retries exceeded' };
    }
    cur.attempts += 1;
    cur.ts = this._now();
    cur.status = ok ? ACK.OK : ACK.FAILED;
    cur.error = ok ? null : (meta.error || UPLOAD_ERROR.UPLOAD_FAILED);
    return { accepted: true, status: cur.status };
  }

  /**
   * 门闩：全部 ACK 到齐了吗？
   * 未 ACK 且已超时的，标记 TIMEOUT 并计入 missing。
   * @returns {{ready:boolean, missing:Array, timedOut:Array, okCount:number, total:number}}
   */
  evaluate() {
    const missing = [];
    const timedOut = [];
    let okCount = 0;
    let total = 0;

    for (const pid of this.expected) {
      for (const att of this.attachments.values()) {
        total += 1;
        const key = this._key(pid, att.attachmentId);
        const cur = this.acks.get(key) || { status: null, ts: null };
        if (cur.status === ACK.OK) {
          okCount += 1;
        } else if (cur.status === ACK.FAILED) {
          missing.push({ providerId: pid, attachmentId: att.attachmentId, error: cur.error });
        } else if (cur.status === null) {
          const waited = this.openedAt == null ? 0 : this._now() - this.openedAt;
          if (waited >= this.defaultTimeoutMs) {
            cur.status = ACK.TIMEOUT;
            cur.ts = this._now();
            timedOut.push({ providerId: pid, attachmentId: att.attachmentId });
          } else {
            missing.push({ providerId: pid, attachmentId: att.attachmentId, error: 'PENDING' });
          }
        }
      }
    }

    // ready = 没有任何"未决"（PENDING/FAILED/TIMEOUT）项
    const pending = missing.filter((m) => m.error === 'PENDING');
    return {
      ready: pending.length === 0 && missing.length === 0 && timedOut.length === 0 && total > 0,
      missing,
      timedOut,
      pending,
      okCount,
      total,
    };
  }

  /** 全部 ACK 到齐才为 true */
  isReady() {
    return this.evaluate().ready;
  }

  /**
   * 拿到"可放行"判定：
   *   - all-ok       全部成功 → 正常发送
   *   - degraded     部分失败/超时 → 降级：这些 AI 改为"文本摘要"投递（不阻塞整场会议）
   * @param {object} opts { allowDegrade: boolean }
   */
  gate({ allowDegrade = true } = {}) {
    const st = this.evaluate();
    if (st.ready) return { action: 'PROCEED', ...st };
    const stillPending = st.pending.length > 0;
    if (stillPending) return { action: 'WAIT', ...st };
    if (allowDegrade) {
      const degraded = [...new Set([...st.missing, ...st.timedOut].map((m) => m.providerId))];
      return { action: 'DEGRADE', degraded, ...st };
    }
    return { action: 'ABORT', ...st };
  }

  /** 查询单个 (provider, attachment) 的 ACK 状态 */
  statusOf(providerId, attachmentId) {
    const cur = this.acks.get(this._key(providerId, attachmentId));
    if (!cur) return null;
    return { ...cur };
  }

  /** 汇总每个 provider 的上传情况（给 UI 显示） */
  providerSummary() {
    const out = {};
    for (const pid of this.expected) {
      let ok = 0;
      let fail = 0;
      for (const att of this.attachments.values()) {
        const cur = this.acks.get(this._key(pid, att.attachmentId));
        if (!cur) continue;
        if (cur.status === ACK.OK) ok += 1;
        else if (cur.status === ACK.FAILED || cur.status === ACK.TIMEOUT) fail += 1;
      }
      out[pid] = { ok, fail, total: this.attachments.size };
    }
    return out;
  }

  toJSON() {
    return {
      attachments: this.listAttachments(),
      expected: [...this.expected],
      acks: [...this.acks.entries()].map(([k, v]) => ({ key: k, ...v })),
      openedAt: this.openedAt,
    };
  }
}

module.exports = { ACK, UPLOAD_ERROR, AttachmentBus };
