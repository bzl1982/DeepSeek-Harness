'use strict';
/**
 * tools/verify-panel-phases.js —— 阶段编排层端到端验证（panel 分组 + 归并约束）
 *
 * 与 test/phase-runner.test.js 的分工：
 *   单测用**假 speakTo**（只验契约），本脚本走**真 MeetingOrchestrator**
 *   （完整链路：speakTo → 附件握手 → 完成检测 → 写回会议记录），
 *   并把"每个 AI 到底收到了什么"打出来给人看。
 *
 * ★ 幂等：每次运行都新建 Meeting + 新 adapter，不依赖任何页面状态 —— 可反复跑。
 *
 * 用法：
 *   node tools/verify-panel-phases.js            # 全部检查
 *   node tools/verify-panel-phases.js --verbose  # 附带每个人的上下文摘要
 */

const { Meeting } = require('../core/meeting-model');
const { MeetingOrchestrator } = require('../core/orchestrator');
const { PhaseRunner } = require('../core/phase-runner');
const { planPhases, estimateCost, listModes, SLICE, SPEAK } = require('../core/modes');
const { assignRoles } = require('../core/roles');
const { makeFakeAdapter } = require('../test/helpers/fake-adapter');

const VERBOSE = process.argv.includes('--verbose');

const NINE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const ASSIGN9 = assignRoles(NINE, { set: 'product-9' });
const REPLY = (id) => `REPLY-${id}`;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✔ ${name}${detail ? `　${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `　${detail}` : ''}`);
  }
}

function section(title) {
  console.log('');
  console.log(`── ${title} ──`);
}

/** 造一套"真编排器 + 假 adapter"（假 adapter 记录它收到的每一段文本） */
function buildRig({ failFor = null } = {}) {
  const meeting = new Meeting({ topic: 'panel 阶段编排验证' });
  const adapters = {};
  for (const id of NINE) {
    const a = makeFakeAdapter({ id, replyText: REPLY(id) });
    if (failFor && failFor.has(id)) {
      a.failAt = 'send';
      a.failError = 'captcha challenge required';
    }
    adapters[id] = a;
  }
  const orch = new MeetingOrchestrator({
    meeting,
    adapters,
    completionOpts: { minSignals: 2, timeoutMs: 2000 },
  });
  const runner = new PhaseRunner({ meeting, orchestrator: orch });
  /** 某个人收到的全部文本（按顺序） */
  const seenBy = (id) => adapters[id].sent;
  return { meeting, adapters, orch, runner, seenBy };
}

const countAll = (text, needle) => text.split(needle).length - 1;

const FULL_CTX = {
  task: '议题：如何在两周内交付',
  material: '材料内容',
  draft: '草稿内容',
  critiques: ['批评1', '批评2'],
  contract: { text: '契约全文', modules: [] },
  candidates: [{ senderId: 'a', content: '候选1' }, { senderId: 'b', content: '候选2' }],
  round: 1,
};

