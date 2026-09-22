'use strict';
/**
 * test/modes.test.js —— 会议模式测试
 *
 * 验证目标（用户需求「各种模式：共同审阅、协助、反复修正」）：
 *   1. 模式注册表自洽（每个模式都有阶段、有终止判据）
 *   2. ★ 共同审阅「先独立后交叉」的顺序正确 —— 第一阶段绝不能看到彼此的意见
 *   3. 席位选择：质证类/建设类/收敛类能正确挑人；挑不到时优雅退化
 *   4. ★ 主持人模式：没点名就不许任何人发言（不能悄悄退化成全员广播）
 *   5. ★ 上下文切片：OTHERS 必须剔除自己（防自我强化）
 *   6. ★ 反复修正的终止判据：无新批评即收敛；有迭代上限兜底
 *   7. ★ 批评文本规范化：换个标点不算新问题（否则永远停不下来）
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  SPEAK, SLICE, MODES, MODE_IDS, getMode, listModes,
  resolveSeat, selectSlice, planPhases, shouldStop, newCritiques,
  bordaMeans, tournamentStop,
} = require('../core/modes');
const { assignRoles } = require('../core/roles');

const WHO = ['a', 'b', 'c'];
const ASSIGN = assignRoles(WHO, { set: 'trio' }); // a=架构师(build) b=红队(challenge) c=主持助理(converge)
// 含集成类席位的编制（用于 build 模式测试）：
// 用 build-7 截断到 3 席 → a=pm(represent) b=user-advocate(represent) c=architect(build)
// 这里构造一个显式包含 integrator 的 assignment 让测试可控
const ASSIGN_BUILD = [
  { providerId: 'a', roleId: 'pm', label: '产品经理', group: 'represent', prompt: '...' },
  { providerId: 'b', roleId: 'architect', label: '架构师', group: 'build', prompt: '...' },
  { providerId: 'c', roleId: 'integrator', label: '集成工程师', group: 'integrate', prompt: '...' },
];

/* ---------------- 注册表 ---------------- */

test('十个模式都在注册表里，且每个都有阶段与终止判据', () => {
  for (const id of ['broadcast', 'review', 'assist', 'iterate', 'debate', 'panel', 'chairman', 'divide', 'tournament', 'build']) {
    const m = getMode(id);
    assert.ok(m, `模式 ${id} 不存在`);
    assert.ok(m.phases.length > 0, `模式 ${id} 没有阶段`);
    assert.ok(m.stopWhen, `模式 ${id} 没有终止判据`);
  }
  assert.strictEqual(MODE_IDS.length, 10);
});

test('★ 每个模式都必须有完整的使用场景（用户需求：先把场景定义清楚）', () => {
  // 「没看懂这个模式」的根因就是只有技术描述、没有使用场景。
  // 这条断言把"场景四要素"变成硬要求，防止以后新增模式时漏写。
  for (const m of listModes()) {
    assert.ok(m.scene, `模式「${m.label}」缺 scene —— 用户会看不懂它什么时候该用`);
    for (const k of ['when', 'example', 'notFor', 'output']) {
      assert.ok(typeof m.scene[k] === 'string' && m.scene[k].length >= 6,
        `模式「${m.label}」的 scene.${k} 缺失或过短`);
    }
    assert.ok(m.modelFit, `模式「${m.label}」缺 modelFit —— 无法回答"这模式该用哪些模型"`);
    assert.ok(m.modelFit.need && Object.keys(m.modelFit.need).length > 0,
      `模式「${m.label}」的 modelFit.need 为空`);
    assert.ok(Array.isArray(m.modelFit.channels) && m.modelFit.channels.length > 0,
      `模式「${m.label}」的 modelFit.channels 为空`);
  }
});

