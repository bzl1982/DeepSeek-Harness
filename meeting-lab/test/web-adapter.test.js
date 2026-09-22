'use strict';
/**
 * test/web-adapter.test.js —— Adapter 层的两个修复回归测试
 *
 * 这两个都是 v1 真实存在的误判来源，必须锁死：
 *   #1 domStable 起手即真 → "空回复"被当成答完（抓空气）
 *   #2 streamEnd 永久闩锁 → 第二轮瞬间误判完成
 *
 * 用可控假 driver（不碰 Electron / 不碰真实网页）。
 */

const test = require('node:test');
const assert = require('node:assert');
const { createWebAdapter } = require('../adapters/web-adapter');
const { CompletionDetector, SIGNALS, RESULT } = require('../core/completion');

const PROFILE = {
  assistant: ['[class*="answer"]'], composer: ['textarea'], send: ['button[class*="send"]'],
  stop: ['button[class*="stop"]'], generating: ['[class*="loading"]'], attachment: ['[class*="file-card"]'],
};

/** 可控假 driver：probe 返回的内容由外部函数决定 */
function makeDriver({ probeFn, hasNetwork = false }) {
  const netCbs = [];
  return {
    probeFn,
    sends: [],
    async evaluate() {
      const p = this.probeFn();
      return { ok: true, url: 'https://chat.deepseek.com/', ...p };
    },
    async sendText(t) { this.sends.push(t); return true; },
    async setFiles() { return true; },
    async isReady() { return true; },
    async cancel() { return true; },
    attachNetwork(cb) {
      if (!hasNetwork) return null;
      netCbs.push(cb);
      return () => { const i = netCbs.indexOf(cb); if (i >= 0) netCbs.splice(i, 1); };
    },
    /* 测试用：手动喂 CDP 事件 */
    emitNetwork(method, params) { for (const cb of netCbs) cb(method, params); },
  };
}

/** 一个"看起来空闲但其实什么都没回答"的页面状态 */
const IDLE_EMPTY = { text: '', msgCount: 0, attachCount: 0, signals: { stopGone: true, sendReady: true, genFlagGone: true } };

/* ---------------- #1 空回复不得被判完成 ---------------- */

test('★ 修复回归：DOM 全部空闲但回答为空 → 绝不能判 COMPLETED', async () => {
  const driver = makeDriver({ probeFn: () => IDLE_EMPTY });
  const adapter = createWebAdapter({ id: 'fake', profile: PROFILE, driver, pollMs: 20 });
  const detector = new CompletionDetector({ minSignals: 2, stableMs: 0, timeoutMs: 600 });
  detector.start();

  const resp = await adapter.waitForResponse({ detector, timeoutMs: 600 });

  assert.strictEqual(resp.text, '');
  assert.notStrictEqual(resp.completion.result, RESULT.COMPLETED,
    '页面空闲但没有任何回答，判完成就会"抓到空气"');
  assert.strictEqual(resp.completion.result, RESULT.TIMEOUT, '应超时收敛，而不是假装完成');
});

test('有真实回答 + 页面空闲 → 正常判 COMPLETED（别把修复改过头）', async () => {
  let n = 0;
  const driver = makeDriver({
    probeFn: () => {
      n += 1;
      return {
        text: n > 1 ? '这是回答内容' : '',
        msgCount: 1, attachCount: 0,
        signals: { stopGone: true, sendReady: true, genFlagGone: true },
      };
    },
  });
  const adapter = createWebAdapter({ id: 'fake', profile: PROFILE, driver, pollMs: 20 });
  const detector = new CompletionDetector({ minSignals: 2, stableMs: 0, timeoutMs: 3000 });
  detector.start();

  const resp = await adapter.waitForResponse({ detector, timeoutMs: 3000 });
  assert.strictEqual(resp.completion.result, RESULT.COMPLETED, '有回答且空闲就该判定完成');
  assert.match(resp.text, /回答内容/);
});

test('requireContent:false 时退回旧行为（允许空回复完成，供特殊站点使用）', async () => {
  const driver = makeDriver({ probeFn: () => IDLE_EMPTY });
  const adapter = createWebAdapter({ id: 'fake', profile: PROFILE, driver, pollMs: 20, requireContent: false });
  const detector = new CompletionDetector({ minSignals: 2, stableMs: 0, timeoutMs: 1000 });
  detector.start();

  const resp = await adapter.waitForResponse({ detector, timeoutMs: 1000 });
  assert.strictEqual(resp.completion.result, RESULT.COMPLETED, '显式关闭内容要求时应允许');
});

/* ---------------- #2 streamEnd 不得跨轮闩锁 ---------------- */

