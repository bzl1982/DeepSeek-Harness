/**
 * 第五轮落地验证：候选匿名化（CANDIDATES 切片）+ 名次表解析 + 成本估算
 *
 * 这三件事对应五个外部反馈里最高优先级的三条：
 *   ① 评标必须**匿名 + 定序**（防自我加分 / 防跨轮跟票 / 保证 Borda 可比）
 *   ② 名次表必须有**解析层**（否则 bordaMeans 永远是孤儿代码）
 *   ③ 必须补**成本维度**（用户原话："在那里瞎聊浪费 TOKEN 就没意思了"）
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  SLICE, SPEAK, MODES, MODE_IDS,
  selectSlice, anonymizeCandidates, anonLabel, fnv1a,
  parseBallots, bordaMeans, estimateCost, costOverview,
  shouldStop, tournamentStop, planPhases, listModes,
  judgeBuildPass, buildVerdictPrompt,
} = require('../core/modes');

/* ══════════════════════════════════════════════════════════════════
   一、匿名化：标签生成 + 确定性定序 + 与作者无关
   ══════════════════════════════════════════════════════════════════ */

test('匿名标签：0→方案A、25→方案Z、26→方案AA（够任何会议用）', () => {
  assert.strictEqual(anonLabel(0), '方案A');
  assert.strictEqual(anonLabel(1), '方案B');
  assert.strictEqual(anonLabel(25), '方案Z');
  assert.strictEqual(anonLabel(26), '方案AA');
  assert.strictEqual(anonLabel(27), '方案AB');
});

test('内容哈希稳定：同内容同哈希（这是"顺序确定性"的地基）', () => {
  assert.strictEqual(fnv1a('微服务架构方案'), fnv1a('微服务架构方案'));
  assert.notStrictEqual(fnv1a('方案甲'), fnv1a('方案乙'));
  assert.strictEqual(typeof fnv1a(''), 'number');
});

test('★ 匿名化是确定性的：输入乱序 → 输出顺序与标签完全一致', () => {
  const c1 = { senderId: 'deepseek-web', content: '方案一：模块化单体' };
  const c2 = { senderId: 'gemini-web', content: '方案二：微服务拆分' };
  const c3 = { senderId: 'chatgpt-web', content: '方案三：事件驱动' };

  const a = anonymizeCandidates([c1, c2, c3]);
  const b = anonymizeCandidates([c3, c1, c2]);
  const c = anonymizeCandidates([c2, c3, c1]);

  assert.deepStrictEqual(a.order, b.order, '输入顺序不同，标签顺序必须相同');
  assert.deepStrictEqual(b.order, c.order);
  assert.deepStrictEqual(a.items.map((i) => i.label), ['方案A', '方案B', '方案C']);
  assert.deepStrictEqual(a.items.map((i) => i.content), b.items.map((i) => i.content));
});

test('★ 匿名化与"谁写的"无关：同一内容换个人写，标签不变', () => {
  const x = anonymizeCandidates([
    { senderId: 'deepseek-web', content: 'A 内容' },
    { senderId: 'gemini-web', content: 'B 内容' },
  ]);
  const y = anonymizeCandidates([
    { senderId: 'kimi-web', content: 'A 内容' },   // 作者换了
    { senderId: 'yiyan-web', content: 'B 内容' },
  ]);
  const labelOf = (r, content) => r.items.find((i) => i.content === content).label;
  assert.strictEqual(labelOf(x, 'A 内容'), labelOf(y, 'A 内容'));
  assert.strictEqual(labelOf(x, 'B 内容'), labelOf(y, 'B 内容'));
  // 且标签无法反推作者（map 是唯一出口，只在审计用）
  assert.strictEqual(x.map['方案A'], 'deepseek-web');
});

test('匿名化过滤空内容（空方案不占标签位）', () => {
  const r = anonymizeCandidates([
    { senderId: 'a', content: '有效方案' },
    { senderId: 'b', content: '   ' },
    { senderId: 'c', content: '' },
  ]);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].label, '方案A');
});