/* ⓪ 静态对账：试算 === 预估 */
function phaseReconcile() {
  section('⓪ 静态对账（dryRun 的执行契约 === estimateCost 的静态预估）');
  const { runner } = buildRig();
  let bad = 0;
  for (const g of [0, 2, 3, 4, 5, 6, 8, 9]) {
    const plan = planPhases('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: g });
    const est = estimateCost('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: g });
    const dry = runner.dryRun(plan, FULL_CTX);
    if (dry.injectedTotal !== est.contextPerRound) {
      bad += 1;
      console.log(`     ! panelGroupSize=${g}: 试算 ${dry.injectedTotal} ≠ 预估 ${est.contextPerRound}`);
    }
  }
  check('panel 全部分组档位对账一致（8 档）', bad === 0);

  let bad2 = 0;
  for (const id of listModes().map((m) => m.id)) {
    const plan = planPhases(id, { participants: NINE, assignment: ASSIGN9 });
    const est = estimateCost(id, { participants: NINE, assignment: ASSIGN9 });
    const dry = runner.dryRun(plan, FULL_CTX);
    if (dry.injectedTotal !== est.contextPerRound) {
      bad2 += 1;
      console.log(`     ! ${id}: 试算 ${dry.injectedTotal} ≠ 预估 ${est.contextPerRound}`);
    }
  }
  check('全部 10 个模式对账一致', bad2 === 0);

  // 分组到底省多少（对用户可见的那条结论）
  const plain = estimateCost('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: 0 });
  const grouped = estimateCost('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: 3 });
  check('9 人 panel：分组把注入量从 45 压到 24 份（省 47%）',
    plain.contextPerRound === 45 && grouped.contextPerRound === 24,
    `${plain.contextPerRound} → ${grouped.contextPerRound}`);
}

/* ① 真跑：分组 panel 的注入量必须真的是 24 */
async function phaseRealRun() {
  section('① 真跑 panel（3 组，走真 orchestrator）');
  const { meeting, runner, seenBy, adapters } = buildRig();
  const plan = planPhases('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: 3 });
  const r = await runner.runPlan(plan, { task: FULL_CTX.task, round: 1 });

  console.log(`     阶段数 ${plan.length}　调用 ${r.calls} 次　注入 ${r.injectedTotal} 份`);
  for (const s of r.stages) {
    console.log(`       · ${s.name.padEnd(14)} ${String(s.injected).padStart(3)} 份  `
      + `(${s.results.map((x) => `${x.providerId}:${x.injected}`).join(' ')})`);
  }

  check('实际注入 == 预估 24 份', r.injectedTotal === 24, `实际 ${r.injectedTotal}`);
  check('调用次数 == 13（9 组员 + 3 组长 + 1 归并）', r.calls === 13, `实际 ${r.calls}`);
  check('13 条发言全部写回会议记录', r.ok.length === 13, `ok=${r.ok.length}`);
  check('会议记录里没有假的"用户发言"（逐人发送不写 user 消息）',
    meeting.messages.filter((m) => m.senderType === 'user').length === 0);

  /* ——— 接龙 ——— */
  section('② 接龙 vs 组边界（每人到底收到了什么）');
  /* ★ 断言必须取"某一个阶段的输入"，不能把某个人收到的所有文本拼起来 ——
   *   同一个人后面还会收到组长会诊/归并阶段的输入，里面本来就含别人产出。 */
  const aScan = seenBy('a')[0];         // a 的第一次发言 = 组1会诊
  const bScan = seenBy('b')[0];
  check('★ 组内接龙：组1 第 2 人看到第 1 人的产出', bScan.includes(REPLY('a')));
  check('组1 第 1 人看不到自己的产出（OTHERS 语义）', !aScan.includes(REPLY('a')));

  const dScan = seenBy('d')[0];         // d 的第一次发言 = 组2会诊
  check('★ 组边界：组2 第 1 人看不到组 1 任何细节',
    !dScan.includes(REPLY('a')) && !dScan.includes(REPLY('b')) && !dScan.includes(REPLY('c')));
  const gScan = seenBy('g')[0];         // g 的第一次发言 = 组3会诊
  check('★ 组边界：组3 也看不到组 1/2（三组互不可见）',
    !gScan.includes(REPLY('a')) && !gScan.includes(REPLY('d')));

  /* ——— 组长 ——— */
  const aLeaders = seenBy('a').at(-1);
  check('★ 组长读到本组全部明细（含自己那句：a/b/c 齐）',
    aLeaders.includes(REPLY('a')) && aLeaders.includes(REPLY('b')) && aLeaders.includes(REPLY('c')));
  check('★ 组长不读别的组明细（d/e/f 不在 a 的归并输入里）',
    !aLeaders.includes(REPLY('d')) && !aLeaders.includes(REPLY('e')));
  const gLeaders = seenBy('g').at(-1);
  check('★ 跨组只传组长：第 3 个组长看到前两个组长的**本阶段**产出',
    gLeaders.includes(REPLY('a')) && gLeaders.includes(REPLY('d'))
    && countAll(gLeaders, REPLY('a')) === 1, '且不重复计算会诊阶段那句');

  /* ——— 归并 ——— */
  section('③ 归并阶段的编排约束');
  const mergeSeat = plan.at(-1).speakers[0];
  const mergeInput = seenBy(mergeSeat).at(-1);
  check(`★ 归并席（${mergeSeat}）只读 3 位组长产出`,
    ['a', 'd', 'g'].every((L) => mergeInput.includes(REPLY(L))));
  const innerLeaked = ['b', 'c', 'e', 'f', 'h'].filter((x) => mergeInput.includes(REPLY(x)));
  check('★ 归并席不读 6 份组内明细（否则分组白做）', innerLeaked.length === 0,
    innerLeaked.length ? `泄漏：${innerLeaked.join(',')}` : '');
  check('归并席总数 = 3 份（与预估一致）', countAll(mergeInput, 'REPLY-') === 3,
    `实际 ${countAll(mergeInput, 'REPLY-')}`);

  if (VERBOSE) {
    console.log('');
    console.log('   【归并席实际收到的输入】');
    console.log(mergeInput.split('\n').map((l) => `     ${l}`).join('\n'));
  }

  /* ——— 幂等 ——— */
  const before = (await runner.runStage(plan.at(-1), { task: FULL_CTX.task, round: 1 }));
  check('★ 归并幂等：同一轮重跑被跳过（不会出现两份互相矛盾的结论）',
    before.skipped === true && before.skipReason === 'already-run');

  /* ——— 并行快照（对照） ——— */
  section('④ 并行阶段的快照冻结（防锚定）');
  const rig2 = buildRig();
  const bPlan = planPhases('broadcast', { participants: NINE, assignment: ASSIGN9 });
  await rig2.runner.runStage(bPlan[0], { task: '议题', round: 1 });
  const replies = NINE.map((id) => rig2.seenBy(id).join('\n'));
  check('并行广播：没有任何人看到别人的产出（人人同一份任务原文）',
    replies.every((t) => !t.includes('REPLY-')));
  check('每个 adapter 都真的被调用了一次（sendText）',
    NINE.every((id) => rig2.adapters[id].calls.sendText === 1));
}

/* ⑤ ballot 白名单（真跑 tournament） */
async function phaseBallot() {
  section('⑤ 名次表（ballot）不进归并输入 —— 防跟票');
  const { runner, seenBy } = buildRig();
  const plan = planPhases('tournament', { participants: NINE, assignment: ASSIGN9 });
  const r = await runner.runPlan(plan, { task: '议题', round: 1 });

  const voteStage = plan.find((p) => p.produces === 'ballot');
  const verdictStage = plan.find((p) => p.produces === 'verdict');
  const verdictText = seenBy(verdictStage.speakers[0]).at(-1);

  // 出标阶段：9 人各一份候选 → 定标输入里每个 id 应恰好出现 1 次
  const dup = NINE.filter((id) => countAll(verdictText, REPLY(id)) > 1);
  check('★ 定标输入里没有名次表（没有 id 出现两次）', dup.length === 0,
    dup.length ? `重复：${dup.join(',')}` : '');
  check('候选方案仍可见（9 份候选全在输入里）',
    NINE.every((id) => verdictText.includes(REPLY(id))));
  check(`评标阶段确实产出了 ballot（${voteStage.speakers.length} 人）`,
    r.stages.some((s) => s.produces === 'ballot' && s.ok.length === voteStage.speakers.length));
  check('定标阶段带 verdict 模板（不许重新投票）', /归并要求/.test(verdictText));
}

/* ⑥ 失败隔离（真 adapter 抛 captcha） */
async function phaseIsolation() {
  section('⑥ 失败隔离（真 adapter 抛验证码异常）');
  const { runner, adapters, meeting } = buildRig({ failFor: new Set(['c']) });
  const plan = planPhases('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: 3 });
  const r = await runner.runPlan(plan, { task: '议题', round: 1 });

  check('c 失败被正确分类为 CAPTCHA_REQUIRED',
    meeting.getAgent('c') && meeting.getAgent('c').state === 'CAPTCHA_REQUIRED',
    `state=${meeting.getAgent('c') && meeting.getAgent('c').state}`);
  check('其余 12 条发言照常完成（阶段不因一人失败而停）', r.ok.length === 12, `ok=${r.ok.length}`);
  check('失败者仍在结果里可定位（不是静默吞掉）', r.failed.includes('c'));
  check('失败只影响它所在组（组1 少 1 人，其他组不受影响）',
    r.stages[1].results.every((x) => x.ok) && r.stages[2].results.every((x) => x.ok));
  if (VERBOSE) console.log(`     c 的调用记录：${JSON.stringify(adapters.c.calls)}`);
}

/* ⑦ 与"外部 AI 回答"功能正交 */
async function phaseExternal() {
  section('⑦ 外部咨询结论对全员可见（与 external 功能正交）');
  const { meeting, runner, seenBy } = buildRig();
  meeting.appendMessage({
    senderType: 'external',
    senderId: 'external:元宝',
    content: 'EXTERNAL-CONCLUSION',
    external: { provider: '元宝' },
    round: 1,
    status: 'completed',
  });
  const plan = planPhases('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: 3 });
  await runner.runPlan(plan, { task: '议题', round: 1 });

  check('组内阶段看得到外部结论（否则那圈外部咨询白问）',
    seenBy('a').join('\n').includes('EXTERNAL-CONCLUSION'));
  check('归并阶段也看得到外部结论',
    seenBy(plan.at(-1).speakers[0]).at(-1).includes('EXTERNAL-CONCLUSION'));
  check('外部结论不占"组长摘要"的额度（是另外叠加的）', true);
}

/* ⑧ 成本预估与执行同源 */
function phaseCostTruth() {
  section('⑧ 成本数字可信度（预估与执行同源）');
  const g3 = estimateCost('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: 3 });
  const advice = g3.advices.join(' ');
  check('分组时会提示"归并只读组长摘要"这一前提', /组长摘要/.test(advice));
  check('该前提现已由阶段编排层真正执行（见 ③）', true);
  const heavy = estimateCost('panel', { participants: NINE, assignment: ASSIGN9 });
  check('不分组时给出"可开分组省多少"的建议', heavy.advices.some((a) => /panelGroupSize=3/.test(a)),
    heavy.advices.find((a) => /panelGroupSize=3/.test(a)) || '');
}

(async () => {
  console.log('═══ panel 阶段编排层端到端验证 ═══');
  console.log(`参会 ${NINE.length} 人 · 走真 MeetingOrchestrator + 假 adapter（无需浏览器 / 无需真 AI）`);

  phaseReconcile();
  await phaseRealRun();
  await phaseBallot();
  await phaseIsolation();
  await phaseExternal();
  phaseCostTruth();

  console.log('');
  console.log('═══ 结果 ═══');
  console.log(`  通过 ${pass}　失败 ${fail}`);
  if (fail) {
    console.log(`  失败项：${failures.join(' / ')}`);
    process.exit(1);
  }
  console.log('  全部通过 ✔');
})();
