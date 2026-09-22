'use strict';
/**
 * test/human-relay.test.js —— 人工中转席位（Q8）
 *
 * 验证目标：
 *   1. 它是"真实席位"（实现了 adapter 契约），能进选角/切片/审计
 *   2. 等粘贴的语义：reply() 被调 → 拿到粘贴内容；没人粘 → 超时返回 HUMAN_PENDING（不标 TIMEOUT）
 *   3. 一次粘贴可服务多个等待者（队列语义）
 *   4. 能力画像：推理=0、稳定=5（"搬运工"而非"生成者"）
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHumanRelayAdapter, humanRelayModelEntry } = require('../adapters/human-relay');
const { validateAdapter } = require('../adapters/contract');

/* ---------------- 1. 契约合规（它是"真实席位"的前提） ---------------- */

test('★ human-relay 实现了标准 adapter 契约（能进选角/切片/审计）', () => {
  const adapter = createHumanRelayAdapter({ id: 'human-relay', name: '人工中转' });
  const r = validateAdapter(adapter);
  assert.ok(r.ok, `契约校验应通过，实际缺：${JSON.stringify(r.missing)}`);
  assert.strictEqual(adapter.channel, 'human');
});

/* ---------------- 2. 等粘贴的语义 ---------------- */

test('预置队列：reply 不需要真实 UI，直接取粘贴内容', async () => {
  const adapter = createHumanRelayAdapter({
    id: 'human-relay',
    pendingReplies: ['这是用户粘贴的 DeepSeek 答案', '这是用户粘贴的 Kimi 答案'],
  });
  const r1 = await adapter.waitForResponse({});
  assert.strictEqual(r1.text, '这是用户粘贴的 DeepSeek 答案');
  assert.strictEqual(r1.completion.result, 'COMPLETED');

  const r2 = await adapter.waitForResponse({});
  assert.strictEqual(r2.text, '这是用户粘贴的 Kimi 答案');
});

test('reply() 入口：外部 UI/IPC 调它把粘贴交给等待中的席位', async () => {
  const adapter = createHumanRelayAdapter({ id: 'human-relay' });
  const p = adapter.waitForResponse({ timeoutMs: 5000 });
  assert.strictEqual(adapter.pendingCount(), 1, '应有一个席位在等');
  // 模拟 500ms 后用户粘贴
  await new Promise((r) => setTimeout(r, 50));
  adapter.reply('人工粘贴的答案');
  const r = await p;
  assert.strictEqual(r.text, '人工粘贴的答案');
  assert.strictEqual(r.completion.result, 'COMPLETED');
  assert.strictEqual(adapter.pendingCount(), 0);
});

test('★ 超时不标 TIMEOUT（人会迟到不是机器卡死）→ 标 HUMAN_PENDING，会议继续', async () => {
  const adapter = createHumanRelayAdapter({ id: 'human-relay', timeoutMs: 60 });
  const t0 = Date.now();
  const r = await adapter.waitForResponse({});
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.completion.result, 'HUMAN_PENDING');
  assert.strictEqual(r.text, '', '超时时没有粘贴内容');
  assert.match(r.completion.reason, /会议继续/);
  assert.ok(elapsed >= 50, '确实等了（不是立即返回）');
});

/* ---------------- 3. cancel 清空等待（散会用） ---------------- */

test('cancel() 清空所有等待中的席位（散会时不残留）', async () => {
  const adapter = createHumanRelayAdapter({ id: 'human-relay', timeoutMs: 60000 });
  const p1 = adapter.waitForResponse({});
  const p2 = adapter.waitForResponse({});
  assert.strictEqual(adapter.pendingCount(), 2);
  await adapter.cancel();
  assert.strictEqual(adapter.pendingCount(), 0);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1.text, '', 'cancel 后等待被唤醒（空字符串）');
  assert.strictEqual(r2.text, '');
});

/* ---------------- 4. 能力画像 ---------------- */

test('★ 能力画像：推理=0（不生成只搬运）、稳定=5（不会弹验证码）', () => {
  const m = humanRelayModelEntry();
  assert.strictEqual(m.channel, 'human');
  assert.strictEqual(m.traits.reasoning, 0, '★ 它不推理，是搬运工');
  assert.strictEqual(m.traits.stability, 5, '人粘贴不会中途弹验证码');
  assert.strictEqual(m.traits.structure, 5);
  assert.match(m.notes, /手动指定/, '它不进正常选角（推理 0 会一票否决），需手动挂');
});