/* ══════════════════════════════════════════════════════════════════
   二、CANDIDATES 切片：评标为什么不能用 OTHERS（本轮最关键的分歧判断）
   ══════════════════════════════════════════════════════════════════ */

const CANDS = [
  { senderId: 'deepseek-web', content: '方案甲：先做单体再拆', kind: 'candidate' },
  { senderId: 'gemini-web', content: '方案乙：直接微服务', kind: 'candidate' },
  { senderId: 'chatgpt-web', content: '方案丙：事件驱动', kind: 'candidate' },
];

test('★ CANDIDATES 对**所有评审者**给出完全相同的文本（Borda 可聚合的前提）', () => {
  const asReviewer1 = selectSlice(SLICE.CANDIDATES, { messages: CANDS, selfId: 'deepseek-web' });
  const asReviewer2 = selectSlice(SLICE.CANDIDATES, { messages: CANDS, selfId: 'gemini-web' });
  const asReviewer3 = selectSlice(SLICE.CANDIDATES, { messages: CANDS, selfId: 'chatgpt-web' });

  assert.strictEqual(asReviewer1.text, asReviewer2.text, '不同评审者必须看到同一份候选包');
  assert.strictEqual(asReviewer2.text, asReviewer3.text);
  assert.deepStrictEqual(asReviewer1.included, ['方案A', '方案B', '方案C']);
});

test('★ 对照组：OTHERS 会让各评审者看到**不同**的集合（这正是不能用它的原因）', () => {
  const r1 = selectSlice(SLICE.OTHERS, { messages: CANDS, selfId: 'deepseek-web' });
  const r2 = selectSlice(SLICE.OTHERS, { messages: CANDS, selfId: 'gemini-web' });

  assert.notStrictEqual(r1.text, r2.text, 'OTHERS 下每人排除的不是同一份 → 集合不同');
  // 每人只看到 N-1 份 → Borda 均值分母不同 → 不可横向比较
  assert.ok(r1.text.includes('方案乙') && r1.text.includes('方案丙'));
  assert.ok(!r1.text.includes('方案甲'), '抽掉了自己的那份');
  assert.ok(r2.text.includes('方案甲') && !r2.text.includes('方案乙'));
  // ★ 关键：两人看到的消息条数相同（都被抽掉 1 份），但**集合不同** ——
  //   这正是 Borda 无法聚合的根源：`方案甲` 在 r1 眼里不存在，在 r2 眼里存在，
  //   于是各方案被排次数不等、分母不同，均值不能横向比较。
  assert.strictEqual(r1.text.split('\n').length, r2.text.split('\n').length, '条数相同');
  assert.notStrictEqual(r1.text, r2.text, '但内容集合不同');
});

test('★ CANDIDATES 不含评分/名次：跨轮也看不到别人的评标结果（防跟票）', () => {
  const withScores = [
    ...CANDS,
    { senderId: 'converge-1', content: '我的排名是：方案甲第1、方案乙第2', kind: 'review' },
    { senderId: 'converge-2', content: '定标结果：方案甲胜出', kind: 'verdict' },
  ];
  const sl = selectSlice(SLICE.CANDIDATES, { messages: withScores, selfId: 'gemini-web' });
  assert.ok(!sl.text.includes('第1'), '别人的评分不能出现在候选包里（否则第 2 轮起会跟票）');
  assert.ok(!sl.text.includes('定标'), '别人的定标结论也不能出现');
  assert.strictEqual(sl.included.length, 3);
});

test('CANDIDATES 无候选时给出空文本 + 显式告警（不静默）', () => {
  const sl = selectSlice(SLICE.CANDIDATES, { messages: [{ senderId: 'a', content: '闲聊' }] });
  assert.strictEqual(sl.text, '');
  assert.deepStrictEqual(sl.included, []);
  assert.ok(sl.warning && sl.warning.includes('candidate'), '必须告警：候选消息没打标记');
});

test('CANDIDATES 的 map 只用于审计（能把 方案A 映射回真实作者）', () => {
  const sl = selectSlice(SLICE.CANDIDATES, { messages: CANDS, selfId: null });
  assert.strictEqual(Object.keys(sl.map).length, 3);
  const authors = Object.values(sl.map).sort();
  assert.deepStrictEqual(authors, ['chatgpt-web', 'deepseek-web', 'gemini-web']);
  assert.ok(!sl.text.includes('deepseek-web'), 'prompt 里绝不能出现真实名字');
});

