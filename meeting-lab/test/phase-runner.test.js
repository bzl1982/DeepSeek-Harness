'use strict';
/**
 * test/phase-runner.test.js —— 阶段编排器：契约是不是**真的**被执行了
 *
 * 这些用例针对的不是"代码能不能跑"，而是**三件此前只在纸面上的事**：
 *   ① sequential 接龙 —— 第 k 人到底有没有看到前 k-1 人刚说的话？
 *   ② 组边界 —— 组 2 的人到底有没有看到组 1 的细节？（看不到才是省钱的）
 *   ③ 归并约束 —— 归并席是不是只吃组长产出？ballot 有没有混进去（会跟票）？
 *
 * 判据技巧：selectSlice 把前文拼成 `【senderId】内容`，
 * 所以"某人看到了谁"可以直接用 `text.includes('【b】')` 断言 —— 不用去猜内部结构。
 *
 * 全部用假 speakTo，无需浏览器、无需真 AI。
 */

const test = require('node:test');
const assert = require('node:assert');
const { Meeting } = require('../core/meeting-model');
const { PhaseRunner, VERDICT_TEMPLATE } = require('../core/phase-runner');
const { planPhases, estimateCost, listModes, SLICE, SPEAK } = require('../core/modes');
const { assignRoles } = require('../core/roles');

const NINE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const ASSIGN9 = assignRoles(NINE, { set: 'product-9' });

/**
 * 假 speakTo：记录"每个人到底收到了什么文本"，并把产出写回会议记录
 * （模拟真 orchestrator 的行为 —— 没有写回就没有接龙，也没有 provenance）。
 */
function makeRig({ failFor = null, failOnce = null, speakToImpl = null } = {}) {
  const meeting = new Meeting({ topic: '阶段编排测试' });
  const sent = [];
  const onceFailed = new Set();
  let seq = 0;

  const speakTo = async (providerId, { text = '', kind = null, round = null } = {}) => {
    seq += 1;
    const rec = { seq, providerId, text, kind, round, atMessageCount: meeting.messages.length };
    sent.push(rec);

    const shouldFail = (failFor && failFor.has(providerId))
      || (failOnce && failOnce.has(providerId) && !onceFailed.has(providerId));
    if (shouldFail) {
      if (failOnce && failOnce.has(providerId)) onceFailed.add(providerId);
      return { providerId, ok: false, state: 'TIMEOUT', error: 'fake timeout', durationMs: 1 };
    }

    meeting.appendMessage({
      senderType: 'agent',
      senderId: providerId,
      content: `${providerId} 的产出#${seq}(${kind || '-'})`,
      kind: kind || undefined,
      round: round != null ? round : meeting.round,
      status: 'completed',
    });
    if (speakToImpl) return speakToImpl(providerId, { text, kind, round });
    return { providerId, ok: true, state: 'COMPLETED', durationMs: 1 };
  };

  const runner = new PhaseRunner({ meeting, speakTo, ...(arguments[0] || {}) });
  return { meeting, sent, runner, textFor: (pid) => sent.filter((s) => s.providerId === pid).map((s) => s.text) };
}

