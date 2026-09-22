'use strict';
/**
 * test/panel-group.test.js —— Q7：panel（专家会诊）分组降本的阶段展开
 *
 * 现有 panel = 会诊（全员顺序、OTHERS）+ 归并结论（收敛类、ALL）。
 * Q7 降本：把"会诊"阶段的 O(N²) 接龙改为"组内接龙 + 组长接龙"。
 */

const test = require('node:test');
const assert = require('node:assert');
const { planPhases, SLICE, SPEAK } = require('../core/modes');
const { assignRoles } = require('../core/roles');

const NINE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const ASSIGN9 = assignRoles(NINE, { set: 'product-9' });

/* ---------------- 默认不分组 ---------------- */

test('★ 默认（不传 panelGroupSize）panel 保持原"全员会诊"（O(N²) 但行为不变）', () => {
  const plan = planPhases('panel', { participants: NINE, assignment: ASSIGN9 });
  assert.strictEqual(plan.length, 2, '会诊 + 归并结论 两阶段');
  assert.strictEqual(plan[0].name, '会诊');
  assert.strictEqual(plan[0].speak, SPEAK.SEQUENTIAL, '会诊是顺序接龙');
  assert.strictEqual(plan[0].slice, SLICE.OTHERS, '每人看别人发言（不含自己）');
  assert.deepStrictEqual(plan[0].speakers, NINE, '全员');
  assert.strictEqual(plan[1].name, '归并结论');
});

/* ---------------- 分组降本 ---------------- */

test('★ 9 人分 3 组（panelGroupSize=3）→ 3 组组内会诊 + 1 组长会诊 + 归并', () => {
  const plan = planPhases('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: 3 });
  // 3 个组内阶段 + 1 个组长阶段 + 1 归并 = 5 个阶段
  assert.strictEqual(plan.length, 5);
  assert.deepStrictEqual(plan.map((p) => p.name),
    ['组1会诊（3人）', '组2会诊（3人）', '组3会诊（3人）', '组长会诊', '归并结论']);

  // 每组成员正确切分（a,b,c / d,e,f / g,h,i）
  assert.deepStrictEqual(plan[0].speakers, ['a', 'b', 'c']);
  assert.deepStrictEqual(plan[1].speakers, ['d', 'e', 'f']);
  assert.deepStrictEqual(plan[2].speakers, ['g', 'h', 'i']);

  // 组内接龙是顺序 + OTHERS 切片（只看组内别人的前文）
  for (let i = 0; i < 3; i += 1) {
    assert.strictEqual(plan[i].speak, SPEAK.SEQUENTIAL, `组${i + 1} 必须组内接龙`);
    assert.strictEqual(plan[i].slice, SLICE.OTHERS, `组${i + 1} 用 OTHERS（组边界由编排层限定 messages）`);
  }

  // 组长会诊：默认每组分第 1 人当组长
  assert.deepStrictEqual(plan[3].speakers, ['a', 'd', 'g'], '默认组长 = 每组第 1 人');
  assert.strictEqual(plan[3].slice, SLICE.OTHERS, '组长看其它组组长的发言');
  assert.strictEqual(plan[3].speak, SPEAK.SEQUENTIAL);

  // 归并结论仍是收敛类
  assert.strictEqual(plan[4].name, '归并结论');
});

test('★ 分组后的"每人看到的上下文"量级：从 O(N) 降到 O(groupSize)', () => {
  const plan = planPhases('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: 3 });
  // 原"全员会诊"：第 9 人要看前 8 份（O(8)）
  // 分组后：组3第3位（i）只看组3内前 2 份（g,h）
  assert.ok(plan[2].speakers.length === 3, '组3 只有 3 人，组内最多看 2 份前文');
  assert.strictEqual(plan[2].groupSize, 3, '★ groupSize 是组边界契约（编排层据此限定 messages 只取本组）');
});

test('自定义组长（groupLeaderOf）：每组指定"最有结构化的那位"当组长', () => {
  const plan = planPhases('panel', {
    participants: NINE,
    assignment: ASSIGN9,
    panelGroupSize: 3,
    groupLeaderOf: (grp) => grp[grp.length - 1], // 取每组最后 1 人当组长
  });
  assert.deepStrictEqual(plan[3].speakers, ['c', 'f', 'i'], '★ 自定义组长 = 每组末位');
});

/* ---------------- 不触发分组的边界 ---------------- */

test('人数 ≤ panelGroupSize 时不分组（无意义，保持原样）', () => {
  const plan = planPhases('panel', {
    participants: ['a', 'b', 'c'],
    assignment: assignRoles(['a', 'b', 'c'], { set: 'trio' }),
    panelGroupSize: 3,
  });
  assert.strictEqual(plan.length, 2, '3 人 ≤ 3 → 不分组');
  assert.strictEqual(plan[0].name, '会诊');
});

test('panelGroupSize=1 视为不分组（每组 1 人 = 没意义）', () => {
  const plan = planPhases('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: 1 });
  assert.strictEqual(plan.length, 2, 'panelGroupSize=1 退化为不分组');
});

/* ---------------- 成本对比（O(N²) → O(G·g + G)） ---------------- */

test('★ 成本对比：9 人 panel 会诊注入量从 36 份降到 12 份（1/3）', () => {
  // 原"全员会诊"：第 k 人看前 k-1 份 → 总注入 = 0+1+...+8 = 36（O(N²)/2）
  // 分组（3 组×3 人）：
  //   组内会诊：每组 0+1+2 = 3 份，3 组 = 9 份
  //   组长会诊：3 个组长，第 k 个看前 k-1 份组长摘要 → 0+1+2 = 3 份
  //   总注入 = 9 + 3 = 12（O(G·g²/2 + G²/2)），是原来的 1/3
  const plan = planPhases('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: 3 });
  let groupedInjection = 0;
  for (const p of plan) {
    if (p.name.startsWith('组') || p.name === '组长会诊') {
      groupedInjection += (p.speakers.length - 1) * p.speakers.length / 2;
    }
  }
  const fullInjection = (9 * 8) / 2;
  assert.strictEqual(fullInjection, 36);
  assert.strictEqual(groupedInjection, 12, '★ 分组后注入量降到 1/3（36→12）');
});
