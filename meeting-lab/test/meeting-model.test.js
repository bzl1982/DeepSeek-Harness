'use strict';
/**
 * test/meeting-model.test.js —— 会议消息模型 + per-AI 状态机
 *
 * 验证目标：会议状态【独立于网页】，可回放、可定位、可单独重试。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  Meeting,
  AgentStateMachine,
  createMessage,
  createAttachmentRef,
} = require('../core/meeting-model');

/* ---------- 状态机 ---------- */

test('状态机正常链路可前进', () => {
  const sm = new AgentStateMachine('deepseek-web');
  assert.strictEqual(sm.state, 'OFFLINE');
  assert.strictEqual(sm.transition('READY').ok, true);
  assert.strictEqual(sm.transition('UPLOADING').ok, true);
  assert.strictEqual(sm.transition('SENDING').ok, true);
  assert.strictEqual(sm.transition('THINKING').ok, true);
  assert.strictEqual(sm.transition('STREAMING').ok, true);
  assert.strictEqual(sm.transition('COMPLETED').ok, true);
  assert.strictEqual(sm.isTerminal(), true);
});

test('状态机禁止倒退（防止状态错乱）', () => {
  const sm = new AgentStateMachine('a');
  sm.transition('READY');
  sm.transition('SENDING');
  const r = sm.transition('READY'); // 倒退
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /illegal transition/);
});

test('任何非终态都能进入异常态，异常态可 reset 重试', () => {
  const sm = new AgentStateMachine('a');
  sm.transition('READY');
  sm.transition('THINKING');
  assert.strictEqual(sm.transition('CAPTCHA_REQUIRED', { message: '需要人工验证' }).ok, true);
  assert.strictEqual(sm.isError(), true);
  assert.strictEqual(sm.error.code, 'CAPTCHA_REQUIRED');

  assert.strictEqual(sm.reset().ok, true);
  assert.strictEqual(sm.state, 'READY');
  assert.strictEqual(sm.error, null);
});

test('状态机记录完整历史（可回放定位卡在哪一步）', () => {
  const sm = new AgentStateMachine('a');
  sm.transition('READY');
  sm.transition('SENDING');
  sm.transition('TIMEOUT', { message: '120s 无响应' });
  const states = sm.history.map((h) => h.state);
  assert.deepStrictEqual(states, ['OFFLINE', 'READY', 'SENDING', 'TIMEOUT']);
  assert.strictEqual(sm.history[3].from, 'SENDING');
});

test('观察者抛错不得影响主流程', () => {
  const sm = new AgentStateMachine('a', {
    onChange: () => { throw new Error('observer boom'); },
  });
  assert.strictEqual(sm.transition('READY').ok, true); // 不应被观察者炸掉
  assert.strictEqual(sm.state, 'READY');
});

/* ---------- 消息模型 ---------- */

test('createMessage 校验 senderType', () => {
  assert.throws(() => createMessage({ meetingId: 'm', senderType: 'bot' }), /bad senderType/);
  const m = createMessage({ meetingId: 'm', senderType: 'agent', senderId: 'a' });
  assert.match(m.id, /^msg_/);
});

test('一个文件 = 一个 attachmentRef，9 个 AI 共用同一引用', () => {
  const ref = createAttachmentRef({
    attachmentId: 'att_1', name: 'x.pdf', size: 100, mime: 'application/pdf', localPath: 'D:/x.pdf',
  });
  assert.strictEqual(ref.attachmentId, 'att_1');
  assert.throws(() => createAttachmentRef({}), /attachmentId required/);

  const meeting = new Meeting();
  const r1 = meeting.registerAttachment(ref);
  const r2 = meeting.registerAttachment(ref);
  assert.strictEqual(r1, r2);
  assert.strictEqual(meeting.attachments.size, 1);
});

test('会议消息带轮次/序号，可回放', () => {
  const meeting = new Meeting({ topic: '架构评审' });
  meeting.addAgent('a');
  meeting.addAgent('b');

  meeting.appendMessage({ senderType: 'user', senderId: 'human', content: '开始' });
  meeting.appendMessage({ senderType: 'agent', senderId: 'a', content: '我认为…' });
  meeting.appendMessage({ senderType: 'agent', senderId: 'b', content: '我补充…' });

  assert.strictEqual(meeting.messages.length, 3);
  assert.strictEqual(meeting.messagesInRound(1).length, 3);
  assert.strictEqual(meeting.messagesOf('a').length, 1);

  meeting.nextRound();
  assert.strictEqual(meeting.round, 2);
  assert.strictEqual(meeting.turn, 0);
});

test('pushMessage 校验 meetingId，防止串会', () => {
  const m1 = new Meeting();
  const m2 = new Meeting();
  const msg = createMessage({ meetingId: m2.meetingId, senderId: 'a' });
  assert.throws(() => m1.pushMessage(msg), /meetingId mismatch/);
});

test('isRoundSettled：本轮发言者全部终结才算本轮结束', () => {
  const meeting = new Meeting();
  const a = meeting.addAgent('a');
  const b = meeting.addAgent('b');
  meeting.appendMessage({ senderType: 'agent', senderId: 'a', content: 'x' });
  meeting.appendMessage({ senderType: 'agent', senderId: 'b', content: 'y' });

  a.transition('READY'); a.transition('SENDING'); a.transition('THINKING'); a.transition('COMPLETED');
  assert.strictEqual(meeting.isRoundSettled(), false, 'b 还没终结');

  b.transition('READY'); b.transition('SENDING'); b.transition('TIMEOUT');
  assert.strictEqual(meeting.isRoundSettled(), true, '两个都终结了');
});

test('stateSummary 直接可喂给 UI 状态灯', () => {
  const meeting = new Meeting();
  const a = meeting.addAgent('a');
  const b = meeting.addAgent('b');
  a.transition('READY');
  b.transition('READY'); b.transition('THINKING');
  assert.deepStrictEqual(meeting.stateSummary(), { a: 'READY', b: 'THINKING' });
});

test('toJSON 可完整存档（会议状态不丢）', () => {
  const meeting = new Meeting({ topic: 'T' });
  const a = meeting.addAgent('a');
  a.transition('READY');
  meeting.appendMessage({ senderType: 'user', senderId: 'human', content: 'hi' });
  const json = JSON.parse(JSON.stringify(meeting.toJSON()));
  assert.strictEqual(json.topic, 'T');
  assert.strictEqual(json.messages.length, 1);
  assert.strictEqual(json.agents[0].providerId, 'a');
  assert.strictEqual(json.agents[0].state, 'READY');
});