test('listModes 能直接喂给 UI 渲染（含中文名与是否需材料）', () => {
  const list = listModes();
  assert.strictEqual(list.length, 10);
  const review = list.find((m) => m.id === 'review');
  assert.strictEqual(review.label, '共同审阅');
  assert.strictEqual(review.needsMaterial, true);
  const iterate = list.find((m) => m.id === 'iterate');
  assert.strictEqual(iterate.loop, true);
  assert.strictEqual(iterate.needsDraft, true);
  assert.strictEqual(list.find((m) => m.id === 'chairman').requiresChairman, true);
  // chairman 必须声明"需要 API 通道"——否则会被网页版拖到分钟级
  assert.deepStrictEqual(list.find((m) => m.id === 'chairman').modelFit.channels, ['api']);
  // 每个模式都要能给出阶段清单（UI 画流程条用）
  for (const m of list) {
    assert.ok(Array.isArray(m.phaseList) && m.phaseList.length === m.phases,
      `模式「${m.label}」的 phaseList 与 phases 数不一致`);
    assert.ok(m.phaseList.every((p) => p.name && p.speak && p.slice));
  }
});

test('未知模式必须抛错，不能静默返回空（否则会议静默失败）', () => {
  assert.throws(() => planPhases('不存在的模式', { participants: WHO }), /unknown mode/);
  assert.throws(() => shouldStop('不存在的模式', {}), /unknown mode/);
});

/* ---------------- 阶段计划 ---------------- */

test('广播模式：单阶段、全员、并行', () => {
  const plan = planPhases('broadcast', { participants: WHO, assignment: ASSIGN });
  assert.strictEqual(plan.length, 1);
  assert.deepStrictEqual(plan[0].speakers, WHO);
  assert.strictEqual(plan[0].speak, SPEAK.PARALLEL);
  assert.strictEqual(plan[0].slice, SLICE.TASK);
});

test('★ 共同审阅：三阶段，且第一阶段必须是「独立 + 只看材料」（防锚定效应）', () => {
  const plan = planPhases('review', { participants: WHO, assignment: ASSIGN });
  assert.strictEqual(plan.length, 3);

  // 第一阶段：全员并行、只看材料 —— 绝不能看到彼此意见，否则后面的发言会全部向第一个发言者收敛
  assert.strictEqual(plan[0].name, '独立审阅');
  assert.deepStrictEqual(plan[0].speakers, WHO);
  assert.strictEqual(plan[0].speak, SPEAK.PARALLEL);
  assert.strictEqual(plan[0].slice, SLICE.MATERIAL);

  // 第二阶段：只有质证类发言，且看的是别人的意见
  assert.strictEqual(plan[1].name, '交叉质证');
  assert.deepStrictEqual(plan[1].speakers, ['b'], '质证阶段应只有红队（b）发言');
  assert.strictEqual(plan[1].slice, SLICE.OTHERS);

  // 第三阶段：只有收敛类归并，看全部
  assert.strictEqual(plan[2].name, '归并结论');
  assert.deepStrictEqual(plan[2].speakers, ['c']);
  assert.strictEqual(plan[2].slice, SLICE.ALL);
});

test('协助模式：建设类先出方案 → 质证类挑错 → 收敛类收口', () => {
  const plan = planPhases('assist', { participants: WHO, assignment: ASSIGN });
  assert.deepStrictEqual(plan[0].speakers, ['a'], '出方案阶段应由建设类（架构师）发言');
  assert.deepStrictEqual(plan[1].speakers, ['b'], '会诊阶段应由质证类（红队）发言');
  assert.deepStrictEqual(plan[2].speakers, ['c'], '收敛阶段应由收敛类发言');
});

test('★ 反复修正：迭代模式、挑错看草稿、修订看批评清单', () => {
  const plan = planPhases('iterate', { participants: WHO, assignment: ASSIGN });
  assert.strictEqual(plan[0].slice, SLICE.DRAFT, '挑错者必须拿到当前草稿');
  assert.strictEqual(plan[1].slice, SLICE.CRITIQUES, '修订者必须拿到批评清单，而不是重新发挥');
  assert.deepStrictEqual(plan[1].speakers, ['a'], '修订由建设类执行');
  assert.strictEqual(MODES.iterate.loop, true);
  assert.ok(MODES.iterate.maxIterations >= 2, '必须有迭代上限兜底');
});

