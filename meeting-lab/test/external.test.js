'use strict';
/**
 * 外部 AI 回答（'external'）的语义测试。
 *
 * 这一组测试守的是用户工作流里最关键、也最容易被他自己的实现漏掉的一步：
 * 「我问完外部 AI，复制回来」—— 这个回答必须能进切片、能辨来源、能匿名。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  EXTERNAL_SOURCES, normalizeSource, parsePastedLabel,
  createExternalMessage, summarizeExternal, toSliceEntries,
} = require('../core/external');
const { createMessage, SENDER_TYPES } = require('../core/meeting-model');
const { selectSlice, SLICE } = require('../core/modes');

const MID = 'meeting_test_external';

/* ═══════════ 1. 类型层 ═══════════ */

test('★ external 必须与 agent 平级（否则要么看不见、要么丢来源）', () => {
  assert.ok(SENDER_TYPES.includes('external'), 'senderType 白名单里必须有 external');
  assert.ok(SENDER_TYPES.includes('agent'));
  assert.ok(SENDER_TYPES.includes('user'));
});

test('createMessage 双向校验：有类型必须有来源、有来源必须有类型', () => {
  // 有类型没来源 → 审计时说不清是哪家给的
  assert.throws(() => createMessage({
    meetingId: MID, senderType: 'external', senderId: 'external:x', content: '正文',
  }), /必须带 external 来源信息/);

  // 有来源没类型 → 切片看不见（会被当普通 agent 或被 user 规则排除）
  assert.throws(() => createMessage({
    meetingId: MID, senderType: 'agent', senderId: 'a', content: '正文',
    external: { provider: '元宝' },
  }), /只能配 senderType='external'/);

  // 两者齐备才行
  const m = createMessage({
    meetingId: MID, senderType: 'external', senderId: 'external:元宝', content: '正文',
    external: { provider: '元宝' },
  });
  assert.strictEqual(m.external.provider, '元宝');
  assert.strictEqual(m.external.model, null, '未给的字段应显式置 null，而不是 undefined 留洞');
});

test('非 external 消息不应带 external 字段（保持消息形状干净）', () => {
  const m = createMessage({ meetingId: MID, senderType: 'agent', senderId: 'a', content: 'x' });
  assert.strictEqual(m.external, undefined);
});

/* ═══════════ 2. 来源归一 ═══════════ */

test('来源名归一：同一家的各种写法都认得出来', () => {
  for (const w of ['元宝', '腾讯元宝', 'YuanBao', 'yuanbao']) {
    assert.strictEqual(normalizeSource(w), w === '元宝' ? '元宝' : w, `「${w}」应保留原写法`);
  }
  // 关键：认不出来不猜、也不丢 —— 用户自定义的来源必须原样保留
  assert.strictEqual(normalizeSource('我自己的小模型'), '我自己的小模型');
  assert.strictEqual(normalizeSource(''), '未知来源');
  assert.strictEqual(normalizeSource(null), '未知来源');
});

test('常见来源清单可用于 UI 下拉，且每项都有 id 与 label', () => {
  assert.ok(EXTERNAL_SOURCES.length >= 8);
  for (const s of EXTERNAL_SOURCES) {
    assert.ok(s.id && s.label, `来源项缺字段：${JSON.stringify(s)}`);
  }
});

/* ═══════════ 3. 粘贴内容解析 ═══════════ */

test('★ 粘贴时自动识别「【元宝】…」这类标注，并且把标注剥掉', () => {
  const r1 = parsePastedLabel('【元宝】我认为应该先冻结接口契约，再分头实现。');
  assert.strictEqual(r1.provider, '元宝');
  assert.strictEqual(r1.text, '我认为应该先冻结接口契约，再分头实现。',
    '标注必须剥掉 —— 否则它会作为正文发给其它 AI');

  const r2 = parsePastedLabel('谷歌：这个问题要看 OpenAI 的官方文档。');
  assert.strictEqual(r2.provider, '谷歌');
  assert.ok(!r2.text.startsWith('谷歌：'));

  const r3 = parsePastedLabel('--- 混元的回答 ---\n建议用名次不用分数。');
  assert.strictEqual(r3.provider, '混元');
  assert.strictEqual(r3.text, '建议用名次不用分数。');
});

test('没有标注时原样保留正文，不误伤', () => {
  const raw = '我觉得应该这样做：先写测试，再写实现。';
  const r = parsePastedLabel(raw);
  assert.strictEqual(r.text, raw, '正文里的冒号不该被当成来源标注');
  assert.strictEqual(r.provider, null);
});

test('正文以短词开头但没有标注格式时，不臆测来源', () => {
  const r = parsePastedLabel('可以。但要先确认一件事。');
  assert.strictEqual(r.provider, null);
  assert.strictEqual(r.text, '可以。但要先确认一件事。');
});

/* ═══════════ 4. 造消息 ═══════════ */

test('createExternalMessage 产出符合约定形状的消息', () => {
  const m = createExternalMessage({
    meetingId: MID, provider: '元宝', content: '建议先冻结契约。',
    model: 'Hunyuan-T1', url: 'https://yuanbao.tencent.com/x', round: 2,
    createMessage,
  });
  assert.strictEqual(m.senderType, 'external');
  assert.strictEqual(m.senderId, 'external:元宝', '约定 senderId = external:<来源>');
  assert.strictEqual(m.round, 2);
  assert.strictEqual(m.external.model, 'Hunyuan-T1');
  assert.strictEqual(m.external.url, 'https://yuanbao.tencent.com/x');
  assert.strictEqual(m.status, 'completed');
});

