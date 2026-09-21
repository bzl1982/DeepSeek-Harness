'use strict';
/**
 * test/protocol.test.js —— 用 node:test 验证 shared/protocol.js 的核心能力：
 *   - extractAgentBlocks 解析 <agent> 块
 *   - 信封构造（sessionHello / toolCall / toolResult / confirmationRespond）
 *   - validateEnvelope / validateToolCall 校验
 *   - agent/parser 去重
 *   - agent/intent 最简兜底
 */

const test = require('node:test');
const assert = require('node:assert');

const Protocol = require('../shared/protocol.js');
const { AgentParser } = require('../agent/parser/index.js');
const { inferIntent } = require('../agent/intent/index.js');

test('extractAgentBlocks: 能解析标准 <agent> JSON 块', () => {
  const text =
    '好的，我来查看目录：\n<agent>\n{"tool":"filesystem.list","arguments":{"path":"D:\\\\MediaForge"}}\n</agent>';
  const blocks = Protocol.extractAgentBlocks(text);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].tool, 'filesystem.list');
  assert.deepStrictEqual(blocks[0].arguments, { path: 'D:\\MediaForge' });
  assert.ok(blocks[0].hash);
});

test('extractAgentBlocks: 忽略非法 JSON / 缺字段的块', () => {
  const text =
    '<agent>{not json}</agent>\n' +
    '<agent>{"tool":"filesystem.read"}</agent>\n' +
    '<agent>{"tool":"shell.exec","arguments":{"command":"echo hi"}}</agent>';
  const blocks = Protocol.extractAgentBlocks(text);
  // 第一个非 JSON 丢弃；第二个缺 arguments 丢弃；第三个合法
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].tool, 'shell.exec');
});

test('extractAgentBlocks: 多个块都能取出', () => {
  const text =
    '<agent>{"tool":"a","arguments":{}}</agent>' +
    '<agent>{"tool":"b","arguments":{}}</agent>';
  const blocks = Protocol.extractAgentBlocks(text);
  assert.strictEqual(blocks.length, 2);
});

test('sessionHello: 默认字段符合 PROTOCOL.md §3.1', () => {
  const env = Protocol.sessionHello({});
  assert.strictEqual(env.protocol, 'agent-tool-v1');
  assert.strictEqual(env.type, 'session.hello');
  assert.strictEqual(env.payload.provider, 'deepseek-web');
  assert.strictEqual(env.payload.dryRun, true);
  assert.strictEqual(env.payload.taskContext, 'project');
  assert.ok(env.requestId);
  assert.ok(env.timestamp > 0);
});

test('toolCall / toolResult: 信封结构正确', () => {
  const call = Protocol.toolCall('filesystem.read', { path: 'x.py' }, 'req-1', 'sess-1');
  assert.strictEqual(call.type, 'tool.call');
  assert.strictEqual(call.requestId, 'req-1');
  assert.strictEqual(call.sessionId, 'sess-1');
  assert.strictEqual(call.payload.tool, 'filesystem.read');

  const res = Protocol.toolResult('req-1', 'sess-1', { content: 'hi' });
  assert.strictEqual(res.type, 'tool.result');
  assert.strictEqual(res.payload.status, 'success');
  assert.deepStrictEqual(res.payload.result, { content: 'hi' });
});

test('toolError: 未知 code 兜底为 INTERNAL_ERROR', () => {
  const err1 = Protocol.toolError('r', 's', 'PERMISSION_DENIED', 'no');
  assert.strictEqual(err1.payload.error.code, 'PERMISSION_DENIED');
  const err2 = Protocol.toolError('r', 's', 'NOT_A_REAL_CODE', 'x');
  assert.strictEqual(err2.payload.error.code, 'INTERNAL_ERROR');
});

test('confirmationRespond: decision 归一化', () => {
  const ok = Protocol.confirmationRespond('r', 's', 'cf-1', 'approve', false);
  assert.strictEqual(ok.type, 'confirmation.respond');
  assert.strictEqual(ok.payload.decision, 'approve');
  const bad = Protocol.confirmationRespond('r', 's', 'cf-1', 'whatever', true);
  assert.strictEqual(bad.payload.decision, 'deny');
  assert.strictEqual(bad.payload.remember, true);
});

test('validateEnvelope: 缺字段 / protocol 不匹配 / 未知 type 都拒绝', () => {
  assert.strictEqual(Protocol.validateEnvelope(null).ok, false);
  assert.strictEqual(Protocol.validateEnvelope({ protocol: 'x', type: 'tool.call' }).ok, false);
  const good = Protocol.toolCall('a', {}, 'r', 's');
  assert.strictEqual(Protocol.validateEnvelope(good).ok, true);
  const noReqId = Protocol.toolCall('a', {}, '', 's');
  noReqId.requestId = '';
  assert.strictEqual(Protocol.validateEnvelope(noReqId).ok, false);
});

test('validateToolCall: 校验 tool 与 arguments', () => {
  assert.strictEqual(Protocol.validateToolCall({ tool: 'a', arguments: {} }).ok, true);
  assert.strictEqual(Protocol.validateToolCall({ tool: 'a' }).ok, false);
  assert.strictEqual(Protocol.validateToolCall({}).ok, false);
});

test('AgentParser: 按 hash 去重，重复块只触发一次', () => {
  const p = new AgentParser();
  const text = '<agent>{"tool":"filesystem.list","arguments":{"path":"D:\\\\x"}}</agent>';
  const first = p.parse(text);
  assert.strictEqual(first.length, 1);
  const second = p.parse(text);
  assert.strictEqual(second.length, 0);
  p.reset();
  const third = p.parse(text);
  assert.strictEqual(third.length, 1);
});

test('inferIntent: 最简自然语言兜底', () => {
  const list = inferIntent('查看 D:\\MediaForge 的项目结构');
  assert.ok(list);
  assert.strictEqual(list.tool, 'filesystem.list');

  const read = inferIntent('读一下 D:\\src\\app.js');
  assert.ok(read);
  assert.strictEqual(read.tool, 'filesystem.read');

  const none = inferIntent('你好，今天天气怎么样');
  assert.strictEqual(none, null);
});