test('tournament 的评标阶段用的就是 CANDIDATES（端到端确认，防改回去）', () => {
  const plan = planPhases('tournament', { participants: ['a', 'b', 'c'], assignment: [] });
  const review = plan.find((p) => p.name === '评标');
  assert.strictEqual(review.slice, SLICE.CANDIDATES);
  assert.strictEqual(review.speak, SPEAK.PARALLEL, '必须并行：看到彼此评分就会跟票');
});

/* ══════════════════════════════════════════════════════════════════
   三、名次表解析：AI 自然语言 → 结构化（原"贯通性缺口"的解析层）
   ══════════════════════════════════════════════════════════════════ */

const LABELS = ['方案A', '方案B', '方案C'];

test('解析① JSON 对象格式 {"方案A":1,...}', () => {
  const r = parseBallots([{ reviewer: 'r1', text: '我的排序是 {"方案A": 1, "方案B": 2, "方案C": 3}' }], { labels: LABELS });
  assert.strictEqual(r.ballots.length, 1);
  assert.deepStrictEqual(r.ballots[0].ranks.sort((a, b) => a.rank - b.rank).map((x) => x.proposal),
    ['方案A', '方案B', '方案C']);
  assert.deepStrictEqual(r.failed, []);
});

test('解析② JSON 数组格式 [{"proposal":...,"rank":...}]', () => {
  const r = parseBallots([{
    reviewer: 'r1',
    text: '```json\n[{"proposal":"方案B","rank":1},{"proposal":"方案A","rank":2},{"proposal":"方案C","rank":3}]\n```',
  }], { labels: LABELS });
  assert.strictEqual(r.ballots.length, 1);
  assert.strictEqual(r.ballots[0].ranks.find((x) => x.proposal === '方案B').rank, 1);
});

test('解析③ 列表格式 `1. 方案A`', () => {
  const r = parseBallots([{
    reviewer: 'r1', text: '1. 方案C\n2. 方案A\n3. 方案B',
  }], { labels: LABELS });
  assert.strictEqual(r.ballots.length, 1);
  const m = Object.fromEntries(r.ballots[0].ranks.map((x) => [x.proposal, x.rank]));
  assert.deepStrictEqual(m, { 方案C: 1, 方案A: 2, 方案B: 3 });
});

test('解析④ 后缀格式 `方案A 第2名` / `方案A：3`', () => {
  const r = parseBallots([{
    reviewer: 'r1', text: '方案A 第 2 名；方案B：1；方案C = 3',
  }], { labels: LABELS });
  const m = Object.fromEntries(r.ballots[0].ranks.map((x) => [x.proposal, x.rank]));
  assert.deepStrictEqual(m, { 方案A: 2, 方案B: 1, 方案C: 3 });
});

test('解析⑤ 表格行 `| 方案A | 1 |`（标签与数字被分隔符切开）', () => {
  const r = parseBallots([{
    reviewer: 'r1',
    text: '| 方案 | 名次 |\n| 方案A | 3 |\n| 方案B | 1 |\n| 方案C | 2 |',
  }], { labels: LABELS });
  assert.strictEqual(r.ballots.length, 1, '表格必须能解析');
  const m = Object.fromEntries(r.ballots[0].ranks.map((x) => [x.proposal, x.rank]));
  assert.deepStrictEqual(m, { 方案A: 3, 方案B: 1, 方案C: 2 });
});

test('解析⑥ 一行多标签（逗号分隔）', () => {
  const r = parseBallots([{
    reviewer: 'r1', text: '方案C 第1，方案A 第2，方案B 第3',
  }], { labels: LABELS });
  const m = Object.fromEntries(r.ballots[0].ranks.map((x) => [x.proposal, x.rank]));
  assert.deepStrictEqual(m, { 方案C: 1, 方案A: 2, 方案B: 3 });
});

