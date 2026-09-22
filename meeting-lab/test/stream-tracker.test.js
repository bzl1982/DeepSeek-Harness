'use strict';
/**
 * test/stream-tracker.test.js —— streamEnd 信号（CDP Network 域）
 *
 * 验证目标：把「文档承诺但一直没接」的信号 D 真正立起来，
 * 并确保它【跨轮不清零】这个经典 bug 不会复发。
 *
 * 全部用注入时钟，不碰真实网络 / 不碰 Electron。
 */

const test = require('node:test');
const assert = require('node:assert');
const { StreamTracker } = require('../core/stream-tracker');

function makeClock(start = 10000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; } };
}

/** 造一个 StreamTracker，默认 idleMs=900 / armGraceMs=350 */
function makeTracker(opts = {}) {
  const clock = makeClock();
  const tr = new StreamTracker({ now: clock.now, idleMs: 900, armGraceMs: 350, ...opts });
  return { tr, clock };
}

/** 一段典型的流式回答：请求 → 响应头 → 多次吐字 → 结束 */
function playNormalStream(tr, clock, { requestId = 'r1', url = 'https://chat.deepseek.com/api/v0/chat/completion' } = {}) {
  tr.handleEvent('Network.requestWillBeSent', { requestId, request: { url } });
  tr.handleEvent('Network.responseReceived', {
    requestId, type: 'Fetch', response: { url, mimeType: 'text/event-stream' },
  });
  clock.advance(200);
  tr.handleEvent('Network.dataReceived', { requestId, dataLength: 120 });
  clock.advance(300);
  tr.handleEvent('Network.dataReceived', { requestId, dataLength: 800 });
  clock.advance(250);
  tr.handleEvent('Network.loadingFinished', { requestId, encodedDataLength: 4000 });
  return { requestId, url };
}

/* ---------------- 1. 未武装时完全忽略 ---------------- */

test('未 arm() 前，网络事件一律忽略（不能污染上一轮）', () => {
  const { tr } = makeTracker();
  playNormalStream(tr, { advance: () => {} });
  const st = tr.status();
  assert.strictEqual(st.state, 'idle');
  assert.strictEqual(st.streamEnd, false);
  assert.strictEqual(st.events, 0, '未武装不该记任何事件');
});

/* ---------------- 2. 宽限期：不早判 ---------------- */

test('★ arm 后宽限期内绝不判 ended（给页面时间发起请求）', () => {
  const { tr, clock } = makeTracker();
  tr.arm();
  clock.advance(100); // < armGraceMs 350
  const st = tr.status();
  assert.strictEqual(st.state, 'streaming', '宽限期内应视为"可能还在开始"');
  assert.strictEqual(st.streamEnd, false, '绝不可以在宽限期内判结束');
});

test('宽限期过后仍无流 → idle（非流式页面，交给 DOM 信号兜底）', () => {
  const { tr, clock } = makeTracker();
  tr.arm();
  clock.advance(400); // > 350
  const st = tr.status();
  assert.strictEqual(st.state, 'idle');
  assert.strictEqual(st.streamEnd, false);
});

/* ---------------- 3. 正常流：结束且静默够久才 ended ---------------- */

test('★ 流结束 + 静默够久 → ended（streamEnd = true）', () => {
  const { tr, clock } = makeTracker();
  tr.arm();
  playNormalStream(tr, clock);

  // 刚 loadingFinished，静默不足
  assert.strictEqual(tr.status().streamEnd, false, '刚结束不该立刻判 ended');

  clock.advance(899);
  assert.strictEqual(tr.status().streamEnd, false, '静默 899ms < 900ms 仍不该判');

  clock.advance(1); // 累计 900
  const st = tr.status();
  assert.strictEqual(st.streamEnd, true, '静默满 900ms 必须判 ended');
  assert.strictEqual(st.state, 'ended');
  assert.strictEqual(st.sawData, true, '应记录到真的在吐字');
});

/* ---------------- 4. 流还在飞：绝不判完成 ---------------- */

test('★ 流还在飞时绝不判 ended（这是长回答不被腰斩的关键）', () => {
  const { tr, clock } = makeTracker();
  tr.arm();
  const { requestId, url } = playNormalStream(tr, clock);

  // 又开了一条流，还没结束
  tr.handleEvent('Network.requestWillBeSent', { requestId: 'r2', request: { url } });
  tr.handleEvent('Network.responseReceived', {
    requestId: 'r2', type: 'Fetch', response: { url, mimeType: 'text/event-stream' },
  });

  clock.advance(5000); // 静默很久，但 r2 仍在飞
  const st = tr.status();
  assert.strictEqual(st.streamEnd, false, '有流在飞就绝不能判结束');
  assert.strictEqual(st.inflight, 1);
});

