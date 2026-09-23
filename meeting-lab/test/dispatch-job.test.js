'use strict';
/**
 * test/dispatch-job.test.js —— 分发任务契约（规范 V1 §4：C1/C2/C3）
 *
 * 三条契约的验收线：
 *   C1  不可变快照：篡改稿子必须被拦下（分发前 + 恢复时都校验 hash）
 *   C2  逐席幂等：重试名单只有 failed；已 delivered 席位在任何路径下都不重发
 *   C3  持久化：serialize→deserialize 往返后状态保真，恢复后不重发已 delivered
 */

const test = require('node:test');
const assert = require('node:assert');
const D = require('../core/dispatch-job');

const SEATS = ['web1', 'web2', 'web3'];

function makeJob() {
  const snapshot = D.createSnapshot({ text: '请评审方案A', attachments: [{ name: 'a.pdf', localPath: 'D:/a.pdf' }] });
  return D.createDispatchJob({ snapshot, seats: SEATS, jobId: 'job_test' });
}

/* ─────────── C1 不可变快照 ─────────── */

test('C1: 空稿不允许 READY', () => {
  assert.throws(() => D.createSnapshot({ text: '   ' }), /非空咨询稿/);
  assert.throws(() => D.createSnapshot({}), /非空咨询稿/);
});

test('C1: 快照深度冻结，事后改不进去', () => {
  const snap = D.createSnapshot({ text: '稿子v1' });
  assert.throws(() => { 'use strict'; snap.text = '稿子v2'; }, TypeError);
  assert.throws(() => { 'use strict'; snap.contentHash = 'fake'; }, TypeError);
});

test('C1: 稿子被篡改 → assertSnapshotIntegrity 抛错', () => {
  const job = makeJob();
  // 模拟有人绕过 API 直接改了 snapshot.text（比如序列化后手改 JSON）
  const evil = { ...job.snapshot, text: '被换掉的稿子' };
  assert.throws(() => D.assertSnapshotIntegrity(evil), /完整性校验失败/);
  // 正常快照校验通过
  assert.strictEqual(D.assertSnapshotIntegrity(job.snapshot), true);
});

test('C1: 改稿必须换新快照，新快照 hash 不同', () => {
  const s1 = D.createSnapshot({ text: '稿子v1' });
  const s2 = D.createSnapshot({ text: '稿子v2' });
  assert.notStrictEqual(s1.contentHash, s2.contentHash);
});

/* ─────────── C2 逐席幂等 ─────────── */

test('C2: 基本流转 pending→sending→sent，attempt 只在 sending 时 +1', () => {
  const job = makeJob();
  assert.strictEqual(job.seats.get('web1').attempt, 0);
  const r1 = D.markSending(job, 'web1');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(job.seats.get('web1').attempt, 1);
  assert.strictEqual(job.seats.get('web1').status, D.SEAT_STATUS.SENDING);
  D.markSent(job, 'web1', { transport: D.TRANSPORT.L1 });
  const s = job.seats.get('web1');
  assert.strictEqual(s.delivered, true);
  assert.strictEqual(s.status, D.SEAT_STATUS.SENT);
  assert.strictEqual(s.transport, D.TRANSPORT.L1);
});

test('C2: 已 delivered 席位拒绝再发（markSending/markSent 双向幂等）', () => {
  const job = makeJob();
  D.markSending(job, 'web1');
  D.markSent(job, 'web1');
  // 再想发：拒绝且 attempt 不变
  const r = D.markSending(job, 'web1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'already_delivered');
  assert.strictEqual(job.seats.get('web1').attempt, 1, 'delivered 后 attempt 不许再涨');
  // 重复确认成功：无副作用
  const r2 = D.markSent(job, 'web1');
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_delivered');
});

test('C2: sending 中禁止并发重入（防同席双发）', () => {
  const job = makeJob();
  D.markSending(job, 'web2');
  const r = D.markSending(job, 'web2');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'already_sending');
  assert.strictEqual(job.seats.get('web2').attempt, 1, '重入不许再 +1');
});

test('C2: 失败→重试名单只有 failed 席位；sent/pending 永不入名单', () => {
  const job = makeJob();
  // web1 成功, web2 失败, web3 未动
  D.markSending(job, 'web1'); D.markSent(job, 'web1');
  D.markSending(job, 'web2'); D.markFailed(job, 'web2', { error: 'CDP_UPLOAD_FAILED' });
  assert.deepStrictEqual(D.retryTargets(job), ['web2'], '重试名单必须恰好是 failed');
  assert.deepStrictEqual(D.pendingTargets(job), ['web3']);
  // 失败席重试：attempt 累加（2 次尝试）
  D.markSending(job, 'web2', { transport: D.TRANSPORT.L2 });
  assert.strictEqual(job.seats.get('web2').attempt, 2);
  // 这次成功走 L2
  D.markSent(job, 'web2', { transport: D.TRANSPORT.L2 });
  assert.deepStrictEqual(D.retryTargets(job), [], '失败席修好后重试名单清空');
});

