'use strict';
/**
 * test/context-strategy.test.js —— 上下文策略（分歧 #1 的裁决实现）
 *
 * 验证目标（第二轮共识 #7 + 分歧 #1 落地）：
 *   1. 同一份任务，不同角色前缀 → 输出必须不同（防 9 个复读机）
 *   2. 滚动注入公式：角色 + 摘要 + 最近 N 轮原文 + 本轮任务
 *   3. 触发条件 A：超阈值才压缩（不是每轮都压）
 *   4. 触发条件 B：连续 2 轮跑偏才单点重置（且只重置该 AI，不影响其它 8 个）
 *   5. 每 AI 独立预算（9 个不互相挤）
 */

const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_ROLES, composePrompt, ContextStrategy } = require('../core/context-strategy');

/* ---------------- 角色分化 ---------------- */

test('★ 同一任务不同角色 → 输出必然不同（防 9 个复读机，盲点 A）', () => {
  const task = '评审方案 X 的可行性';
  const a = composePrompt({ task, providerId: 'deepseek-web' });
  const b = composePrompt({ task, providerId: 'chatgpt-web' });
  const c = composePrompt({ task, providerId: 'wenxin-web' });
  assert.notStrictEqual(a, b, '红队 与 成本分析师 的 prompt 不能相同');
  assert.notStrictEqual(b, c);
  assert.match(a, /红队/);
  assert.match(b, /成本/);
  assert.match(c, /新人/);
});

test('角色前缀 + 摘要 + 最近 N 轮 + 任务，四层都要在场（Hy4 公式）', () => {
  const out = composePrompt({
    task: '做决定',
    providerId: 'deepseek-web',
    summary: '第 1–3 轮的结论是 Y',
    recentRounds: [
      { sender: 'chatgpt-web', text: '成本 3000 元' },
      { sender: 'kimi-web', text: '合规有风险' },
    ],
  });
  assert.match(out, /红队/);           // 角色
  assert.match(out, /第 1–3 轮的结论是 Y/); // 摘要
  assert.match(out, /成本 3000 元/);     // 最近 N 轮
  assert.match(out, /做决定/);           // 本轮任务
  // 层级顺序：角色 → 摘要 → 最近轮 → 任务
  const i = (re) => out.indexOf(re);
  assert.ok(i('红队') < i('第 1') && i('第 1') < i('成本') && i('成本') < i('做决定'),
    '注入顺序必须固定，否则不同 AI 拿到不同的内容序列');
});

test('空字段要优雅跳过（不出现"【早前讨论摘要】\n"这种残行）', () => {
  const out = composePrompt({ task: 'X', providerId: 'unknown-id' });
  assert.doesNotMatch(out, /【早前讨论摘要】\s*$/m);
  assert.match(out, /X/);
  assert.match(out, new RegExp(DEFAULT_ROLES.default.replace(/[.+^${}()|[\]\\]/g, '\\$&')),
    '未知 provider 回落 default 角色');
});

/* ---------------- 滚动注入预算 ---------------- */

test('★ 默认不压缩：远低于阈值时原样注入（不是每轮都压）', async () => {
  let compressCalls = 0;
  const cs = new ContextStrategy({
    recentRounds: 2,
    injectThresholdChars: 6000,
    compressor: async () => { compressCalls += 1; return '压缩后的摘要'; },
  });
  await cs.getInjection('a', { rounds: [{ sender: 'b', text: '短' }] });
  await cs.getInjection('a', { rounds: [{ sender: 'b', text: '短' }] });
  assert.strictEqual(compressCalls, 0, '远低于 6000 字符不应触发压缩');
});

test('★ 超阈值才压缩（触发条件 A）', async () => {
  let compressCalls = 0;
  const big = 'x'.repeat(3000);
  const cs = new ContextStrategy({
    recentRounds: 2,
    injectThresholdChars: 6000,
    compressor: async () => { compressCalls += 1; return '压缩后的摘要'; },
  });
  // 第一轮：3000 字符 < 6000 阈值 → 不压缩
  await cs.getInjection('a', { rounds: [{ sender: 'b', text: big }] });
  assert.strictEqual(compressCalls, 0, '首次注入（3000 字符）不该触发压缩');

  // 第二轮：累计 6000 > 6000 阈值 → 压缩
  const r2 = await cs.getInjection('a', { rounds: [{ sender: 'b', text: big }] });
  assert.strictEqual(compressCalls, 1, '累计超阈值必须触发压缩');
  assert.strictEqual(r2.compressed, true);
});

test('★ 单点重置：跑偏 AI 清空旧摘要，其它 AI 不受影响（触发条件 B，KIMI 裁决）', async () => {
  const cs = new ContextStrategy({ recentRounds: 1, injectThresholdChars: 6000 });
  await cs.getInjection('a', { rounds: [{ sender: 'b', text: '早期讨论 1' }] });
  await cs.getInjection('b', { rounds: [{ sender: 'a', text: '早期讨论 2' }] });
  assert.strictEqual(cs.ensure('a').injected > 0, true);
  assert.strictEqual(cs.ensure('b').injected > 0, true);

  // AI "a" 连续 2 轮跑偏 → 单点重置
  await cs.getInjection('a', { markDeviated: true });
  assert.strictEqual(cs.ensure('a').deviations, 1);
  const r = await cs.getInjection('a', { markDeviated: true, rounds: [{ sender: 'b', text: 'x' }] });
  assert.strictEqual(r.reset, true, '第 2 轮跑偏必须触发单点重置');
  assert.strictEqual(r.recentRounds.length, 0, '重置后本轮不注入任何历史');

  // 其它 AI 的预算必须原封不动
  assert.strictEqual(cs.ensure('b').injected > 0, true, 'a 重置不能影响 b 的预算');
  assert.strictEqual(cs.ensure('a').deviations, 0, '重置后偏差计数清零');
});

test('★ 每 AI 独立预算：9 个 AI 互不挤占', () => {
  const cs = new ContextStrategy({ recentRounds: 2, injectThresholdChars: 100 });
  for (const pid of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
    cs.ensure(pid);
  }
  cs.ensure('a').injected = 99; // 让 a 接近阈值
  assert.strictEqual(cs.ensure('b').injected, 0, 'b 不受 a 影响');
});

test('无 compressor 时超阈值也安全（只记日志值，不炸）', async () => {
  const cs = new ContextStrategy({ recentRounds: 1, injectThresholdChars: 10, compressor: null });
  const r = await cs.getInjection('a', { rounds: [{ sender: 'b', text: '这是一段很长的历史讨论内容' }] });
  assert.ok(typeof r.injectedNow === 'number', '没有 compressor 也不能抛错');
});

test('toJSON 可序列化存档（MeetingModel 是唯一事实源的延伸）', () => {
  const cs = new ContextStrategy({});
  cs.ensure('a');
  const j = JSON.stringify(cs.toJSON());
  assert.ok(j.includes('"providerId":"a"'));
  assert.ok(j.includes('injectThresholdChars'));
});