test('★ 防幻觉：提到不存在的方案会被忽略并告警（不猜、不编）', () => {
  const r = parseBallots([{
    reviewer: 'r1',
    text: '{"方案A": 1, "方案B": 2, "方案C": 3, "方案Z": 4}',
  }], { labels: LABELS });
  assert.ok(!r.ballots[0].ranks.some((x) => x.proposal === '方案Z'), '非法标签必须被丢弃');
  assert.ok(r.warnings.some((w) => w.includes('方案Z')), '必须告警说明忽略了什么');
});

test('★ 解析失败 → 计入 failed，绝不瞎猜（宁可少一票）', () => {
  const r = parseBallots([{ reviewer: 'r-bad', text: '我觉得都挺好的，各有千秋。' }], { labels: LABELS });
  assert.strictEqual(r.ballots.length, 0);
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].reviewer, 'r-bad');
  assert.ok(r.failed[0].reason.includes('作废'));
});

test('★ 漏排会告警并体现在 coverage（这是识别"不完整排序"的信号）', () => {
  const r = parseBallots([
    { reviewer: 'r1', text: '{"方案A": 1, "方案B": 2}' }, // 漏了方案C
    { reviewer: 'r2', text: '{"方案A": 2, "方案B": 1, "方案C": 3}' },
  ], { labels: LABELS });
  assert.strictEqual(r.ballots.length, 2);
  assert.ok(r.warnings.some((w) => w.includes('漏排')), '漏排必须告警');
  assert.strictEqual(r.coverage['方案A'], 2);
  assert.strictEqual(r.coverage['方案C'], 1, '方案C 只被 1 人排 → coverage 不等');
});

/* ══════════════════════════════════════════════════════════════════
   四、Borda 可比性：不完整排序必须被显式标记（不静默给错结论）
   ══════════════════════════════════════════════════════════════════ */

test('Borda：完整排序 → comparable=true，无告警', () => {
  const r = bordaMeans([
    { reviewer: 'r1', ranks: [{ proposal: 'A', rank: 1 }, { proposal: 'B', rank: 2 }] },
    { reviewer: 'r2', ranks: [{ proposal: 'A', rank: 1 }, { proposal: 'B', rank: 2 }] },
  ]);
  assert.strictEqual(r.comparable, true);
  assert.strictEqual(r.warning, null);
  assert.strictEqual(r.winnerId, 'A');
  assert.strictEqual(r.reviewers, 2);
});

test('★ Borda：不完整排序 → comparable=false 并给出可读告警（不假装结论可信）', () => {
  const r = bordaMeans([
    { reviewer: 'r1', ranks: [{ proposal: 'A', rank: 1 }, { proposal: 'B', rank: 2 }] },
    { reviewer: 'r2', ranks: [{ proposal: 'B', rank: 1 }] }, // 漏了 A
  ]);
  assert.strictEqual(r.comparable, false);
  assert.ok(r.warning.includes('不完整'), '必须显式说明不可比');
  assert.ok(r.warning.includes('1~2'), '应给出被排次数区间');
});

test('★ 端到端：评标文本 → parseBallots → bordaMeans → 定标结果', () => {
  const reviews = [
    { reviewer: 'b', text: '{"方案A": 2, "方案B": 1, "方案C": 3}' },
    { reviewer: 'c', text: '1. 方案B\n2. 方案A\n3. 方案C' },
    { reviewer: 'd', text: '方案B 第1，方案C 第2，方案A 第3' },
  ];
  const parsed = parseBallots(reviews, { labels: LABELS });
  assert.strictEqual(parsed.ballots.length, 3, '三份名次表都要解析出来');
  assert.deepStrictEqual(parsed.failed, []);
  assert.strictEqual(parsed.coverage['方案A'], 3);
  assert.strictEqual(parsed.coverage['方案B'], 3, '完整排序 → coverage 相等');

  const borda = bordaMeans(parsed.ballots);
  assert.strictEqual(borda.comparable, true);
  assert.strictEqual(borda.winnerId, '方案B', 'B 均值 (1+1+1)/3=1 最低');
  assert.strictEqual(borda.runnerUpId, '方案A');
  // ★ 定标结果来自代码计算，不是 AI 拍板 —— 可复现
  assert.strictEqual(bordaMeans(parsed.ballots).winnerId, borda.winnerId);
});