test('★★ 修复回归：streamEnd 不得跨轮闩锁（第一轮结束不能污染第二轮）', async () => {
  let turn = 1;
  let phase = 'empty';
  const pendingBaseline = { v: false };
  const driver = makeDriver({
    hasNetwork: true,
    probeFn: () => {
      // ★ 2026-09-22 第四轮：adapter 现在会在 sendText 之后抓一次「基线快照」。
      //   真实场景下那一刻 AI 还没回复，所以这里必须返回空——否则基线就等于回答，
      //   后续比对会得出"无新增"，这个测试就测不到它原本要锁的 streamEnd 行为。
      if (pendingBaseline.v) {
        pendingBaseline.v = false;
        return { text: '', msgCount: 0, attachCount: 0, signals: { stopGone: true, sendReady: true, genFlagGone: true } };
      }
      if (turn === 1) {
        // 第一轮：有回答，页面空闲
        return { text: '第一轮回答', msgCount: 1, attachCount: 0, signals: { stopGone: true, sendReady: true, genFlagGone: true } };
      }
      // 第二轮：故意一直空白且"看起来空闲"——若 streamEnd 闩锁残留，会被瞬间误判完成
      return phase === 'empty'
        ? { text: '', msgCount: 2, attachCount: 0, signals: { stopGone: true, sendReady: true, genFlagGone: true } }
        : { text: '第二轮回答', msgCount: 2, attachCount: 0, signals: { stopGone: true, sendReady: true, genFlagGone: true } };
    },
  });
  // sendText 包一层：发送后第一次 probe 视为「基线抓取」
  const _origSend = driver.sendText.bind(driver);
  driver.sendText = async (t) => { pendingBaseline.v = true; return _origSend(t); };

  const adapter = createWebAdapter({ id: 'fake', profile: PROFILE, driver, pollMs: 20 });

  // ---- 第一轮 ----
  const url = 'https://chat.deepseek.com/api/v0/chat/completion';
  const d1 = new CompletionDetector({ minSignals: 2, stableMs: 0, timeoutMs: 2000 });
  d1.start();
  await adapter.sendText('第一轮');
  const r1 = await adapter.waitForResponse({ detector: d1, timeoutMs: 2000 });
  assert.strictEqual(r1.completion.result, RESULT.COMPLETED);

  // ---- 第二轮 ----
  turn = 2;
  const d2 = new CompletionDetector({ minSignals: 2, stableMs: 0, timeoutMs: 400 });
  d2.start();
  await adapter.sendText('第二轮'); // ★ 这里必须 arm 清零

  // 第二轮若被污染，会在第一个轮询周期就立刻 COMPLETED
  const r2 = await adapter.waitForResponse({ detector: d2, timeoutMs: 400 });
  assert.notStrictEqual(r2.completion.result, RESULT.COMPLETED,
    '第二轮没有任何回答，却被判完成 → 说明 streamEnd 闩锁污染了新一轮');
  assert.strictEqual(r2.completion.result, RESULT.TIMEOUT);
});

test('★ 真接了 CDP：网络静默后 streamEnd 必须为真（不再永远为假）', async () => {
  const driver = makeDriver({
    hasNetwork: true,
    probeFn: () => ({ text: '回答', msgCount: 1, attachCount: 0, signals: { stopGone: true, sendReady: true, genFlagGone: true } }),
  });
  const adapter = createWebAdapter({
    id: 'fake', profile: PROFILE, driver, pollMs: 20,
    streamTrackerOpts: { idleMs: 30, armGraceMs: 0 },
  });

  await adapter.sendText('hi');
  const url = 'https://chat.deepseek.com/api/v0/chat/completion';
  driver.emitNetwork('Network.requestWillBeSent', { requestId: 'r', request: { url } });
  driver.emitNetwork('Network.responseReceived', { requestId: 'r', type: 'Fetch', response: { url, mimeType: 'text/event-stream' } });
  driver.emitNetwork('Network.loadingFinished', { requestId: 'r' });

  await new Promise((r) => setTimeout(r, 120)); // 让它静默过 idleMs

  const st = adapter.streamStatus();
  assert.strictEqual(st.streamEnd, true, 'CDP 接上了就必须能给出 streamEnd=true');
  assert.strictEqual(st.seenStream, true);
  assert.match(st.lastUrl, /deepseek/);
});

test('dispose() 卸掉 CDP 监听且不抛错（9 个 webview 长会防泄漏）', () => {
  const driver = makeDriver({ hasNetwork: true, probeFn: () => IDLE_EMPTY });
  const adapter = createWebAdapter({ id: 'fake', profile: PROFILE, driver, pollMs: 20 });
  assert.doesNotThrow(() => adapter.dispose());
  assert.doesNotThrow(() => adapter.dispose(), '重复 dispose 也必须安全');
  assert.strictEqual(adapter.streamStatus().state, 'idle');
});

test('driver 不支持 attachNetwork 时优雅降级（退回纯 DOM 信号，不炸）', async () => {
  const driver = makeDriver({ hasNetwork: false, probeFn: () => ({
    text: '回答', msgCount: 1, attachCount: 0, signals: { stopGone: true, sendReady: true, genFlagGone: true },
  }) });
  const adapter = createWebAdapter({ id: 'fake', profile: PROFILE, driver, pollMs: 20 });
  const d = new CompletionDetector({ minSignals: 2, stableMs: 0, timeoutMs: 1000 });
  d.start();
  const r = await adapter.waitForResponse({ detector: d, timeoutMs: 1000 });
  assert.strictEqual(r.completion.result, RESULT.COMPLETED, '没有 CDP 也要能靠 DOM 信号完成');
  assert.strictEqual(r.stream.streamEnd, false, '没有 CDP 时 streamEnd 保持 false，不谎报');
});

/* ---------------- 信号覆盖度自检 ---------------- */

test('信号 D 已从"永远为假"变为真实可用（5 信号全部可达）', () => {
  const driver = makeDriver({ hasNetwork: true, probeFn: () => IDLE_EMPTY });
  const adapter = createWebAdapter({ id: 'fake', profile: PROFILE, driver, pollMs: 20 });
  const before = adapter.streamStatus();
  assert.strictEqual(before.state, 'idle', '未发言前处于 idle');
  assert.ok(Object.prototype.hasOwnProperty.call(before, 'streamEnd'));
  assert.strictEqual(SIGNALS.STREAM_END, 'streamEnd');
});