const panelPlan = (g = 0) => planPhases('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: g });

/* ═══════════════ ① 接龙 vs 并行（speak 契约） ═══════════════ */

test('★ 顺序接龙：第 2 人拿到的文本里含第 1 人**刚产出**的内容', async () => {
  const { runner, sent, textFor } = makeRig();
  await runner.runStage(panelPlan(0)[0], { task: '议题', round: 1 });

  const tA = textFor('a')[0];
  const tB = textFor('b')[0];
  assert.ok(!tA.includes('【a】'), '第 1 人看不到自己（OTHERS 语义）');
  assert.ok(tB.includes('【a】'), '★ 第 2 人必须看到第 1 人本阶段刚说的话 —— 这才是接龙');
  assert.strictEqual(sent[0].atMessageCount, 0, '第 1 人发言前会议里没有发言');
  assert.strictEqual(sent[1].atMessageCount, 1, '第 2 人发言前已有 1 条（接龙累加）');
});

test('★ 并行阶段：第 2 人看不到第 1 人本轮产出（快照冻结，防锚定）', async () => {
  // broadcast 用 TASK 切片，本来就不带会议上下文；换成 OTHERS + parallel 才说明问题
  const { runner: r2, textFor: tf2 } = makeRig();
  const parallelOthers = { name: '并行质证', index: 0, speakers: NINE, speak: SPEAK.PARALLEL, slice: SLICE.OTHERS };
  await r2.runStage(parallelOthers, { task: '议题', round: 1 });
  assert.ok(!tf2('b')[0].includes('【a】'), '★ 并行时人人看同一份阶段前快照，不应看到 a 的新产出');
  assert.ok(!tf2('i')[0].includes('【b】'), '★ 最后一人也看不到任何人的本轮产出（防锚定）');
  assert.strictEqual(r2.report ? 1 : 1, 1);
  // 对照组：同样的人换成 sequential，立刻能看到
  const { runner: r3, textFor: tf3 } = makeRig();
  await r3.runStage({ ...parallelOthers, speak: SPEAK.SEQUENTIAL }, { task: '议题', round: 1 });
  assert.ok(tf3('b')[0].includes('【a】'), '同一份切片，串行就能看到 —— 差别只在 speak');
});

test('接龙轮次递增：每人看到的份数 = 0,1,2,…,8（与预估公式同口径）', async () => {
  const { runner, sent } = makeRig();
  const plan = panelPlan(0);
  const r = await runner.runStage(plan[0], { task: '议题', round: 1 });
  const perSpeaker = r.results.map((x) => x.injected);
  assert.deepStrictEqual(perSpeaker, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.strictEqual(r.injected, 36);
  assert.strictEqual(sent.length, 9);
});

/* ═══════════════ ② 组边界（groupSize 契约） ═══════════════ */

test('★ 组内阶段只喂本组：组 2 的人看不到组 1 任何细节', async () => {
  const { runner, textFor } = makeRig();
  const plan = panelPlan(3);
  await runner.runPlan(plan, { task: '议题', round: 1 });

  const d = textFor('d')[0];
  assert.ok(!d.includes('【a】') && !d.includes('【b】') && !d.includes('【c】'),
    '★ 组 2 必须看不到组 1 的明细 —— 看不到才是省钱的物理前提');
  const e = textFor('e')[0];
  assert.ok(e.includes('【d】'), '组内接龙照常（组 2 第 2 人看到组 2 第 1 人）');
});

test('★ 组长阶段：组长读到本组全部明细（含自己），但不含别的组明细', async () => {
  const { runner, textFor } = makeRig();
  await runner.runPlan(panelPlan(3), { task: '议题', round: 1 });

  const a = textFor('a').at(-1);   // 组长 a 的最后一次发言 = 组长会诊
  assert.ok(a.includes('【a】') && a.includes('【b】') && a.includes('【c】'),
    '组长必须能引用本组全部明细（含自己那句）——它是本组代表');
  assert.ok(!a.includes('【d】') && !a.includes('【e】'), '★ 组长不该看到别的组的明细');
});

test('★ 组长阶段不含"别的组长在会诊阶段的发言"（注入量虚高的根源）', async () => {
  const { runner } = makeRig();
  const plan = panelPlan(3);
  const r = await runner.runPlan(plan, { task: '议题', round: 1 });
  const leaderStage = r.stages[3];
  assert.strictEqual(leaderStage.name, '组长会诊');
  assert.deepStrictEqual(leaderStage.results.map((x) => x.injected), [3, 4, 5],
    '★ 组长 a=本组3份、d=3+前1个组长、g=3+前2个组长 → 12 份（第一版算成 15，因为把 d 在会诊阶段的发言也算进来了）');
  assert.strictEqual(leaderStage.injected, 12);
});

/* ═══════════════ ③ 归并阶段的编排约束（本轮重点） ═══════════════ */

test('★ 分组时归并席只看到组长产出，绝不读组内明细', async () => {
  const { runner, textFor } = makeRig();
  const plan = panelPlan(3);
  await runner.runPlan(plan, { task: '议题', round: 1 });

  const merge = textFor('i').at(-1);   // converge 席位 = i
  assert.ok(merge.includes('【a】') && merge.includes('【d】') && merge.includes('【g】'),
    '归并席看得到 3 位组长的产出');
  for (const inner of ['b', 'c', 'e', 'f', 'h']) {
    assert.ok(!merge.includes(`【${inner}】`), `★ 归并席不该看到组内明细（【${inner}】）—— 否则分组白做`);
  }
});

test('★ 分组后注入量真的降下来：45 → 24 份（不是只活在 plan 里）', async () => {
  const { runner } = makeRig();
  const plain = await runner.runPlan(panelPlan(0), { task: '议题', round: 1 });
  const { runner: r2 } = makeRig();
  const grouped = await r2.runPlan(panelPlan(3), { task: '议题', round: 1 });
  assert.strictEqual(plain.injectedTotal, 45);
  assert.strictEqual(grouped.injectedTotal, 24, '★ 实际执行也必须是 24 份（预估 24）');
});

test('★ ballot 不进归并输入（评标的名次表被剔除，防跟票）', async () => {
  const { runner, textFor } = makeRig();
  const plan = planPhases('tournament', { participants: NINE, assignment: ASSIGN9 });
  await runner.runPlan(plan, { task: '议题', round: 1 });

  const verdictStageIdx = plan.findIndex((p) => p.produces === 'verdict');
  const verdictSeat = plan[verdictStageIdx].speakers[0];
  const text = textFor(verdictSeat).at(-1);
  assert.ok(!text.includes('ballot'), '★ 名次表不能出现在定标/归并输入里');
  assert.ok(text.includes('candidate'), '候选方案仍应可见（定标要吃候选）');
});

test('归并输入超量 → 走压缩器（注入的压缩器被调用）', async () => {
  const calls = [];
  const rig = makeRig({
    compress: async (text, limit) => { calls.push({ from: text.length, limit }); return '压缩后的摘要'; },
    maxMergeChars: 50,
  });
  const long = Array.from({ length: 9 }, (_, i) => ({ senderId: `s${i}`, senderType: 'agent', content: 'x'.repeat(80) }));
  rig.meeting.messages.push(...long.map((m) => ({ ...m, id: `x${Math.random()}`, round: 1 })));

  const plan = panelPlan(0);
  await rig.runner.runStage(plan[1], { task: '议题', round: 1 });   // 归并结论
  assert.strictEqual(calls.length, 1, '超量时压缩器必须被调用一次');
  assert.ok(calls[0].from > 50, '压缩的是超量文本');
});

test('压缩器抛错 → 回退截断，不炸会场', async () => {
  const rig = makeRig({
    compress: async () => { throw new Error('API 挂了'); },
    maxMergeChars: 50,
  });
  rig.meeting.messages.push({ id: 'x1', senderType: 'agent', senderId: 'z', content: 'y'.repeat(200), round: 1 });
  const r = await rig.runner.runStage(panelPlan(0)[1], { task: '议题', round: 1 });
  assert.strictEqual(r.failed.length, 0, '压缩失败绝不能拖垮阶段');
  assert.ok(rig.sent.at(-1).text.length < 200, '回退为截断');
});

test('produces=verdict → 输出模板必须带上（归并席不许重新投票）', async () => {
  const { runner, textFor } = makeRig();
  const plan = planPhases('tournament', { participants: NINE, assignment: ASSIGN9 });
  await runner.runPlan(plan, { task: '议题', round: 1 });
  const stage = plan.find((p) => p.produces === 'verdict');
  const text = textFor(stage.speakers[0]).at(-1);
  assert.ok(text.includes(VERDICT_TEMPLATE), '必须附上 verdict 模板');
  assert.ok(text.includes('决议') && text.includes('待办'), '模板要求四段（决议/分歧/风险/待办）');
});

test('★ 归并阶段幂等：一轮只跑一次（重跑会往记录里塞第二份互相矛盾的结论）', async () => {
  const { runner } = makeRig();
  const plan = panelPlan(0);
  const stage = plan[1];
  const first = await runner.runStage(stage, { task: '议题', round: 1 });
  const second = await runner.runStage(stage, { task: '议题', round: 1 });
  assert.strictEqual(first.skipped, false);
  assert.strictEqual(second.skipped, true);
  assert.strictEqual(second.skipReason, 'already-run');
  assert.strictEqual(second.injected, 0, '跳过时不该产生任何注入');
});

test('归并阶段全军覆没 → 不算执行过，下次还能重跑（否则一次超时永久锁死归并）', async () => {
  const { runner } = makeRig({ failFor: new Set(['i']) });
  const plan = panelPlan(0);
  const r1 = await runner.runStage(plan[1], { task: '议题', round: 1 });
  assert.deepStrictEqual(r1.ok, []);
  const r2 = await runner.runStage(plan[1], { task: '议题', round: 1 });
  assert.strictEqual(r2.skipped, false, '★ 失败不算"执行过"，必须允许重跑');
});

test('force=true 可强制重跑归并（人工要求重新归并时用）', async () => {
  const { runner } = makeRig();
  const stage = panelPlan(0)[1];
  await runner.runStage(stage, { task: '议题', round: 1 });
  const forced = await runner.runStage(stage, { task: '议题', round: 1 }, { force: true });
  assert.strictEqual(forced.skipped, false);
  assert.strictEqual(forced.ok.length, 1);
});

/* ═══════════════ ④ 失败隔离与单点重试 ═══════════════ */

test('★ 一个发言者失败，阶段继续跑完其余人（失败隔离）', async () => {
  const { runner } = makeRig({ failFor: new Set(['c']) });
  const r = await runner.runStage(panelPlan(0)[0], { task: '议题', round: 1 });
  assert.deepStrictEqual(r.failed, ['c']);
  assert.strictEqual(r.ok.length, 8, '其余 8 人照常完成');
  assert.strictEqual(r.results.length, 9, '9 人都有结果记录（失败的也在）');
});

test('retrySpeaker 只重试那一个人，不重跑整个阶段', async () => {
  const { runner, sent } = makeRig({ failOnce: new Set(['c']) });
  const stage = panelPlan(0)[0];
  await runner.runStage(stage, { task: '议题', round: 1 });
  const before = sent.length;
  const r = await runner.retrySpeaker(stage, 'c', { task: '议题', round: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sent.length, before + 1, '★ 只多了一次调用');
  assert.strictEqual(sent.at(-1).providerId, 'c');
});

test('speakTo 直接抛异常 → 收敛为失败结果，不冒泡（对外永不 reject）', async () => {
  const meeting = new Meeting({ topic: 't' });
  const runner = new PhaseRunner({
    meeting,
    speakTo: async (pid) => {
      if (pid === 'a') throw new Error('boom');
      meeting.appendMessage({ senderType: 'agent', senderId: pid, content: 'ok', round: 1, status: 'completed' });
      return { providerId: pid, ok: true, state: 'COMPLETED' };
    },
  });
  const r = await runner.runStage(panelPlan(0)[0], { task: '议题', round: 1 });
  assert.deepStrictEqual(r.failed, ['a']);
  assert.strictEqual(r.results[0].state, 'UNKNOWN_ERROR');
  assert.strictEqual(r.ok.length, 8);
});

/* ═══════════════ ⑤ 试算与对账（dryRun === estimateCost） ═══════════════ */

test('★ dryRun 不发任何消息（纯试算）', () => {
  const { runner, meeting, sent } = makeRig();
  const before = meeting.messages.length;
  runner.dryRun(panelPlan(3), { task: '议题', round: 1 });
  assert.strictEqual(meeting.messages.length, before, '试算不得写会议记录');
  assert.strictEqual(sent.length, 0, '试算不得调用任何 AI');
});

const FULL_CTX = {
  task: '议题', material: '材料', draft: '草稿', critiques: ['c1', 'c2'],
  contract: { text: '契约', modules: [] },
  candidates: [{ senderId: 'a', content: '候选1' }, { senderId: 'b', content: '候选2' }],
  round: 1,
};

test('★ panel 全部分组档位：dryRun 与 estimateCost 分毫不差', () => {
  const runner = new PhaseRunner({ speakTo: async () => ({ ok: true }) });
  for (const g of [0, 2, 3, 4, 5, 6, 8, 9]) {
    const plan = planPhases('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: g });
    const est = estimateCost('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: g });
    const dry = runner.dryRun(plan, FULL_CTX);
    assert.strictEqual(dry.injectedTotal, est.contextPerRound, `panelGroupSize=${g} 对账必须一致`);
  }
});

test('★ 全部模式：dryRun 与 estimateCost 分毫不差（预估失真 = 用户看到的成本是假的）', () => {
  const runner = new PhaseRunner({ speakTo: async () => ({ ok: true }) });
  for (const id of listModes().map((m) => m.id)) {
    const plan = planPhases(id, { participants: NINE, assignment: ASSIGN9 });
    const est = estimateCost(id, { participants: NINE, assignment: ASSIGN9 });
    const dry = runner.dryRun(plan, FULL_CTX);
    assert.strictEqual(dry.injectedTotal, est.contextPerRound, `模式 ${id} 对账必须一致`);
  }
});

test('均分组时注入量正好是 1/3（会诊 36 → 9）+ 归并只读组长 3 份', () => {
  const runner = new PhaseRunner({ speakTo: async () => ({ ok: true }) });
  const plain = runner.dryRun(panelPlan(0), FULL_CTX);
  const grouped = runner.dryRun(panelPlan(3), FULL_CTX);
  assert.strictEqual(plain.stages[0].injected, 36, '不分组：会诊 O(n²) = 36 份');
  const innerGrouped = grouped.stages
    .filter((s) => s.name.startsWith('组') && !s.name.startsWith('组长'))   // ★ 别把「组长会诊」算成组内
    .reduce((a, s) => a + s.injected, 0);
  assert.strictEqual(innerGrouped, 9, '3 组 × (0+1+2=3) = 9（原来的 1/4）');
  assert.strictEqual(plain.stages.at(-1).injected, 9, '不分组：归并读 9 份全部发言');
  assert.strictEqual(grouped.stages.at(-1).injected, 3, '★ 分组：归并只读 3 份组长产出（不是 9 份明细）');
  assert.strictEqual(plain.injectedTotal, 45);
  assert.strictEqual(grouped.injectedTotal, 24);
});

test('picker 阶段（主席点名）人数运行期才定 → 试算标 estimated:true，不假装精确', () => {
  const runner = new PhaseRunner({ speakTo: async () => ({ ok: true }) });
  const plan = planPhases('chairman', { participants: NINE, assignment: ASSIGN9 });
  const dry = runner.dryRun(plan, FULL_CTX);
  const est = estimateCost('chairman', { participants: NINE, assignment: ASSIGN9 });
  assert.strictEqual(dry.injectedTotal, est.contextPerRound);
  assert.strictEqual(dry.stages[0].estimated, true);
  assert.strictEqual(est.breakdown[0].estimated, true);
});

/* ═══════════════ ⑥ 与外部 AI（external）正交组合 ═══════════════ */

test('★ 外部 AI 的回答对全员可见 —— 组内阶段也看得到（否则那圈外部咨询白问）', async () => {
  const { runner, meeting, textFor } = makeRig();
  meeting.appendMessage({
    senderType: 'external', senderId: 'external:元宝',
    content: '外部结论：建议先做 A',
    external: { provider: '元宝' },     // ★ external 类型必须带来源（meeting-model 双向校验）
    round: 1, status: 'completed',
  });
  await runner.runStage(panelPlan(3)[0], { task: '议题', round: 1 });
  assert.ok(textFor('a')[0].includes('external:元宝'), '★ 组内成员必须看得到外部咨询结论');
});

test('external 在归并阶段同样保留（不会因为组边界被过滤掉）', async () => {
  const { runner, meeting, textFor } = makeRig();
  meeting.appendMessage({
    senderType: 'external', senderId: 'external:谷歌', content: 'X',
    external: { provider: '谷歌' }, round: 1, status: 'completed',
  });
  await runner.runPlan(panelPlan(3), { task: '议题', round: 1 });
  const merge = textFor('i').at(-1);
  assert.ok(merge.includes('external:谷歌'), '归并席也要看得到外部结论');
});

/* ═══════════════ ⑦ 与 orchestrator 的接线 ═══════════════ */

test('runPlan 汇总形状：stages / injectedTotal / calls / ok / failed', async () => {
  const { runner } = makeRig();
  const r = await runner.runPlan(panelPlan(3), { task: '议题', round: 1 });
  assert.strictEqual(r.stages.length, 5);
  assert.strictEqual(r.calls, 9 + 3 + 1, '3 组会诊 9 人 + 3 组长 + 1 归并');
  assert.strictEqual(r.ok.length, 13);
  assert.deepStrictEqual(r.failed, []);
  assert.strictEqual(r.injectedTotal, 24);
});

test('有人失败会让"注入总量"下降（失败者自己少看，同组/后续也少看到它）', async () => {
  const { runner } = makeRig({ failFor: new Set(['h']) });
  const r = await runner.runPlan(panelPlan(3), { task: '议题', round: 1 });
  assert.deepStrictEqual(r.failed, ['h']);
  assert.strictEqual(r.ok.length, 12);
  /* h 是组3第2人。它**自己那一次读取照算**（上下文已经给它了，只是它没答出来），
   * 所以总量只减少两处：① 同组 i 看不到 h（-1）；② 组长 g 少读 1 份明细（-1）
   *   → 24 - 2 = 22。这不是 bug，而是"失败会连带减少别人的上下文"的真实体现。 */
  assert.strictEqual(r.injectedTotal, 22);
});

test('分组后发言者数 > groupSize 才分组（边界与 plan 一致）', async () => {
  const { runner } = makeRig();
  const r = await runner.runPlan(panelPlan(9), { task: '议题', round: 1 });
  assert.strictEqual(r.stages.length, 2, '9 人 ≤ 9 → 不分组');
  const r2 = await makeRig().runner.runPlan(panelPlan(8), { task: '议题', round: 1 });
  assert.strictEqual(r2.stages.length, 4, '9 > 8 → 分组（8 人组 + 1 人组）= 2 组内 + 组长 + 归并');
});

/* ═══════════════ ⑧ 阶段提示词注入点（ctx.phasePrompt） ═══════════════ */

test('phasePrompt：每个阶段每个人都被调用一次，且**可以逐人给不同内容**', async () => {
  const { runner, textFor } = makeRig();
  const calls = [];
  const plan = planPhases('build', { participants: NINE, assignment: ASSIGN9 });
  const impl = plan.find((p) => p.name === '分头实现');

  await runner.runStage(impl, {
    task: '议题', round: 1,
    phasePrompt: (stage, pid) => { calls.push(`${stage.name}:${pid}`); return `GUIDE-${pid}`; },
  });

  /* 这是 build 模式能"各写各的文件"的前提：注入回调必须知道当前是谁，
   * 否则"你交 src/util.js"就只能广播给所有人。 */
  assert.ok(calls.includes('分头实现:a') && calls.includes('分头实现:i'), '每个人都要被问到');
  assert.strictEqual(calls.length, impl.speakers.length, '正好每人一次，不多不少');
  assert.ok(textFor('a')[0].includes('GUIDE-a'), 'a 收到自己的说明');
  assert.ok(textFor('i')[0].includes('GUIDE-i'), 'i 收到自己的说明');
  assert.ok(!textFor('a')[0].includes('GUIDE-i'), '★ 逐人不同，不是广播');
});

test('phasePrompt 返回 null/空串 → 不附加任何东西（原文一字不改）', async () => {
  const r1 = await makeRig().runner.runStage(
    { name: '广播', index: 0, speakers: ['a', 'b'], speak: SPEAK.PARALLEL, slice: SLICE.TASK },
    { task: '议题', round: 1 },
  );
  const r2 = await makeRig().runner.runStage(
    { name: '广播', index: 0, speakers: ['a', 'b'], speak: SPEAK.PARALLEL, slice: SLICE.TASK },
    { task: '议题', round: 1, phasePrompt: () => null },
  );
  assert.strictEqual(r2.calls, r1.calls);
  const base = await makeRig();
  await base.runner.runStage(
    { name: '广播', index: 0, speakers: ['a'], speak: SPEAK.PARALLEL, slice: SLICE.TASK },
    { task: '议题', round: 1, phasePrompt: () => '' },
  );
  assert.strictEqual(base.textFor('a')[0].trim(), '议题', '空串附加不该改变文本');
});

test('★ phasePrompt 抛异常不影响会议 —— 收敛为"没有附加内容"', async () => {
  const { runner, textFor } = makeRig();
  const r = await runner.runStage(
    { name: '广播', index: 0, speakers: ['a', 'b'], speak: SPEAK.PARALLEL, slice: SLICE.TASK },
    {
      task: '议题', round: 1,
      phasePrompt: () => { throw new Error('注入器炸了'); },
    },
  );
  assert.strictEqual(r.calls, 2, '一个人都不该因为注入器出错而漏发');
  assert.deepStrictEqual(r.failed, []);
  assert.strictEqual(textFor('a')[0].trim(), '议题', '退化成"没有附加内容"');
});

test('phasePrompt 接收 (stage, providerId)，能按 stage.produces 分流', async () => {
  const { runner } = makeRig();
  const seen = [];
  await runner.runPlan(
    [{ name: '出方案', index: 0, speakers: ['a'], speak: SPEAK.PARALLEL, slice: SLICE.TASK, produces: 'candidate' }],
    {
      task: 't', round: 1,
      phasePrompt: (stage, pid) => { seen.push([stage.produces, pid]); return null; },
    },
  );
  assert.deepStrictEqual(seen, [['candidate', 'a']]);
});

test('dryRun 不调用 phasePrompt（试算不发消息，也就不该产生附加内容）', () => {
  const runner = new PhaseRunner({ speakTo: async () => ({ ok: true }) });
  let called = 0;
  const dry = runner.dryRun(panelPlan(3), {
    task: '议题', messages: [],
    phasePrompt: () => { called += 1; return 'X'; },
  });
  assert.strictEqual(called, 0, '试算阶段不该触达注入器');
  assert.ok(dry.injectedTotal > 0, '试算本身仍然正常');
});
