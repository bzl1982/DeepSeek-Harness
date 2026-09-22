'use strict';
/**
 * test/orchestrator.test.js —— 会议编排器（并发 fan-out + 单点失败隔离 + 附件握手）
 *
 * 验证目标（Phase 0 不确定性 #2 #3）：
 *   "一个 AI 卡死/掉线，其余 8 个能不能照常完成"
 *   "附件能不能保证 9 个都收到，收不到的能不能优雅降级"
 *
 * 全部使用假 Adapter，因此【无需浏览器、无需真 AI】即可验证。
 */

const test = require('node:test');
const assert = require('node:assert');
const { Meeting } = require('../core/meeting-model');
const { MeetingOrchestrator, classifyError } = require('../core/orchestrator');
const { STRATEGY, MODE } = require('../core/speaker');
const { makeFakeAdapter, SIGNALS } = require('./helpers/fake-adapter');

const NINE = ['deepseek', 'chatgpt', 'kimi', 'doubao', 'tongyi', 'yuanbao', 'gemini', 'search', 'wenxin'];

function setup(adapters, opts = {}) {
  const meeting = new Meeting({ topic: 'Phase 0 测试会议' });
  const orch = new MeetingOrchestrator({
    meeting,
    adapters,
    completionOpts: { minSignals: 2, timeoutMs: 3000, ...(opts.completionOpts || {}) },
    attachmentBusOpts: { defaultTimeoutMs: 500, ...(opts.attachmentBusOpts || {}) },
    ...opts,
  });
  return { meeting, orch };
}

/* ---------- 基线：广播 ---------- */

test('广播：9 个 AI 全部完成，会议记录写回 1+9 条', async () => {
  const adapters = Object.fromEntries(NINE.map((id) => [id, makeFakeAdapter({ id })]));
  const { meeting, orch } = setup(adapters);

  const r = await orch.runTurn({ text: '请分析这份架构' });

  assert.strictEqual(r.ok.length, 9, '9 个都应成功');
  assert.strictEqual(r.failed.length, 0);
  assert.strictEqual(r.mode, MODE.PARALLEL);
  assert.strictEqual(meeting.messages.length, 10, '1 条用户 + 9 条 AI');
  assert.strictEqual(meeting.messagesOf('gemini').length, 1);
});

test('每个 AI 都走到了终态 COMPLETED（状态机全链路）', async () => {
  const adapters = Object.fromEntries(NINE.map((id) => [id, makeFakeAdapter({ id })]));
  const { meeting, orch } = setup(adapters);
  await orch.runTurn({ text: 'hi' });

  for (const id of NINE) {
    const sm = meeting.getAgent(id);
    assert.strictEqual(sm.state, 'COMPLETED', `${id} 应为 COMPLETED`);
    const states = sm.history.map((h) => h.state);
    assert.ok(states.includes('SENDING'), `${id} 应经过 SENDING`);
    assert.ok(states.includes('STREAMING'), `${id} 应经过 STREAMING`);
  }
});

/* ---------- 单点失败隔离（核心） ---------- */

test('★ 一个 AI 发送失败，其余 8 个照常完成（失败隔离）', async () => {
  const adapters = Object.fromEntries(NINE.map((id) => [id, makeFakeAdapter({ id })]));
  adapters.kimi.failAt = 'send';
  adapters.kimi.failError = 'captcha challenge required';

  const { meeting, orch } = setup(adapters);
  const r = await orch.runTurn({ text: 'hi' });

  assert.strictEqual(r.ok.length, 8, '其余 8 个必须成功');
  assert.deepStrictEqual(r.failed, ['kimi']);
  assert.deepStrictEqual(r.silenced, ['kimi'], '失败者进入闭麦名单');

  // 会议记录里只有成功的 8 个有发言
  assert.strictEqual(meeting.messagesOf('kimi').length, 0);
  // 失败者被正确分类到 CAPTCHA_REQUIRED
  assert.strictEqual(meeting.getAgent('kimi').state, 'CAPTCHA_REQUIRED');
});

