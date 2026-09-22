'use strict';
/**
 * test/helpers/fake-adapter.js —— 可控的假 Adapter
 *
 * 让 Phase 0 的三个不确定性【无需浏览器、无需真 AI】就能被反复验证：
 *   - 可注入延迟、失败点、信号序列
 *   - 因此"完成检测"和"失败隔离"可以被穷举测试
 *
 * 注意：所有可变配置都挂在 this 上，测试中可随时改（如 adapters.b.failAt = null）
 *       不能用解构出来的常量，否则外部改动不生效。
 */

const { SIGNALS, RESULT } = require('../../core/completion');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFakeAdapter(opts = {}) {
  const id = opts.id || 'fake';

  return {
    id,
    name: opts.name || `Fake(${id})`,

    /* ---- 可变配置（测试可改） ---- */
    failAt: opts.failAt || null, // null | 'upload' | 'send' | 'wait'
    failError: opts.failError || 'boom',
    hangUntilTimeout: !!opts.hangUntilTimeout,
    signalPlan: opts.signalPlan || null,
    uploadOk: opts.uploadOk !== false,
    skipAck: !!opts.skipAck, // 上传后不回报 ACK（用于测门闩超时）
    replyText: opts.replyText != null ? opts.replyText : null,
    delayMs: opts.delayMs != null ? opts.delayMs : 8,
    uploadAckDelay: opts.uploadAckDelay || 0,

    /* ---- 观测数据 ---- */
    calls: { isReady: 0, uploadFiles: 0, sendText: 0, waitForResponse: 0, cancel: 0 },
    uploaded: [],
    sent: [],

    async isReady() {
      this.calls.isReady += 1;
      return true;
    },

    async uploadFiles(attachments, { onAck } = {}) {
      this.calls.uploadFiles += 1;
      this.uploaded.push(...attachments.map((a) => a.attachmentId));
      if (this.uploadAckDelay) await sleep(this.uploadAckDelay);

      if (this.failAt === 'upload') {
        for (const a of attachments) {
          if (onAck && !this.skipAck) onAck(a.attachmentId, false, { error: 'UPLOAD_FAILED' });
        }
        return { ok: false, failed: attachments.map((a) => a.attachmentId), error: 'upload failed' };
      }

      if (!this.skipAck) {
        for (const a of attachments) {
          if (onAck) onAck(a.attachmentId, this.uploadOk, { error: this.uploadOk ? null : 'UPLOAD_FAILED' });
        }
      }
      return { ok: this.uploadOk, failed: [], error: null };
    },

    async sendText(text) {
      this.calls.sendText += 1;
      this.sent.push(text);
      await sleep(this.delayMs);
      if (this.failAt === 'send') throw new Error(this.failError);
      return true;
    },

    async waitForResponse({ detector, timeoutMs } = {}) {
      this.calls.waitForResponse += 1;
      if (this.failAt === 'wait') throw new Error(this.failError);

      const plan =
        this.signalPlan || [
          { signal: SIGNALS.STREAM_END, value: true, atMs: Math.floor(this.delayMs / 2) },
          { signal: SIGNALS.STOP_GONE, value: true, atMs: this.delayMs },
        ];

      let elapsed = 0;
      for (const step of plan) {
        const wait = Math.max(0, (step.atMs || 0) - elapsed);
        if (wait) await sleep(wait);
        elapsed = step.atMs || elapsed;
        if (step.touchContent) detector.touchContent();
        if (step.signal) detector.feed(step.signal, step.value);
        detector.evaluate();
      }

      // 模拟"永远不满足完成条件" → 用于测超时收敛
      if (this.hangUntilTimeout) {
        const deadline = Date.now() + (timeoutMs || 200) + 50;
        while (Date.now() < deadline) {
          await sleep(10);
          detector.evaluate();
        }
      }
      detector.evaluate();

      return {
        text: this.replyText != null ? this.replyText : `[${id}] 回复内容`,
        completion: detector.snapshot(),
      };
    },

    async cancel() {
      this.calls.cancel += 1;
      return true;
    },
  };
}

module.exports = { makeFakeAdapter, sleep, SIGNALS, RESULT };