/* ---------------- 席位解析 ---------------- */

test('席位选择器能按职能挑人', () => {
  assert.deepStrictEqual(resolveSeat('challenge', { participants: WHO, assignment: ASSIGN }).speakers, ['b']);
  assert.deepStrictEqual(resolveSeat('build', { participants: WHO, assignment: ASSIGN }).speakers, ['a']);
  assert.deepStrictEqual(resolveSeat('converge', { participants: WHO, assignment: ASSIGN }).speakers, ['c']);
  assert.deepStrictEqual(resolveSeat('first', { participants: WHO, assignment: ASSIGN }).speakers, ['a']);
  assert.deepStrictEqual(resolveSeat('last', { participants: WHO, assignment: ASSIGN }).speakers, ['c']);
});

test('挑不到职能时优雅退化为全体，并如实标记 degraded（不假装成功）', () => {
  const r = resolveSeat('challenge', { participants: WHO, assignment: [] });
  assert.deepStrictEqual(r.speakers, WHO);
  assert.strictEqual(r.degraded, true);

  const plan = planPhases('review', { participants: WHO, assignment: [] });
  assert.strictEqual(plan[1].degraded, true, '没有角色分化时，质证阶段退化必须被标记出来');
});

test('★ 主席模式：没点名就不许任何人发言（不能悄悄退化成全员广播）', () => {
  const r = resolveSeat('picker', { participants: WHO, assignment: ASSIGN });
  assert.deepStrictEqual(r.speakers, [], '主席未点名 → 无人发言');
  assert.strictEqual(r.degraded, true);

  const picked = resolveSeat('picker', { participants: WHO, assignment: ASSIGN, picked: 'b' });
  assert.deepStrictEqual(picked.speakers, ['b']);
  assert.strictEqual(picked.degraded, false);
});

/* ---------------- 上下文切片 ---------------- */

test('★ OTHERS 切片必须剔除自己说过的话（防自我强化）', () => {
  const messages = [
    { senderId: 'a', content: '我建议用方案一' },
    { senderId: 'b', content: '方案一有问题' },
  ];
  const s = selectSlice(SLICE.OTHERS, { messages, selfId: 'a' });
  assert.doesNotMatch(s.text, /我建议用方案一/, '自己说过的话不该再喂给自己');
  assert.match(s.text, /方案一有问题/);
});

test('ALL 切片包含全部；EMPTY 切片不产生残行', () => {
  const messages = [{ senderId: 'a', content: 'X' }, { senderId: 'b', content: 'Y' }];
  const all = selectSlice(SLICE.ALL, { messages, selfId: 'a' });
  assert.match(all.text, /X/);
  assert.match(all.text, /Y/);

  const none = selectSlice(SLICE.NONE, {});
  assert.strictEqual(none.text, '');
  assert.deepStrictEqual(none.included, []);
});

test('CRITIQUES / DRAFT 切片直接把内容铺开（不加工，避免篡改原意）', () => {
  const c = selectSlice(SLICE.CRITIQUES, { critiques: ['缺少回退方案', '成本被低估'] });
  assert.match(c.text, /缺少回退方案/);
  assert.match(c.text, /成本被低估/);
  assert.deepStrictEqual(c.included, ['critiques']);

  const d = selectSlice(SLICE.DRAFT, { draft: 'v1 草稿正文' });
  assert.match(d.text, /v1 草稿正文/);
});

/* ---------------- 终止判据 ---------------- */