test('多条流并行：全部结束才可能 ended', () => {
  const { tr, clock } = makeTracker();
  tr.arm();
  const url = 'https://chat.deepseek.com/api/v0/chat/completion';
  for (const id of ['a', 'b']) {
    tr.handleEvent('Network.requestWillBeSent', { requestId: id, request: { url } });
    tr.handleEvent('Network.responseReceived', {
      requestId: id, type: 'Fetch', response: { url, mimeType: 'text/event-stream' },
    });
  }
  tr.handleEvent('Network.loadingFinished', { requestId: 'a' });
  clock.advance(900);
  assert.strictEqual(tr.status().streamEnd, false, 'b 还没结束');

  tr.handleEvent('Network.loadingFinished', { requestId: 'b' });
  clock.advance(900);
  assert.strictEqual(tr.status().streamEnd, true, '都结束了才算完');
});

/* ---------------- 5. dataReceived 刷新静默计时 ---------------- */

test('dataReceived 会刷新静默计时（还在吐字就不能算结束）', () => {
  const { tr, clock } = makeTracker();
  const url = 'https://chat.deepseek.com/api/v0/chat/completion';
  tr.arm();

  // r1：先发先结束
  tr.handleEvent('Network.requestWillBeSent', { requestId: 'r1', request: { url } });
  tr.handleEvent('Network.responseReceived', {
    requestId: 'r1', type: 'Fetch', response: { url, mimeType: 'text/event-stream' },
  });

  clock.advance(100);
  // r3：后发的长流
  tr.handleEvent('Network.requestWillBeSent', { requestId: 'r3', request: { url } });
  tr.handleEvent('Network.responseReceived', {
    requestId: 'r3', type: 'Fetch', response: { url, mimeType: 'text/event-stream' },
  });
  tr.handleEvent('Network.loadingFinished', { requestId: 'r1' }); // r1 完成

  clock.advance(100); // t=200
  tr.handleEvent('Network.dataReceived', { requestId: 'r3', dataLength: 50 }); // 还在吐字
  tr.handleEvent('Network.loadingFinished', { requestId: 'r3' }); // 流本身结束

  clock.advance(800); // t=1000，距最后吐字 800ms < 900ms
  assert.strictEqual(tr.status().streamEnd, false, '刚吐过字，静默不足，不该判结束');

  clock.advance(100); // t=1100，距最后吐字 900ms → 达标
  assert.strictEqual(tr.status().streamEnd, true, '静默满 900ms 后才算结束');
  assert.strictEqual(tr.status().inflight, 0);
});

/* ---------------- 6. ended 具有稳定性（不反复横跳） ---------------- */

test('★ 一旦 ended 就保持稳定，不被后续杂音请求翻回 streaming', () => {
  const { tr, clock } = makeTracker();
  tr.arm();
  playNormalStream(tr, clock);
  clock.advance(900);
  assert.strictEqual(tr.status().streamEnd, true);

  // 结束后页面又发了个埋点请求
  tr.handleEvent('Network.requestWillBeSent', { requestId: 'beacon', request: { url: 'https://chat.deepseek.com/api/v0/chat/completion' } });
  tr.handleEvent('Network.responseReceived', {
    requestId: 'beacon', type: 'Fetch', response: { url: 'https://chat.deepseek.com/api/v0/chat/completion', mimeType: 'text/event-stream' },
  });
  const st = tr.status();
  assert.strictEqual(st.streamEnd, true, '已判定结束应稳定，否则完成检测会抖动');
  assert.strictEqual(st.state, 'ended');
});

/* ---------------- 7. 跨轮清零（v1 的 bug 回归测试） ---------------- */

test('★★ 回归：重新 arm() 必须清零上一轮的 ended（v1 永久闩锁 bug）', () => {
  const { tr, clock } = makeTracker();
  tr.arm();
  playNormalStream(tr, clock);
  clock.advance(900);
  assert.strictEqual(tr.status().streamEnd, true, '第一轮应结束');

  // 第二轮开始
  tr.arm();
  assert.strictEqual(tr.status().streamEnd, false, '★ 新一轮绝不能沿用上一轮的 streamEnd');
  assert.strictEqual(tr.status().seenStream, false);

  clock.advance(5000); // 第二轮还没发起任何请求
  assert.strictEqual(tr.status().streamEnd, false, '第二轮没流就不该判结束');
});

