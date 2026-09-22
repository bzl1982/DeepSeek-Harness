'use strict';
/**
 * test/attachment-bus.test.js —— 附件总线（"先上传齐、再统一发送"的门闩）
 *
 * 验证目标（Phase 0 不确定性 #2）：
 *   "能不能保证 9 个 AI 都收到文件"
 *   关键：有任何一个没 ACK 就绝不放行；全到齐才放行；超时可优雅降级
 */

const test = require('node:test');
const assert = require('node:assert');
const { AttachmentBus, ACK } = require('../core/attachment-bus');

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; } };
}

const mk = (id) => ({ attachmentId: id, name: `${id}.pdf`, size: 1024, mime: 'application/pdf' });

test('全部 ACK 到齐才放行（核心门闩语义）', () => {
  const clock = makeClock();
  const bus = new AttachmentBus({ now: clock.now, defaultTimeoutMs: 10000 });
  bus.register(mk('att_1'));
  bus.openBatch(['a', 'b', 'c']);

  bus.ack('a', 'att_1', true);
  assert.strictEqual(bus.gate().action, 'WAIT', '只到 1/3 必须继续等');

  bus.ack('b', 'att_1', true);
  assert.strictEqual(bus.gate().action, 'WAIT', '2/3 仍要等');

  bus.ack('c', 'att_1', true);
  const gate = bus.gate();
  assert.strictEqual(gate.action, 'PROCEED', '3/3 到齐必须放行');
  assert.strictEqual(gate.okCount, 3);
  assert.strictEqual(gate.total, 3);
});

test('有人没 ACK 时，即便其他都成功也绝不放行（这就是"9 个人收不全"的根因防护）', () => {
  const clock = makeClock();
  const bus = new AttachmentBus({ now: clock.now, defaultTimeoutMs: 10000 });
  bus.register(mk('att_1'));
  bus.openBatch(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);

  // 8 个成功，1 个没回
  for (const p of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) bus.ack(p, 'att_1', true);

  const gate = bus.gate();
  assert.strictEqual(gate.action, 'WAIT');
  assert.strictEqual(gate.okCount, 8);
  assert.strictEqual(gate.pending.length, 1);
  assert.strictEqual(gate.pending[0].providerId, 'i');
});

test('上传失败 → 降级（标记该 AI，其余照常放行）', () => {
  const clock = makeClock();
  const bus = new AttachmentBus({ now: clock.now, defaultTimeoutMs: 10000 });
  bus.register(mk('att_1'));
  bus.openBatch(['a', 'b']);

  bus.ack('a', 'att_1', true);
  bus.ack('b', 'att_1', false, { error: 'UPLOAD_FAILED' });

  const gate = bus.gate({ allowDegrade: true });
  assert.strictEqual(gate.action, 'DEGRADE');
  assert.deepStrictEqual(gate.degraded, ['b']);
});

test('禁止降级时必须 ABORT（保守模式）', () => {
  const clock = makeClock();
  const bus = new AttachmentBus({ now: clock.now, defaultTimeoutMs: 10000 });
  bus.register(mk('att_1'));
  bus.openBatch(['a']);

  bus.ack('a', 'att_1', false, { error: 'UPLOAD_FAILED' });
  assert.strictEqual(bus.gate({ allowDegrade: false }).action, 'ABORT');
});

test('超时未 ACK → 标记 TIMEOUT 并降级放行，不锁死会议', () => {
  const clock = makeClock();
  const bus = new AttachmentBus({ now: clock.now, defaultTimeoutMs: 5000 });
  bus.register(mk('att_1'));
  bus.openBatch(['a', 'b']);

  bus.ack('a', 'att_1', true);
  assert.strictEqual(bus.gate().action, 'WAIT');

  clock.advance(5000);
  const gate = bus.gate({ allowDegrade: true });
  assert.strictEqual(gate.action, 'DEGRADE');
  assert.strictEqual(gate.timedOut.length, 1);
  assert.strictEqual(gate.timedOut[0].providerId, 'b');
});

test('多附件：任一附件在任一 AI 上未 ACK 都不放行', () => {
  const clock = makeClock();
  const bus = new AttachmentBus({ now: clock.now, defaultTimeoutMs: 10000 });
  bus.register(mk('att_1'));
  bus.register(mk('att_2'));
  bus.openBatch(['a', 'b']);

  bus.ack('a', 'att_1', true);
  bus.ack('a', 'att_2', true);
  bus.ack('b', 'att_1', true);
  // b 的 att_2 还没回
  assert.strictEqual(bus.gate().action, 'WAIT');

  bus.ack('b', 'att_2', true);
  assert.strictEqual(bus.gate().action, 'PROCEED');
});

test('未参与的 provider 回报 ACK 会被拒绝（防止串台）', () => {
  const clock = makeClock();
  const bus = new AttachmentBus({ now: clock.now });
  bus.register(mk('att_1'));
  bus.openBatch(['a']);

  const r = bus.ack('z', 'att_1', true);
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.status, ACK.NOT_EXPECTED);
});

test('register 幂等：同一 attachmentId 只登记一次（9 个 AI 共用一份引用）', () => {
  const bus = new AttachmentBus();
  const a1 = bus.register(mk('att_1'));
  const a2 = bus.register(mk('att_1'));
  assert.strictEqual(a1, a2);
  assert.strictEqual(bus.listAttachments().length, 1);
});

test('重试计数：超过 maxRetries 后拒绝再 ACK', () => {
  const clock = makeClock();
  const bus = new AttachmentBus({ now: clock.now, maxRetries: 1 });
  bus.register(mk('att_1'));
  bus.openBatch(['a']);

  assert.strictEqual(bus.ack('a', 'att_1', false).accepted, true); // attempts=1
  assert.strictEqual(bus.ack('a', 'att_1', false).accepted, true); // attempts=2
  const r = bus.ack('a', 'att_1', false); // attempts=3 > maxRetries(1)+1
  assert.strictEqual(r.accepted, false);
});

test('providerSummary 能给 UI 提供每家的上传进度', () => {
  const clock = makeClock();
  const bus = new AttachmentBus({ now: clock.now });
  bus.register(mk('att_1'));
  bus.register(mk('att_2'));
  bus.openBatch(['a', 'b']);

  bus.ack('a', 'att_1', true);
  bus.ack('a', 'att_2', true);
  bus.ack('b', 'att_1', true);
  bus.ack('b', 'att_2', false, { error: 'DOM_CHANGED' });

  const s = bus.providerSummary();
  assert.deepStrictEqual(s.a, { ok: 2, fail: 0, total: 2 });
  assert.deepStrictEqual(s.b, { ok: 1, fail: 1, total: 2 });
});