test('★ 反复修正：批评与上轮完全相同 → 判定收敛（不必硬跑满轮数）', () => {
  const r = shouldStop('iterate', {
    iteration: 2,
    critiques: ['缺少回退方案', '成本被低估'],
    prevCritiques: ['缺少回退方案', '成本被低估'],
  });
  assert.strictEqual(r.stop, true);
  assert.match(r.reason, /无新增/);
});

test('★ 反复修正：仍有新批评 → 必须继续修（不许半成品交付）', () => {
  const r = shouldStop('iterate', {
    iteration: 2,
    critiques: ['缺少回退方案', '成本被低估', '还有并发风险'],
    prevCritiques: ['缺少回退方案', '成本被低估'],
  });
  assert.strictEqual(r.stop, false);
  assert.match(r.reason, /1 条新批评/);
});

test('★ 第 1 轮永远不能判收敛（没有对比基线）', () => {
  const r = shouldStop('iterate', { iteration: 1, critiques: [], prevCritiques: [] });
  assert.strictEqual(r.stop, false);
  assert.match(r.reason, /尚无对比基线/);
});

test('★ 迭代上限兜底：即使一直冒新问题，到上限也必须停（防死循环）', () => {
  const r = shouldStop('iterate', {
    iteration: MODES.iterate.maxIterations,
    critiques: ['永远新鲜的问题'],
    prevCritiques: ['别的问题'],
  });
  assert.strictEqual(r.stop, true);
  assert.match(r.reason, /迭代上限/);
});

test('广播模式是单趟：阶段走完即结束，且不依赖任何对比数据', () => {
  const r = shouldStop('broadcast', { iteration: 1 });
  assert.strictEqual(r.stop, true);
  assert.match(r.reason, /单趟模式/);
});

test('主席模式用「无新追问点」收敛', () => {
  assert.strictEqual(shouldStop('chairman', {
    iteration: 2, questions: ['Q1'], prevQuestions: ['Q1'],
  }).stop, true);
  assert.strictEqual(shouldStop('chairman', {
    iteration: 2, questions: ['Q1', 'Q2'], prevQuestions: ['Q1'],
  }).stop, false);
});

/* ---------------- 批评文本规范化 ---------------- */

test('★ 换个标点/空白不算新问题（否则反复修正永远停不下来）', () => {
  const fresh = newCritiques(['缺少回退方案。'], ['缺少回退方案']);
  assert.strictEqual(fresh.length, 0, '仅标点差异必须被规范化掉');
});

test('真实不同的批评必须被识别为新问题', () => {
  const fresh = newCritiques(['并发下会丢消息'], ['缺少回退方案']);
  assert.strictEqual(fresh.length, 1);
  assert.match(fresh[0], /并发下会丢消息/);
});

test('本轮内部的重复批评只算一条', () => {
  const fresh = newCritiques(['同一个问题', '同一个问题'], []);
  assert.strictEqual(fresh.length, 1);
});

test('空字符串/空白批评被忽略（不制造假的新增）', () => {
  const fresh = newCritiques(['', '   ', null], []);
  assert.strictEqual(fresh.length, 0);
});

/* ---------------- 招标评审（tournament）：Q1/Q2/Q3/Q4 的落地 ---------------- */