/* ---------------- 8. 只挑相关请求，杂音不算 ---------------- */

test('不相关的请求（图片/静态资源）不计入流', () => {
  const { tr, clock } = makeTracker();
  tr.arm();
  tr.handleEvent('Network.requestWillBeSent', { requestId: 'img', request: { url: 'https://chat.deepseek.com/logo.png' } });
  tr.handleEvent('Network.responseReceived', {
    requestId: 'img', type: 'Image', response: { url: 'https://chat.deepseek.com/logo.png', mimeType: 'image/png' },
  });
  clock.advance(2000);
  const st = tr.status();
  assert.strictEqual(st.seenStream, false, '图片不该被当成回答流');
  assert.strictEqual(st.streamEnd, false);
});

test('matchAll=true 时不筛 URL（最保守兜底，任何流都算）', () => {
  const { tr, clock } = makeTracker({ matchAll: true });
  tr.arm();
  tr.handleEvent('Network.requestWillBeSent', { requestId: 'x', request: { url: 'https://example.com/whatever' } });
  tr.handleEvent('Network.responseReceived', {
    requestId: 'x', type: 'Fetch', response: { url: 'https://example.com/whatever', mimeType: 'text/event-stream' },
  });
  tr.handleEvent('Network.loadingFinished', { requestId: 'x' });
  clock.advance(900);
  assert.strictEqual(tr.status().streamEnd, true);
});

test('自定义 urlMatch 函数可用（各站点可热修）', () => {
  const { tr, clock } = makeTracker({ urlMatch: (u) => u.includes('/my-endpoint') });
  tr.arm();
  tr.handleEvent('Network.requestWillBeSent', { requestId: 'x', request: { url: 'https://a.com/my-endpoint' } });
  tr.handleEvent('Network.responseReceived', {
    requestId: 'x', type: 'Fetch', response: { url: 'https://a.com/my-endpoint', mimeType: 'text/event-stream' },
  });
  tr.handleEvent('Network.loadingFinished', { requestId: 'x' });
  clock.advance(900);
  assert.strictEqual(tr.status().streamEnd, true);
});

/* ---------------- 9. loadingFailed 也收敛 ---------------- */

test('loadingFailed 同样收敛为结束（网络断了也不能把会议卡死）', () => {
  const { tr, clock } = makeTracker();
  tr.arm();
  const url = 'https://chat.deepseek.com/api/v0/chat/completion';
  tr.handleEvent('Network.requestWillBeSent', { requestId: 'r', request: { url } });
  tr.handleEvent('Network.responseReceived', {
    requestId: 'r', type: 'Fetch', response: { url, mimeType: 'text/event-stream' },
  });
  tr.handleEvent('Network.loadingFailed', { requestId: 'r', errorText: 'net::ERR_CONNECTION_RESET' });
  clock.advance(900);
  assert.strictEqual(tr.status().streamEnd, true, '失败也必须收敛，否则门闩会一直等');
  assert.strictEqual(tr.status().inflight, 0);
});

/* ---------------- 10. Electron 直接转发 ---------------- */

test('handleCdpMessage 可直接挂 Electron debugger 的 message 事件', () => {
  const { tr, clock } = makeTracker();
  tr.arm();
  // Electron 签名：(event, method, params)
  tr.handleCdpMessage({}, 'Network.requestWillBeSent', {
    requestId: 'r', request: { url: 'https://chat.deepseek.com/api/v0/chat/completion' },
  });
  tr.handleCdpMessage({}, 'Network.responseReceived', {
    requestId: 'r', type: 'Fetch',
    response: { url: 'https://chat.deepseek.com/api/v0/chat/completion', mimeType: 'text/event-stream' },
  });
  tr.handleCdpMessage({}, 'Network.loadingFinished', { requestId: 'r' });
  clock.advance(900);
  assert.strictEqual(tr.status().streamEnd, true);
});

/* ---------------- 11. 诊断信息完备 ---------------- */

test('status() 带足够诊断信息（回答"为什么还没判定完成"）', () => {
  const { tr, clock } = makeTracker();
  tr.arm();
  playNormalStream(tr, clock, { url: 'https://chat.deepseek.com/api/v0/chat/completion' });
  const st = tr.status();
  assert.ok(st.reason, '必须有 reason');
  assert.strictEqual(typeof st.inflight, 'number');
  assert.strictEqual(typeof st.events, 'number');
  assert.match(st.lastUrl, /deepseek/, '应记录最近匹配到的 URL 便于排查选择器/URL 变更');
});