test('createExternalMessage 拒绝空正文与缺来源', () => {
  assert.throws(() => createExternalMessage({
    meetingId: MID, provider: '元宝', content: '   ', createMessage,
  }), /content 不能为空/);
  assert.throws(() => createExternalMessage({
    meetingId: MID, content: 'x', createMessage,
  }), /provider required/);
  assert.throws(() => createExternalMessage({
    meetingId: MID, provider: '元宝', content: 'x',
  }), /createMessage required/);
});

test('question 字段：外部回答常常不是在回应本轮议题，必须记得下', () => {
  const m = createExternalMessage({
    meetingId: MID, provider: '谷歌', content: '答案',
    question: 'MAF 的 GroupChat 有没有发言顺序控制？', createMessage,
  });
  assert.strictEqual(m.external.question, 'MAF 的 GroupChat 有没有发言顺序控制？');
});

/* ═══════════ 5. ★ 集成：真的能进切片 ═══════════ */

test('★★ 外部回答必须能被系统内的 AI 看到（否则那圈外部咨询等于白问）', () => {
  const messages = [
    { senderId: 'deepseek-web', content: '我方主张：先做接口冻结。' },
    { senderId: 'external:元宝', content: '元宝认为应该先做成本估算，再谈架构。' },
    { senderId: 'external:谷歌', content: '谷歌建议参考 Semantic Kernel 的做法。' },
  ];
  const others = selectSlice(SLICE.OTHERS, { messages, selfId: 'deepseek-web' });
  assert.ok(others.text.includes('元宝认为应该先做成本估算'),
    'OTHERS 切片必须包含外部回答');
  assert.ok(others.text.includes('谷歌建议参考 Semantic Kernel'),
    '多个来源的外部回答都应包含');
  assert.ok(!others.text.includes('我方主张'),
    '自己的发言仍然看不到（OTHERS 的本意不能因为加了 external 就破掉）');
});

test('ALL 切片包含外部回答（收敛阶段要看到全部）', () => {
  const messages = [
    { senderId: 'deepseek-web', content: '我方主张' },
    { senderId: 'external:元宝', content: '元宝的观点' },
  ];
  const all = selectSlice(SLICE.ALL, { messages, selfId: 'deepseek-web' });
  assert.ok(all.text.includes('元宝的观点'));
  assert.ok(all.text.includes('我方主张'));
});

test('外部回答不会与任何参会者混淆（senderId 命名空间隔离）', () => {
  const m = createExternalMessage({
    meetingId: MID, provider: '元宝', content: 'x', createMessage,
  });
  // 参会者的 providerId 形如 deepseek-web / api:deepseek，不可能等于 external:*
  for (const pid of ['deepseek-web', 'api:deepseek', 'chatgpt-web', 'human-relay']) {
    assert.notStrictEqual(m.senderId, pid);
  }
  assert.ok(m.senderId.startsWith('external:'));
});

/* ═══════════ 6. 匿名与审计 ═══════════ */

test('★ 匿名：blind 模式下不暴露是哪家给的（防品牌偏见）', () => {
  const messages = [
    { senderId: 'external:元宝', content: 'A 方案更好', senderType: 'external' },
    { senderId: 'external:谷歌', content: 'B 方案更好', senderType: 'external' },
  ];
  const blind = toSliceEntries(messages, { blind: true });
  assert.strictEqual(blind.length, 2);
  assert.ok(blind.every((e) => /^外部-\d+$/.test(e.senderId)), 'blind 下应换成「外部-N」');
  const joined = blind.map((e) => e.senderId).join();
  assert.ok(!joined.includes('元宝') && !joined.includes('谷歌'), '不得泄漏来源');

  const plain = toSliceEntries(messages, { blind: false });
  assert.strictEqual(plain[0].senderId, 'external:元宝');
});

test('审计汇总：按来源数清楚（事后要说得清结论是哪来的）', () => {
  const messages = [
    { senderType: 'external', senderId: 'external:元宝', content: 'a', external: { provider: '元宝' } },
    { senderType: 'external', senderId: 'external:元宝', content: 'b', external: { provider: '元宝' } },
    { senderType: 'external', senderId: 'external:谷歌', content: 'c', external: { provider: '谷歌' } },
    { senderType: 'agent', senderId: 'deepseek-web', content: 'd' },
  ];
  const s = summarizeExternal(messages);
  assert.strictEqual(s.total, 3, '只统计外部回答，不把 agent 发言算进来');
  assert.strictEqual(s.byProvider['元宝'], 2);
  assert.strictEqual(s.byProvider['谷歌'], 1);
  assert.deepStrictEqual(s.providers.sort(), ['元宝', '谷歌']);
});

test('空输入不炸', () => {
  assert.deepStrictEqual(summarizeExternal([]), { total: 0, byProvider: {}, providers: [] });
  assert.deepStrictEqual(summarizeExternal(null), { total: 0, byProvider: {}, providers: [] });
  assert.deepStrictEqual(toSliceEntries(null), []);
});