test('★ 招标评审五阶段：出标→评标→定标→改进→复评，且评标必须并行+看 CANDIDATES（防锚定+防跟票）', () => {
  const plan = planPhases('tournament', { participants: WHO, assignment: ASSIGN });
  assert.strictEqual(plan.length, 5);

  assert.strictEqual(plan[0].name, '出标');
  assert.deepStrictEqual(plan[0].speakers, WHO, '全员出标');
  assert.strictEqual(plan[0].speak, SPEAK.PARALLEL);
  assert.strictEqual(plan[0].slice, SLICE.TASK, '出标只看原始任务（第一份方案也防锚定）');

  /* ★ Q2 的关键修正（第五轮）：评标切片 = CANDIDATES（全部候选 + 匿名 + 定序），
   *   既不是 ALL **也不是 OTHERS**。三条理由（改回 OTHERS 会重新踩坑）：
   *     ① ALL 含自己 → 自我加分（这点某家说对了）；
   *     ② OTHERS 抽掉自己那份 → 每个评审者只排 N-1 份，且各人排除的不是同一份
   *        → 各方案被排次数不等 → Borda 均值分母不同 → **不可横向比较**；
   *     ③ tournament 是 loop 模式，第 2 轮起 OTHERS 会放行"上轮别人的名次表" → **跟票**。
   *   匿名化本身就解决了①（认不出哪份是自己的），且让人人看到同样 N 份同样顺序。 */
  assert.strictEqual(plan[1].name, '评标');
  assert.deepStrictEqual(plan[1].speakers, ['b'], '质证类评标');
  assert.strictEqual(plan[1].speak, SPEAK.PARALLEL, '★ 并行——评审者互不可见评分，否则跟票');
  assert.strictEqual(plan[1].slice, SLICE.CANDIDATES,
    '★ 评标看 CANDIDATES（匿名候选，无评分），不是 ALL（自我加分）也不是 OTHERS（不可比+跨轮跟票）');

  assert.strictEqual(plan[2].name, '定标');
  assert.deepStrictEqual(plan[2].speakers, ['c']);
  assert.strictEqual(plan[2].slice, SLICE.ALL);

  assert.strictEqual(plan[3].name, '改进');
  assert.strictEqual(plan[3].slice, SLICE.CRITIQUES, '改进看批评清单，不是重新发挥');

  assert.strictEqual(plan[4].name, '复评');
  assert.strictEqual(plan[4].slice, SLICE.DRAFT, '复评看改进后的胜出者');
});

test('★ 招标评审是迭代模式，上限 3 轮（比 iterate 的 5 轮更狠——每轮 5 阶段更重）', () => {
  assert.strictEqual(MODES.tournament.loop, true);
  assert.strictEqual(MODES.tournament.maxIterations, 3);
  assert.strictEqual(MODES.tournament.stopWhen, 'same-winner');
});

test('★ Q4 可计算判据：连续两轮定标同一方案 → 收敛', () => {
  const r = shouldStop('tournament', {
    iteration: 2, winnerId: '方案A', prevWinnerId: '方案A',
  });
  assert.strictEqual(r.stop, true);
  assert.match(r.reason, /连续两轮定标同一方案/);
});

test('★ 定标翻转 → 必须继续（不许半成品交付）', () => {
  const r = shouldStop('tournament', {
    iteration: 2, winnerId: '方案B', prevWinnerId: '方案A',
  });
  assert.strictEqual(r.stop, false);
  assert.match(r.reason, /定标翻转/);
});

test('★ 第 1 轮永不收敛（没有基线）', () => {
  const r = shouldStop('tournament', { iteration: 1, winnerId: '方案A', prevWinnerId: null });
  assert.strictEqual(r.stop, false);
  assert.match(r.reason, /尚无对比基线/);
});

test('★ 迭代上限兜底：第 3 轮必停（即使定标还在翻转）', () => {
  const r = shouldStop('tournament', {
    iteration: MODES.tournament.maxIterations, winnerId: '方案B', prevWinnerId: '方案A',
  });
  assert.strictEqual(r.stop, true);
  assert.match(r.reason, /迭代上限/);
});

/* ---------------- Q3：Borda 名次聚合（不用分数、不用 pairwise） ---------------- */