test('★ 判据接线：same-winner 缺 winnerId 时必须显式降级告警（不再静默失效）', () => {
  const r = shouldStop('tournament', { iteration: 2 });
  assert.strictEqual(r.stop, false);
  assert.strictEqual(r.degraded, true, '缺输入必须标记为降级，而不是假装"还没收敛"');
  assert.deepStrictEqual(r.missingInput, ['winnerId']);
  assert.ok(r.reason.includes('缺输入'));
});

test('★ 判据接线：build-pass 缺 buildPass 时必须显式降级告警', () => {
  const r = shouldStop('build', { iteration: 2 });
  assert.strictEqual(r.degraded, true);
  assert.deepStrictEqual(r.missingInput, ['buildPass']);
});

test('判据接线：参数给全时判据真的生效（这才是"智能够停"）', () => {
  const stop = shouldStop('tournament', { iteration: 2, winnerId: '方案A', prevWinnerId: '方案A' });
  assert.strictEqual(stop.stop, true);
  assert.strictEqual(stop.degraded, undefined);
  const go = shouldStop('tournament', { iteration: 2, winnerId: '方案B', prevWinnerId: '方案A' });
  assert.strictEqual(go.stop, false);
  assert.ok(go.reason.includes('翻转'));
});

/* ══════════════════════════════════════════════════════════════════
   五、成本维度（用户核心痛点："别瞎聊浪费 token"）
   ══════════════════════════════════════════════════════════════════ */

test('★ 成本估算：panel 9 人的 O(N²) 被算出来（会诊注入 36 份）', () => {
  const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const c = estimateCost('panel', { participants: nine });
  const diagnose = c.breakdown.find((b) => b.phase.includes('会诊'));
  assert.strictEqual(diagnose.inject, 36, '9 人接龙：0+1+...+8 = 36');
  assert.strictEqual(c.tier, 'heavy');
  assert.ok(c.advices.some((a) => a.includes('分组')), '贵的时候必须给降本建议');
});

test('★ 分组降本：组间隔离后，「会诊」注入 36→9（每组都从 0 开始，不跨组累积）', () => {
  const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const g = estimateCost('panel', { participants: nine, panelGroupSize: 3 });
  const inner = g.breakdown.filter((b) => b.phase.includes('会诊（'));
  assert.strictEqual(inner.length, 3);
  for (const grp of inner) {
    assert.strictEqual(grp.inject, 3, `${grp.phase} 应只读组内前 2 份（3 份注入），不得算上别的组的产出`);
    assert.ok(grp.note.includes('组间不可见'));
  }
  // 总量必须真的下降，否则"降本"是假的
  const raw = estimateCost('panel', { participants: nine });
  assert.ok(g.contextPerRound < raw.contextPerRound,
    `分组后总注入必须下降：${raw.contextPerRound} → ${g.contextPerRound}`);
});

test('★ 分组收益是有前提的：必须告警"归并阶段只读组长摘要"', () => {
  const c = estimateCost('panel', { participants: ['a', 'b', 'c', 'd', 'e', 'f'], panelGroupSize: 3 });
  assert.ok(c.advices.some((a) => a.includes('组长摘要') && a.includes('前提')),
    '不写这条前提，编排层照旧注入全部 messages，分组就白做了');
});

test('★ picker 阶段（主席点名）不能算成 0 次调用（会被误读为免费）', () => {
  const c = estimateCost('chairman', { participants: ['a', 'b', 'c', 'd', 'e'] });
  assert.ok(c.maxCalls > 0, 'chairman 必须有调用数（按预估人数算）');
  assert.ok(c.breakdown[0].estimated, '应标记这是预估值（实际由主持人点名决定）');
  assert.ok(c.breakdown[0].note.includes('预估'));
});

