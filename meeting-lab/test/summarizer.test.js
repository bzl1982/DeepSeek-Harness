'use strict';
/**
 * test/summarizer.test.js —— 会议纪要压缩器（盲点 C 的落地）
 *
 * 验证目标：
 *   1. 轮纪要始终 ≤ 300 字（没有压缩器时也要用截断兜底，不许超限）
 *   2. 每 5 轮触发一次全局压缩（不是每轮都压）
 *   3. 压缩器失败时优雅降级（不炸、不阻塞）
 */

const test = require('node:test');
const assert = require('node:assert');
const { SummaryLedger, defaultRoundCompressor, PER_ROUND_SUMMARY_LIMIT, GLOBAL_COMPRESS_EVERY } = require('../core/summarizer');

test('★ 没有压缩器时，轮纪要也绝不超 300 字（截断兜底）', async () => {
  const ledger = new SummaryLedger({});
  const msg = [{ senderId: 'a', content: 'x'.repeat(900) }];
  const s = await ledger.sealRound(1, msg);
  assert.ok(s.length <= PER_ROUND_SUMMARY_LIMIT, `轮纪要 ${s.length} 字必须 ≤ ${PER_ROUND_SUMMARY_LIMIT}`);
  assert.match(s, /…$/, '截断必须带省略号标记');
});

test('有压缩器时，用压缩结果（不截断）', async () => {
  let calls = 0;
  const ledger = new SummaryLedger({ roundCompressor: async () => { calls += 1; return '这是压缩后的轮纪要'; } });
  const s = await ledger.sealRound(1, [{ senderId: 'a', content: '很' + '长'.repeat(500) }]);
  assert.strictEqual(s, '这是压缩后的轮纪要');
  assert.strictEqual(calls, 1);
});

test('★ 压缩器抛错时优雅降级（不炸、不阻塞会议）', async () => {
  const ledger = new SummaryLedger({ roundCompressor: async () => { throw new Error('API 超时'); } });
  // 不应 reject
  const s = await ledger.sealRound(1, [{ senderId: 'a', content: 'x'.repeat(900) }]);
  assert.ok(s.length <= PER_ROUND_SUMMARY_LIMIT, '压缩失败也必须退回截断兜底');
  assert.strictEqual(ledger.rounds.get(1).source, 'compressed', '仍标记为 attempted compressed（区分于 raw）');
});

test('★ 全局压缩：每 5 轮才触发一次（不是每轮都压）', async () => {
  let globalCalls = 0;
  const ledger = new SummaryLedger({
    roundCompressor: defaultRoundCompressor,
    globalCompressor: async () => { globalCalls += 1; return '全局摘要'; },
  });
  // 第 1 轮：距上次全局压缩 0，不触发
  await ledger.sealRound(1, [{ senderId: 'a', content: '1' }]);
  assert.strictEqual((await ledger.maybeGlobalCompress(1)).shouldCompress, false);

  // 第 5 轮：距上次全局压缩（lastGlobalAt=0）满 5，触发
  for (let r = 2; r <= 5; r += 1) {
    /* eslint-disable-next-line no-await-in-loop */
    await ledger.sealRound(r, [{ senderId: 'a', content: String(r) }]);
  }
  const r5 = await ledger.maybeGlobalCompress(5);
  assert.strictEqual(r5.shouldCompress, true);
  assert.strictEqual(globalCalls, 1);
  assert.strictEqual(ledger.lastGlobalAt, 5);

  // 第 6 轮：刚压缩过（5），距 5 轮 < 5，不触发
  await ledger.sealRound(6, [{ senderId: 'a', content: '6' }]);
  assert.strictEqual((await ledger.maybeGlobalCompress(6)).shouldCompress, false);

  // 第 10 轮：距上次（5）满 5，再次触发
  for (let r = 7; r <= 10; r += 1) {
    /* eslint-disable-next-line no-await-in-loop */
    await ledger.sealRound(r, [{ senderId: 'a', content: String(r) }]);
  }
  assert.strictEqual((await ledger.maybeGlobalCompress(10)).shouldCompress, true);
  assert.strictEqual(globalCalls, 2);
});

test('没有 globalCompressor 时，maybeGlobalCompress 永远 false（不炸）', async () => {
  const ledger = new SummaryLedger({ roundCompressor: defaultRoundCompressor });
  await ledger.sealRound(10, [{ senderId: 'a', content: 'x' }]);
  const r = await ledger.maybeGlobalCompress(10);
  assert.strictEqual(r.shouldCompress, false);
  assert.strictEqual(r.globalSummary, '');
});

test('listRounds 按轮次升序返回（给 UI/存档用）', async () => {
  const ledger = new SummaryLedger({});
  await ledger.sealRound(3, [{ senderId: 'a', content: '三' }]);
  await ledger.sealRound(1, [{ senderId: 'a', content: '一' }]);
  await ledger.sealRound(2, [{ senderId: 'a', content: '二' }]);
  const list = ledger.listRounds();
  assert.deepStrictEqual(list.map((x) => x.round), [1, 2, 3], '必须按轮次升序');
});

test('toJSON 可序列化（MeetingModel 唯一事实源的延伸）', async () => {
  const ledger = new SummaryLedger({ roundCompressor: defaultRoundCompressor });
  await ledger.sealRound(1, [{ senderId: 'a', content: 'x' }]);
  const j = JSON.stringify(ledger.toJSON());
  assert.ok(j.includes('"round":1'));
  assert.ok(j.includes('lastGlobalAt'));
});

test('默认常量符合共识（300 字/轮、每 5 轮全局压）', () => {
  assert.strictEqual(PER_ROUND_SUMMARY_LIMIT, 300);
  assert.strictEqual(GLOBAL_COMPRESS_EVERY, 5);
});