test('★ Borda：多评审者名次取均值，均值最低者胜', () => {
  const ballots = [
    { reviewer: 'r1', ranks: [{ proposal: 'A', rank: 1 }, { proposal: 'B', rank: 2 }, { proposal: 'C', rank: 3 }] },
    { reviewer: 'r2', ranks: [{ proposal: 'B', rank: 1 }, { proposal: 'A', rank: 2 }, { proposal: 'C', rank: 3 }] },
    // r3 只排了 A 和 B（对 C 无意见）
    { reviewer: 'r3', ranks: [{ proposal: 'A', rank: 1 }, { proposal: 'B', rank: 2 }] },
  ];
  const r = bordaMeans(ballots);
  // A: (1+2+1)/3 = 1.33 ; B: (2+1+2)/3 = 1.67 ; C: (3+3)/2 = 3
  assert.strictEqual(r.winnerId, 'A', 'A 名次均值最低 → 胜出');
  assert.strictEqual(r.runnerUpId, 'B');
  assert.ok(r.means.A < r.means.B && r.means.B < r.means.C, '均值必须单调');
  assert.deepStrictEqual(r.ballots.A.map((x) => x.reviewer).sort(), ['r1', 'r2', 'r3']);
});

test('Borda：无人参与评定的方案不参与投票（不污染均值）', () => {
  const r = bordaMeans([
    { reviewer: 'r1', ranks: [{ proposal: 'X', rank: 1 }] },
    { reviewer: 'r2', ranks: [] }, // 弃权
  ]);
  assert.strictEqual(r.winnerId, 'X');
  assert.strictEqual(r.runnerUpId, null, '只有一个候选就没有备选');
});

test('Borda：空投票表安全返回（不炸）', () => {
  const r = bordaMeans([]);
  assert.strictEqual(r.winnerId, null);
  assert.strictEqual(r.runnerUpId, null);
});

test('★ 为什么不用分数：Borda 对"尺度差异"免疫（一个给 1-5，一个给 1-10，名次仍可比）', () => {
  // 模拟：评审者 r1 用 1-3 尺度，r2 用 1-10 尺度，但排序意图相同
  const ballots = [
    { reviewer: 'r1', ranks: [{ proposal: 'A', rank: 1 }, { proposal: 'B', rank: 3 }] },
    { reviewer: 'r2', ranks: [{ proposal: 'A', rank: 2 }, { proposal: 'B', rank: 9 }] },
  ];
  const r = bordaMeans(ballots);
  assert.strictEqual(r.winnerId, 'A', '名次是相对量，尺度不同不影响"谁在前"的判定');
});

/* ---------------- Q5/Q6/Q9：工程交付 build 模式 + CONTRACT 切片 + integrator 席位 ---------------- */

test('★ 工程交付六阶段，且"冻结契约"由架构师写、"分头实现"用 CONTRACT 切片', () => {
  const plan = planPhases('build', { participants: WHO, assignment: ASSIGN_BUILD });
  assert.strictEqual(plan.length, 6);

  assert.strictEqual(plan[0].name, '需求澄清');
  assert.deepStrictEqual(plan[0].speakers, ['a'], '代表类先澄清需求');

  assert.strictEqual(plan[1].name, '架构设计');
  assert.deepStrictEqual(plan[1].speakers, ['b'], '架构师设计模块');

  // ★ 草案 B 的 bug 修正：冻结契约的 seat 是 architect（build 类），不是 converge
  //   （收敛类互斥约束是"禁止引入新观点"，让它写契约会自相矛盾）
  assert.strictEqual(plan[2].name, '冻结契约');
  assert.deepStrictEqual(plan[2].speakers, ['b'], '★ 契约归架构师写，不是收敛类');
  assert.strictEqual(plan[2].slice, SLICE.ALL);

  // ★ Q6：分头实现切片必须是 CONTRACT（契约全文 + 自己模块 + 同伴签名）
  assert.strictEqual(plan[3].name, '分头实现');
  assert.deepStrictEqual(plan[3].speakers, WHO, '全员并行实现');
  assert.strictEqual(plan[3].speak, SPEAK.PARALLEL);
  assert.strictEqual(plan[3].slice, SLICE.CONTRACT, '★ 执行者看到契约，不是裸 TASK');

  // ★ Q9：集成验证由 integrator（集成类）做，不是 chair-assistant
  assert.strictEqual(plan[4].name, '集成验证');
  assert.deepStrictEqual(plan[4].speakers, ['c'], '★ 集成类席位（integrator）验证');
  assert.strictEqual(plan[4].slice, SLICE.ALL);

  assert.strictEqual(plan[5].name, '修复');
  assert.strictEqual(plan[5].slice, SLICE.CRITIQUES, '修复看集成者报的"哪里断了"清单');
});