test('成本档位：轻/中/重三档可区分，且循环模式算的是最坏情况', () => {
  const light = estimateCost('broadcast', { participants: ['a', 'b', 'c'] });
  assert.strictEqual(light.tier, 'light');
  assert.strictEqual(light.rounds, 1);
  const heavy = estimateCost('build', { participants: ['a', 'b', 'c', 'd', 'e'] });
  assert.strictEqual(heavy.tier, 'heavy');
  assert.ok(heavy.maxCalls > heavy.callsPerRound, '循环模式 maxCalls 应 = 单轮 × 轮数');
  assert.strictEqual(heavy.worstCase, true);
});

test('costOverview 覆盖全部模式，且每个模式都有档位', () => {
  const rows = costOverview();
  assert.strictEqual(rows.length, MODE_IDS.length);
  for (const r of rows) {
    assert.ok(['light', 'medium', 'heavy'].includes(r.tier), `${r.id} 缺档位`);
    assert.ok(Number.isFinite(r.maxCalls));
  }
});

test('★ 成本建议文本里绝不能出现 undefined/NaN（曾把 worst.phase 写成 worst.name）', () => {
  const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  for (const mode of MODE_IDS) {
    for (const N of [['a', 'b', 'c'], nine]) {
      const c = estimateCost(mode, { participants: N });
      for (const a of c.advices) {
        assert.ok(!a.includes('undefined'), `${mode} 的建议里出现 undefined：${a}`);
        assert.ok(!a.includes('NaN'), `${mode} 的建议里出现 NaN：${a}`);
      }
      for (const b of c.breakdown) {
        assert.ok(typeof b.phase === 'string' && b.phase.length > 0, `${mode} 阶段名缺失`);
        assert.ok(Number.isFinite(b.inject), `${mode}/${b.phase} inject 不是数字`);
        assert.ok(!String(b.note).includes('undefined'), `${mode}/${b.phase} note 含 undefined`);
      }
    }
  }
});

test('★ 成本建议要能指出"贵在哪一段"（点名最贵的那个阶段，不是笼统说贵）', () => {
  const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  for (const id of ['panel', 'debate', 'review']) {
    const c = estimateCost(id, { participants: nine });
    const heaviest = c.breakdown.reduce((a, b) => (b.inject > a.inject ? b : a), c.breakdown[0]);
    if (heaviest.inject < 12) continue; // 不贵就不给建议，跳过
    const first = c.advices[0];
    assert.ok(first.includes(heaviest.inject) || first.includes(heaviest.phase),
      `${id} 的建议应点名最重的阶段「${heaviest.phase}」(${heaviest.inject} 份)，实际：${first}`);
    assert.ok(!first.includes('undefined'));
  }
});

test('★ 实测发现：panel 的真正大头是「归并结论」而非「会诊」（我们的直觉都错了）', () => {
  const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const c = estimateCost('panel', { participants: nine });
  const chain = c.breakdown.find((b) => b.phase.includes('会诊'));
  const merge = c.breakdown.find((b) => b.phase.includes('归并'));
  assert.strictEqual(chain.inject, 36, '会诊：9 人接龙 = 0+1+…+8');
  assert.strictEqual(merge.inject, 117, '归并：9 人 × 已积累 9 份 + 组内 36');
  assert.ok(merge.inject > chain.inject * 3,
    '归并阶段才是主要开销 —— 所以"只分组会诊"省得有限，必须同时约束归并阶段的可见消息');
});

test('listModes 带上成本字段（UI 能在下拉旁标"轻/中/重"）', () => {
  const modes = listModes();
  for (const m of modes) {
    assert.ok(['light', 'medium', 'heavy'].includes(m.costTier), `${m.id} 缺 costTier`);
    assert.ok(Number.isFinite(m.maxCalls));
    assert.ok(typeof m.costNote === 'string' && m.costNote.length > 0);
  }
});

/* ══════════════════════════════════════════════════════════════════
   六、chairman 真 bug 修复 + 防再次退化的结构性断言
   ══════════════════════════════════════════════════════════════════ */

test('★ chairman 必须有 loop 与 maxIterations（原缺 loop → "每轮追问"从未生效）', () => {
  assert.strictEqual(MODES.chairman.loop, true, '没有 loop，执行层 maxIter 恒为 1，只跑一轮');
  assert.ok(MODES.chairman.maxIterations >= 2, '必须有上限，否则是真成本黑洞');
  assert.strictEqual(MODES.chairman.stopWhen, 'no-new-question');
});

