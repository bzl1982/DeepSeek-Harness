'use strict';
/**
 * test/completion.test.js —— 完成检测器
 *
 * 验证目标（Phase 0 不确定性 #1）：
 *   "能不能可靠判断网页 AI 答完了"
 *   关键：不误判（信号不足时不能判完成）、不漏判（信号够时必须立刻判完成）、超时可收敛
 */

const test = require('node:test');
const assert = require('node:assert');
const { CompletionDetector, SIGNALS, RESULT } = require('../core/completion');

/** 可控时钟 */
function makeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; } };
}

test('信号不足时绝不判定完成（防误判）', () => {
  const clock = makeClock();
  const d = new CompletionDetector({ minSignals: 2, now: clock.now });
  d.start();

  d.feed(SIGNALS.STREAM_END, true); // 只有 1 个信号
  clock.advance(5000);
  assert.strictEqual(d.evaluate().result, RESULT.PENDING, '仅 1 个信号不应判定完成');
  assert.strictEqual(d.satisfiedCount(), 1);
});

test('达到阈值信号数即判定完成（防漏判）', () => {
  const clock = makeClock();
  const d = new CompletionDetector({ minSignals: 2, now: clock.now });
  d.start();

  d.feed(SIGNALS.STREAM_END, true);
  assert.strictEqual(d.evaluate().result, RESULT.PENDING);
  d.feed(SIGNALS.STOP_GONE, true); // 第 2 个 → 完成
  assert.strictEqual(d.evaluate().result, RESULT.COMPLETED);
});

test('domStable 是"派生信号"：必须真正静止够久才算（这是最容易踩的坑）', () => {
  const clock = makeClock();
  const d = new CompletionDetector({ minSignals: 2, stableMs: 1200, now: clock.now });
  d.start();

  d.feed(SIGNALS.STOP_GONE, true);
  d.feed(SIGNALS.DOM_STABLE, true); // 此刻为真，但刚 touch 过内容

  clock.advance(500);
  d.touchContent(); // 内容又变了 → DOM 并不稳定
  clock.advance(600); // 累计静止 600ms < 1200ms
  assert.strictEqual(d.evaluate().result, RESULT.PENDING, 'DOM 未静止够久，不应判定完成');

  clock.advance(700); // 累计静止 1300ms >= 1200ms
  assert.strictEqual(d.evaluate().result, RESULT.COMPLETED, 'DOM 稳定够久后应判定完成');
});

test('流式输出中途"短暂稳定"不会误判（对照"连续3次相同"的土办法）', () => {
  const clock = makeClock();
  const d = new CompletionDetector({ minSignals: 2, stableMs: 1200, now: clock.now });
  d.start();

  d.feed(SIGNALS.GEN_FLAG_GONE, true);
  d.feed(SIGNALS.DOM_STABLE, true);

  // 流式：每隔 800ms 又来一段内容（永远不到 1200ms 静默）
  for (let i = 0; i < 5; i += 1) {
    clock.advance(800);
    d.touchContent();
    assert.strictEqual(d.evaluate().result, RESULT.PENDING, `第 ${i + 1} 段流式内容到达时不应判定完成`);
  }

  // 流结束，真正静止
  clock.advance(1300);
  assert.strictEqual(d.evaluate().result, RESULT.COMPLETED);
});

test('超时收敛为 TIMEOUT（保证会议能继续，不锁死）', () => {
  const clock = makeClock();
  const d = new CompletionDetector({ minSignals: 2, timeoutMs: 10000, now: clock.now });
  d.start();

  d.feed(SIGNALS.STREAM_END, true); // 永远只有 1 个信号
  clock.advance(9999);
  assert.strictEqual(d.evaluate().result, RESULT.PENDING);
  clock.advance(1);
  const snap = d.evaluate();
  assert.strictEqual(snap.result, RESULT.TIMEOUT);
  assert.match(snap.reason, /timeout/i);
});

test('一旦判定终结就不再变化（幂等）', () => {
  const clock = makeClock();
  const d = new CompletionDetector({ minSignals: 2, now: clock.now });
  d.start();
  d.feed(SIGNALS.STREAM_END, true);
  d.feed(SIGNALS.STOP_GONE, true);
  assert.strictEqual(d.evaluate().result, RESULT.COMPLETED);

  d.feed(SIGNALS.DOM_STABLE, false); // 后续信号不得翻案
  clock.advance(999999);
  assert.strictEqual(d.evaluate().result, RESULT.COMPLETED);
});

test('single-signal 模式（minSignals=1）也能工作', () => {
  const clock = makeClock();
  const d = new CompletionDetector({ minSignals: 1, now: clock.now });
  d.start();
  d.feed(SIGNALS.STOP_GONE, true);
  assert.strictEqual(d.evaluate().result, RESULT.COMPLETED);
});

test('未知信号名必须报错（防止拼写错误被静默吞掉）', () => {
  const d = new CompletionDetector();
  d.start();
  assert.throws(() => d.feed('stopGona', true), /unknown signal/);
});

test('快照能说明"为什么还没完成"（诊断价值）', () => {
  const clock = makeClock();
  const d = new CompletionDetector({ minSignals: 3, now: clock.now });
  d.start();
  d.feed(SIGNALS.STREAM_END, true);
  d.feed(SIGNALS.SEND_READY, true);
  const snap = d.evaluate();
  assert.strictEqual(snap.result, RESULT.PENDING);
  assert.deepStrictEqual(snap.signals.sort(), [SIGNALS.SEND_READY, SIGNALS.STREAM_END].sort());
  assert.ok(snap.elapsedMs >= 0);
});