test('★ integrator 席位能被正确解析（新增的"集成类"）', () => {
  const r = resolveSeat('integrator', { participants: WHO, assignment: ASSIGN_BUILD });
  assert.deepStrictEqual(r.speakers, ['c'], '集成类席位 = integrator 角色所在 provider');
  assert.strictEqual(r.degraded, false);
});

test('★ CONTRACT 切片：执行者看到契约全文 + 自己模块 + 同伴签名（不给别人实现）', () => {
  const contract = {
    text: '【接口契约】\nTaskQueue: enqueue(t: Task) → ok; drain() → Task[]\nStorage: save(id, data) → ok',
    modules: [
      { owner: 'a', module: 'queue.js', signature: 'enqueue(t) / drain()' },
      { owner: 'b', module: 'storage.js', signature: 'save(id, data) / load(id)' },
    ],
  };
  // 执行者是 a（负责 queue.js）
  const s = selectSlice(SLICE.CONTRACT, { selfId: 'a', contract });
  assert.match(s.text, /接口契约/, '契约全文在场');
  assert.match(s.text, /你负责的模块/);
  assert.match(s.text, /queue.js/, '自己的模块名在场');
  assert.match(s.text, /同伴模块/, '同伴签名区在场');
  assert.match(s.text, /storage\.js/, '同伴模块名在场');
  assert.doesNotMatch(s.text, /b 的实现细节/, '★ 不给别人的实现细节（只给签名）');

  // 执行者是 b（负责 storage.js）
  const s2 = selectSlice(SLICE.CONTRACT, { selfId: 'b', contract });
  assert.match(s2.text, /你负责的模块/);
  assert.match(s2.text, /storage\.js/, '★ 自己模块识别正确');
  assert.match(s2.text, /queue\.js/, '同伴模块也在场');
});

test('★ CONTRACT 切片：无契约时优雅降级（只给任务，不炸）', () => {
  const s = selectSlice(SLICE.CONTRACT, { selfId: 'a', contract: null });
  assert.strictEqual(s.included.length, 0, '没有契约不该谎报 included');
});

test('★ build 模式必须走 API 通道（网页版 webview 不能落盘/编译）', () => {
  const m = getMode('build'); // listModes 不透传自定义字段，要用 getMode
  assert.deepStrictEqual(m.modelFit.channels, ['api'], '工程交付要求 API 通道');
  assert.strictEqual(m.modelFit.requiresApi, true, 'UI 必须提示"此模式需 API 席位"');
});

test('★ build 模式终止：集成通过即停；未通过进修复回路（受 4 轮上限兜底）', () => {
  assert.strictEqual(shouldStop('build', { iteration: 1, buildPass: true }).stop, true);
  assert.strictEqual(shouldStop('build', { iteration: 1, buildPass: false }).stop, false);
  assert.match(shouldStop('build', { iteration: 1, buildPass: false }).reason, /修复回路/);
  // 迭代上限兜底
  const maxR = shouldStop('build', { iteration: MODES.build.maxIterations, buildPass: false });
  assert.strictEqual(maxR.stop, true, '★ 即使集成一直失败，到上限也必须停');
});

test('★ 修复回路归原作者（seat: all 并行，不是 integrator 独修）', () => {
  const plan = planPhases('build', { participants: WHO, assignment: ASSIGN_BUILD });
  assert.deepStrictEqual(plan[5].speakers, WHO, '修复 = 全员（各模块原作者）并行修，不是集成者');
});