test('★ chairman 的判据真的能被用上（第 2 轮无新问题 → 停）', () => {
  const q = ['为什么不用现成方案？', '成本到底多少？'];
  const r1 = shouldStop('chairman', { iteration: 1, questions: q, prevQuestions: [] });
  assert.strictEqual(r1.stop, false, '第 1 轮无基线，不判停');

  const same = shouldStop('chairman', { iteration: 2, questions: q, prevQuestions: q });
  assert.strictEqual(same.stop, true, '无新问题 → 收敛（这条在修 loop 之前是死代码）');

  const fresh = shouldStop('chairman', {
    iteration: 2, questions: [...q, '还有个新问题'], prevQuestions: q,
  });
  assert.strictEqual(fresh.stop, false, '仍有新问题 → 继续追问');
});

test('★ 结构防退化：所有循环模式都必须有 maxIterations（否则成本不可预测）', () => {
  for (const id of MODE_IDS) {
    const m = MODES[id];
    if (m.loop) {
      assert.ok(m.maxIterations >= 2, `${id}: loop=true 却没有 maxIterations → 成本黑洞`);
    }
  }
});

test('★ 结构防退化：非循环模式的 stopWhen 必须是 single-pass（否则判据是死代码）', () => {
  for (const id of MODE_IDS) {
    const m = MODES[id];
    if (!m.loop) {
      assert.ok(m.stopWhen === 'single-pass' || m.stopWhen === undefined,
        `${id}: loop=false 但 stopWhen=${m.stopWhen} → 只跑一轮，判据永远不会被读到`);
    }
  }
});