test('错误能被正确分类（决定 UI 显示什么、用户怎么处理）', () => {
  assert.strictEqual(classifyError(new Error('429 too many requests')), 'RATE_LIMIT');
  assert.strictEqual(classifyError(new Error('captcha required')), 'CAPTCHA_REQUIRED');
  assert.strictEqual(classifyError(new Error('please login again')), 'LOGIN_EXPIRED');
  assert.strictEqual(classifyError(new Error('ETIMEDOUT network timeout')), 'TIMEOUT');
  assert.strictEqual(classifyError(new Error('selector not found in dom')), 'DOM_CHANGED');
  assert.strictEqual(classifyError(new Error('weird thing')), 'UNKNOWN_ERROR');
});

test('★ 一个 AI 永远不返回（超时），其余照常完成，会议不锁死', async () => {
  const adapters = Object.fromEntries(NINE.map((id) => [id, makeFakeAdapter({ id })]));
  adapters.doubao.hangUntilTimeout = true;
  // 只喂 1 个信号 —— 永远达不到 2 个 → 必超时
  adapters.doubao.signalPlan = [{ signal: SIGNALS.STREAM_END, value: true, atMs: 5 }];

  const { meeting, orch } = setup(adapters, {
    completionOpts: { minSignals: 2, timeoutMs: 200 },
  });
  const r = await orch.runTurn({ text: 'hi', timeoutMs: 200 });

  assert.strictEqual(r.ok.length, 8);
  assert.deepStrictEqual(r.failed, ['doubao']);
  assert.strictEqual(meeting.getAgent('doubao').state, 'TIMEOUT');
});

test('闭麦的 AI 可被单独重试，不必重开整场会议', async () => {
  const adapters = {
    a: makeFakeAdapter({ id: 'a' }),
    b: makeFakeAdapter({ id: 'b', failAt: 'send' }),
  };
  const { meeting, orch } = setup(adapters);

  const r1 = await orch.runTurn({ text: '第一轮' });
  assert.deepStrictEqual(r1.failed, ['b']);

  // 修好问题后单独重试 b
  adapters.b.failAt = null;
  const retry = await orch.retryAgent('b', { text: '重试一次' });

  assert.strictEqual(retry.ok, true, '修复后重试应成功');
  assert.strictEqual(orch.silenced.has('b'), false, '应移出闭麦名单');
  assert.strictEqual(meeting.getAgent('b').state, 'COMPLETED');
});

/* ---------- 附件握手（用户"9 个人收不到文件"的正解） ---------- */

test('★ 附件：全部 ACK 到齐后才放行（PROCEED）', async () => {
  const adapters = Object.fromEntries(NINE.map((id) => [id, makeFakeAdapter({ id })]));
  const { meeting, orch } = setup(adapters);

  const r = await orch.runTurn({
    text: '请审阅附件',
    files: [{ name: 'spec.pdf', size: 2048, mime: 'application/pdf', localPath: 'D:/spec.pdf' }],
  });

  assert.strictEqual(r.attachmentGate.action, 'PROCEED');
  assert.strictEqual(r.attachmentGate.okCount, 9, '9 个 AI 都要 ACK');
  assert.strictEqual(r.attachmentGate.total, 9);
  assert.strictEqual(r.ok.length, 9);

  // 每个 AI 都真的执行了上传
  for (const id of NINE) {
    assert.strictEqual(adapters[id].calls.uploadFiles, 1, `${id} 应上传过一次`);
    assert.strictEqual(adapters[id].uploaded.length, 1);
  }
  // 附件在会议层只登记一次（9 个 AI 共用同一 attachmentId）
  assert.strictEqual(meeting.attachments.size, 1);
});