test('C2: 失败席已被别的通道修好后再收到迟到失败回报 → 拒绝覆盖 delivered', () => {
  const job = makeJob();
  D.markSending(job, 'web1');
  D.markSent(job, 'web1');
  const r = D.markFailed(job, 'web1', { error: '迟到的超时回报' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(job.seats.get('web1').delivered, true, '迟到失败不许把 delivered 打回');
});

test('C2: 未知席位抛错（防拼错 id 静默产生脏数据）', () => {
  const job = makeJob();
  assert.throws(() => D.markSending(job, 'web99'), /未知席位/);
});

test('C2: progress / failedSeats 汇总正确（失败显式点名）', () => {
  const job = makeJob();
  D.markSending(job, 'web1'); D.markSent(job, 'web1');
  D.markSending(job, 'web2'); D.markFailed(job, 'web2', { error: 'DOM_NOT_FOUND' });
  const p = D.progress(job);
  assert.deepStrictEqual(p, { total: 3, sent: 1, failed: 1, pending: 1, sending: 0 });
  assert.deepStrictEqual(D.failedSeats(job), [
    { seatId: 'web2', error: 'DOM_NOT_FOUND', attempt: 1 },
  ]);
});

/* ─────────── C3 持久化 ─────────── */

test('C3: serialize→deserialize 往返状态保真（attempt/delivered/error 不清零）', () => {
  const job = makeJob();
  D.markSending(job, 'web1'); D.markSent(job, 'web1');
  D.markSending(job, 'web2'); D.markFailed(job, 'web2', { error: 'CDP_UPLOAD_FAILED' });

  const restored = D.deserialize(JSON.parse(JSON.stringify(D.serialize(job))));
  assert.strictEqual(restored.jobId, 'job_test');
  assert.strictEqual(restored.seats.get('web1').delivered, true, '恢复后 delivered 不能丢');
  assert.strictEqual(restored.seats.get('web1').attempt, 1);
  assert.strictEqual(restored.seats.get('web2').status, D.SEAT_STATUS.FAILED);
  assert.strictEqual(restored.seats.get('web2').error, 'CDP_UPLOAD_FAILED');
  assert.strictEqual(restored.snapshot.contentHash, job.snapshot.contentHash);
  // 恢复后重试语义正确：只包含 web2
  assert.deepStrictEqual(D.retryTargets(restored), ['web2']);
});

test('C3: 崩溃恢复后绝不重发已 delivered 席位（核心验收）', () => {
  const job = makeJob();
  D.markSending(job, 'web1'); D.markSent(job, 'web1');   // web1 已发
  D.markSending(job, 'web2'); D.markFailed(job, 'web2'); // web2 失败在途

  // 模拟崩溃后恢复
  const restored = D.deserialize(JSON.parse(JSON.stringify(D.serialize(job))));
  // 恢复后尝试重发 web1：必须被拒
  const r = D.markSending(restored, 'web1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'already_delivered');
  assert.strictEqual(restored.seats.get('web1').attempt, 1, '恢复后 attempt 不许再涨');
  // 重试只碰 web2
  assert.deepStrictEqual(D.retryTargets(restored), ['web2']);
});

test('C3: 落盘后稿子被篡改 → 恢复拒绝（防篡改稿续发）', () => {
  const job = makeJob();
  D.markSending(job, 'web1'); D.markSent(job, 'web1');
  const data = JSON.parse(JSON.stringify(D.serialize(job)));
  data.snapshot.text = '被换掉的稿子';  // 有人手改了落盘 JSON
  assert.throws(() => D.deserialize(data), /hash 不一致/);
});

test('C3: formatVersion 不认识 → 拒绝恢复', () => {
  assert.throws(() => D.deserialize({ formatVersion: 99 }), /formatVersion/);
  assert.throws(() => D.deserialize(null), /formatVersion/);
});

test('C3: sending 态也能恢复（崩溃时正在发的席位恢复为 sending，可人工接管）', () => {
  const job = makeJob();
  D.markSending(job, 'web3', { transport: D.TRANSPORT.L1 });
  const restored = D.deserialize(JSON.parse(JSON.stringify(D.serialize(job))));
  const s = restored.seats.get('web3');
  assert.strictEqual(s.status, D.SEAT_STATUS.SENDING);
  assert.strictEqual(s.attempt, 1);
  // sending 态重入被拒 → 上层可以先 markFailed 再重试，或人工接管
  assert.strictEqual(D.markSending(restored, 'web3').ok, false);
});