test('★ 结构防退化：用了 same-winner/build-pass 判据的模式必须真的是 loop 模式', () => {
  for (const id of MODE_IDS) {
    const m = MODES[id];
    if (m.stopWhen === 'same-winner' || m.stopWhen === 'build-pass') {
      assert.strictEqual(m.loop, true, `${id}: 判据 ${m.stopWhen} 需要多轮才有意义`);
      assert.ok(m.maxIterations >= 2, `${id}: 必须有迭代上限兜底`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════════
   七、集成结果判定 + 定标 prompt（落实"文本说通过 ≠ 真的通过"）
   ══════════════════════════════════════════════════════════════════ */

test('★ judgeBuildPass 的不对称设计：模型承认失败 → 可信；自述通过 → 不采信', () => {
  // ① 承认失败：可信（模型通常不会撒谎说自己失败）
  const fail = judgeBuildPass('集成失败：main.ts 缺少 import，编译错误 TS2307');
  assert.strictEqual(fail.pass, false);
  assert.strictEqual(fail.confidence, 'text-heuristic');
  assert.ok(fail.evidence, '要给出证据词');
  const failCn = judgeBuildPass('未能通过编译，类型错误 3 处');
  assert.strictEqual(failCn.pass, false, '中文"未通过"里含"通过" → 必须先判否定');

  // ② 自述通过：**不采信**（这是五家共识里的一条硬货："无新批评 ≠ 软件正确"）
  const selfClaim = judgeBuildPass('所有模块已成功集成，测试全部通过，可以交付了。');
  assert.strictEqual(selfClaim.pass, null, '模型自述"通过"不能当作真的通过');
  assert.strictEqual(selfClaim.confidence, 'text-heuristic-untrusted');
  assert.ok(selfClaim.reason.includes('编译'), '要说明该用什么去验证');

  // ③ 判不出来：不猜
  const vague = judgeBuildPass('我把三个模块拼起来了，看起来还行。');
  assert.strictEqual(vague.pass, null);
  assert.strictEqual(vague.confidence, 'undetermined');

  // ④ 空输入
  assert.strictEqual(judgeBuildPass('').pass, null);
});

test('★ 定标 prompt 必须喂"代码算出的名次汇总"，而不是让 AI 自己拍板', () => {
  const borda = bordaMeans([
    { reviewer: 'b', ranks: [{ proposal: '方案A', rank: 2 }, { proposal: '方案B', rank: 1 }] },
    { reviewer: 'c', ranks: [{ proposal: '方案A', rank: 2 }, { proposal: '方案B', rank: 1 }] },
  ]);
  const p = buildVerdictPrompt({ candidates: '【方案A】…\n\n【方案B】…', borda });

  assert.ok(p.includes('Borda 均值'), '必须明确告知这是代码统计结果');
  assert.ok(p.includes('方案B'), '要列出名次');
  assert.ok(p.includes('不是谁的主观印象'), '要明确否定"凭印象定标"');
  assert.ok(p.includes('不是重新投票'), '定标席的职责是确认+说明，不是重投');
});

test('★ 无名次表时定标 prompt 必须拒绝凭空指定胜出者', () => {
  const p = buildVerdictPrompt({ candidates: '【方案A】…', borda: null });
  assert.ok(p.includes('尚无名次汇总'));
  assert.ok(p.includes('不要凭印象指定胜出者'));
  assert.ok(buildVerdictPrompt({}).includes('不要凭印象指定胜出者'));
});

test('★ 定标 prompt 里绝不能出现"匿名标签→真实作者"的映射（否则匿名白做）', () => {
  const p = buildVerdictPrompt({
    candidates: '【方案A】内容',
    borda: bordaMeans([{ reviewer: 'b', ranks: [{ proposal: '方案A', rank: 1 }] }]),
    map: { 方案A: 'deepseek-web' },   // 调用方即使误传，也不该被写进 prompt
  });
  assert.ok(!p.includes('deepseek-web'), '匿名映射只作审计，绝不能进 prompt（会带品牌偏见）');
  assert.ok(!p.includes('内部审计'));
});

/* ══════════════════════════════════════════════════════════════════
   八、produces 输出契约：切片输入侧的最后一公里
   ══════════════════════════════════════════════════════════════════ */

test('★ tournament 每个阶段都有 produces（编排层靠它给 message 打 kind）', () => {
  const plan = planPhases('tournament', { participants: ['a', 'b', 'c'], assignment: [] });
  for (const p of plan) {
    assert.ok(p.produces, `${p.name} 缺 produces → CANDIDATES 无法区分候选与评标意见`);
  }
  assert.strictEqual(plan.find((p) => p.name === '出标').produces, 'candidate');
  assert.strictEqual(plan.find((p) => p.name === '评标').produces, 'ballot');
  assert.strictEqual(plan.find((p) => p.name === '定标').produces, 'verdict');
});

test('★ build 每个阶段都有 produces，且"分头实现"产出的是 artifact（文件，不是文本）', () => {
  const plan = planPhases('build', { participants: ['a', 'b', 'c'], assignment: [] });
  for (const p of plan) {
    assert.ok(p.produces, `${p.name} 缺 produces`);
  }
  assert.strictEqual(plan.find((p) => p.name === '冻结契约').produces, 'contract');
  assert.strictEqual(plan.find((p) => p.name === '分头实现').produces, 'artifact');
  assert.strictEqual(plan.find((p) => p.name === '集成验证').produces, 'integration');
});

test('★ 端到端：消息打了 kind 后，CANDIDATES 只挑候选、绝不夹带评标意见', () => {
  // 模拟一场会：出标产 2 份候选，评标产 1 份名次表
  const messages = [
    { senderId: 'x', content: '候选一：方案细节…', kind: 'candidate' },
    { senderId: 'y', content: '候选二：另一种做法…', kind: 'candidate' },
    { senderId: 'z', content: '方案A第1，方案B第2', kind: 'ballot' },
    { senderId: 'c', content: '定标：方案A', kind: 'verdict' },
  ];
  const sl = selectSlice(SLICE.CANDIDATES, { messages, selfId: 'x' });
  assert.strictEqual(sl.included.length, 2, '只有 2 份候选');
  assert.ok(!sl.text.includes('第1'), '名次表不能混进候选包（否则评标者会被上轮别人的评分带偏）');
  assert.ok(!sl.text.includes('定标'));
});