test('★ 一个 AI 上传失败 → 降级：仅它降级，其余照常（不阻塞整场会议）', async () => {
  const adapters = {
    a: makeFakeAdapter({ id: 'a' }),
    b: makeFakeAdapter({ id: 'b' }),
    c: makeFakeAdapter({ id: 'c', failAt: 'upload' }),
  };
  const { meeting, orch } = setup(adapters);

  const r = await orch.runTurn({
    text: '看附件',
    files: [{ name: 'x.pdf', size: 10, mime: 'application/pdf', localPath: 'D:/x.pdf' }],
  });

  assert.strictEqual(r.attachmentGate.action, 'DEGRADE');
  assert.deepStrictEqual(r.attachmentGate.degraded, ['c']);
  assert.strictEqual(r.ok.length, 3, '降级也要把文字发出去，不能整场卡住');
  // c 仍收到了投递（降级为文本提示）
  assert.strictEqual(adapters.c.sent.length, 1);
  assert.match(adapters.c.sent[0], /附件上传未完成/);
  // a/b 正常收到原文
  assert.strictEqual(adapters.a.sent[0], '看附件');
});

test('无附件时直接放行，不做多余等待', async () => {
  const adapters = { a: makeFakeAdapter({ id: 'a' }) };
  const { orch } = setup(adapters);
  const started = Date.now();
  const r = await orch.runTurn({ text: 'no files' });
  assert.strictEqual(r.attachmentGate.action, 'PROCEED');
  assert.ok(Date.now() - started < 1000, '不应有等待');
});

/* ---------- 发言策略 ---------- */

test('串行策略（round_robin）：依次发言，且每轮起点轮转', async () => {
  const adapters = Object.fromEntries(NINE.map((id) => [id, makeFakeAdapter({ id })]));
  const { meeting, orch } = setup(adapters, { strategy: STRATEGY.ROUND_ROBIN });

  const r1 = await orch.runTurn({ text: '第1轮' });
  assert.strictEqual(r1.mode, MODE.SEQUENTIAL);
  assert.strictEqual(r1.ok.length, 9);
  assert.strictEqual(r1.decision.reason, 'round-robin from index 0');

  meeting.nextRound();
  const r2 = await orch.runTurn({ text: '第2轮' });
  assert.strictEqual(r2.ok.length, 9);
  assert.notStrictEqual(r2.decision.reason, r1.decision.reason, '第二轮的起点应不同（轮转）');
});

test('llm_selector 策略支持动态点名（主持人用 API，不用网页版）', async () => {
  const adapters = Object.fromEntries(NINE.slice(0, 4).map((id) => [id, makeFakeAdapter({ id })]));
  const picked = [];
  const { orch } = setup(adapters, {
    strategy: STRATEGY.LLM_SELECTOR,
    strategyOpts: {
      select: async ({ participants }) => {
        const speaker = participants[picked.length % participants.length];
        picked.push(speaker);
        return { speaker, reason: '主持人点名' };
      },
    },
  });

  const r = await orch.runTurn({ text: '讨论' });
  assert.strictEqual(r.mode, MODE.SEQUENTIAL);
  assert.deepStrictEqual(picked, ['deepseek'], '主持人只点了一个');
  assert.strictEqual(r.ok.length, 1);
});

/* ---------- 健壮性 ---------- */

test('未知 participant 被安全忽略（不会炸）', async () => {
  const adapters = { a: makeFakeAdapter({ id: 'a' }) };
  const { orch } = setup(adapters);
  const r = await orch.runTurn({ text: 'hi', participants: ['a', 'not-exist'] });
  assert.strictEqual(r.ok.length, 1);
});

test('全部 adapter 都失败时也不抛错（对外永不 reject）', async () => {
  const adapters = { a: makeFakeAdapter({ id: 'a', failAt: 'send' }) };
  const { orch } = setup(adapters);
  const r = await orch.runTurn({ text: 'hi' });
  assert.strictEqual(r.ok.length, 0);
  assert.deepStrictEqual(r.failed, ['a']);
});

test('没有可用 adapter 时返回空结果而不是异常', async () => {
  const { orch } = setup({});
  const r = await orch.runTurn({ text: 'hi' });
  assert.strictEqual(r.results.length, 0);
  assert.strictEqual(r.reason, 'no targets');
});
