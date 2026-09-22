'use strict';
/**
 * test/roles.test.js —— 角色库测试
 *
 * 验证目标（用户需求「角色设定多种」+ 盲点 A「同质化坍塌」）：
 *   1. 角色库自洽：每个角色都有互斥输出约束（不是人格腔调）
 *   2. 预置角色集无笔误、无重复职能
 *   3. ★ 角色绑「席位」不绑 provider —— 同一批 AI 换一套 set 就是另一场会
 *   4. 重复职能必须被拦下（两人同角色 = 必然复读，白占一个格子）
 *   5. 缺质证类 = 错误、缺收敛类 = 警告
 *   6. ★ 端到端：角色分化真的能让 prompt 不同（接 composePrompt 验证）
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  ROLE_CATALOG, ROLE_SETS, getRole, assignRoles,
  validateAssignment, toPromptRoleMap, listRoles, listRoleSets,
} = require('../core/roles');
const { composePrompt } = require('../core/context-strategy');

/* ---------------- 角色库自洽 ---------------- */

test('每个角色都必须有「互斥输出约束」，不能只是人格腔调（Hy4-3 原则 A/B）', () => {
  const roles = Object.values(ROLE_CATALOG);
  assert.ok(roles.length >= 12, `角色库至少 12 个角色，当前 ${roles.length}`);
  for (const r of roles) {
    assert.ok(r.id && r.label && r.group && r.prompt, `角色 ${r.id} 字段不全`);
    assert.ok(r.prompt.length >= 30, `角色 ${r.id} 的 prompt 太短，不足以产生视角差异`);
    // 必须有"禁止/只"这类边界词 —— 这是互斥约束的标志
    assert.match(r.prompt, /禁止|只|不许|不得/, `角色 ${r.id} 缺少互斥输出约束（禁止/只…）`);
  }
});

test('角色按四大类分布：质证 / 建设 / 代表 / 收敛，每类都不止一个', () => {
  const groups = {};
  for (const r of Object.values(ROLE_CATALOG)) groups[r.group] = (groups[r.group] || 0) + 1;
  for (const g of ['challenge', 'build', 'represent', 'converge']) {
    assert.ok(groups[g] >= 2, `「${g}」类角色不足 2 个（当前 ${groups[g] || 0}）`);
  }
});

/* ---------------- 预置角色集 ---------------- */

test('★ 所有预置 set 的角色 id 都真实存在（防笔误直接崩）', () => {
  for (const [setId, s] of Object.entries(ROLE_SETS)) {
    for (const seat of s.seats) {
      assert.ok(getRole(seat), `角色集「${setId}」引用了不存在的角色 id：${seat}`);
    }
  }
});

test('★ 每个预置 set 内部职能互不重复（重复 = 白占格子做复读机）', () => {
  for (const [setId, s] of Object.entries(ROLE_SETS)) {
    const uniq = new Set(s.seats);
    assert.strictEqual(uniq.size, s.seats.length, `角色集「${setId}」有重复角色：${s.seats.join(',')}`);
  }
});

test('每个预置 set 至少有一个质证类，且有"收尾类"角色（否则会开成点赞会 / 开完没结论）', () => {
  // 收尾类 = 收敛类(converge) 或 集成类(integrate)。
  // build-7 是工程交付专用：它的"收尾"由 integrator（集成类）承担——
  // integrator 把"分头写的模块"收拢成"能跑的"，功能上等价于收敛类的"归并"，
  // 只是交付物从"结论"变成"可运行软件"。
  // 所以不变量是：必须有 challenge（对抗）+ 必须有 converge|integrate（收尾）。
  const BUILD_SETS = new Set(['build-7']);
  for (const [setId, s] of Object.entries(ROLE_SETS)) {
    const groups = s.seats.map((id) => getRole(id).group);
    assert.ok(groups.includes('challenge'), `角色集「${setId}」没有质证类角色`);
    if (BUILD_SETS.has(setId)) {
      assert.ok(groups.includes('converge') || groups.includes('integrate'),
        `工程交付角色集「${setId}」必须有收尾类（converge 或 integrate）`);
    } else {
      assert.ok(groups.includes('converge'), `角色集「${setId}」没有收敛类角色`);
    }
  }
});

/* ---------------- 分配 ---------------- */

test('3 人参会 + trio → 三个不同角色（用户裁决 4：测试先 3 个）', () => {
  const a = assignRoles(['deepseek-web', 'chatgpt-web', 'gemini-web'], { set: 'trio' });
  assert.strictEqual(a.length, 3);
  assert.notStrictEqual(a[0].roleId, a[1].roleId);
  assert.notStrictEqual(a[1].roleId, a[2].roleId);
  assert.deepStrictEqual(a.map((x) => x.providerId), ['deepseek-web', 'chatgpt-web', 'gemini-web'],
    '分配必须保持参会者原顺序（否则换顺序就换结论）');
  assert.ok(validateAssignment(a).ok);
});

test('参会者多于席位 → 用 generalist 补齐，不报错、不重复', () => {
  const a = assignRoles(['a', 'b', 'c', 'd', 'e'], { set: 'trio' });
  assert.strictEqual(a.length, 5);
  assert.strictEqual(a[0].roleId, 'architect');
  assert.strictEqual(a[3].roleId, 'generalist', '第 4 席起用 generalist 补齐');
  // 补齐会造成 generalist 重复 —— 这是"席位不够"的必然结果，validate 应如实报错
  assert.strictEqual(validateAssignment(a).ok, false, '重复职能必须被拦下，不能假装健康');
});

test('★ 角色绑「席位」不绑 provider：同一批 AI 换一套 set → 角色全变', () => {
  const who = ['deepseek-web', 'chatgpt-web', 'gemini-web'];
  const t = assignRoles(who, { set: 'trio' });
  const r = assignRoles(who, { set: 'trio-review' });
  assert.deepStrictEqual(t.map((x) => x.providerId), r.map((x) => x.providerId), '参会者相同');
  assert.notDeepStrictEqual(t.map((x) => x.roleId), r.map((x) => x.roleId),
    '同一批 AI 必须能换角色组 —— 这就是「角色设定多种」的核心');
});

test('同一角色的 prompt 与 provider 无关（角色是抽象，不是给某个 AI 定制的）', () => {
  const a1 = assignRoles(['aaa'], { roles: ['red-team'] })[0];
  const a2 = assignRoles(['zzz'], { roles: ['red-team'] })[0];
  assert.strictEqual(a1.prompt, a2.prompt);
});

test('允许自定义角色组合，也允许临时改写措辞（promptOverrides）', () => {
  const a = assignRoles(['a', 'b'], {
    roles: ['red-team', 'chair-assistant'],
    promptOverrides: { 'red-team': '你是红队，但这次只挑安全性问题。' },
  });
  assert.strictEqual(a[0].roleId, 'red-team');
  assert.match(a[0].prompt, /这次只挑安全性问题/);
});

test('未知角色 id 自动兜底为 generalist，不抛异常', () => {
  const a = assignRoles(['a'], { roles: ['不存在的角色'] });
  assert.strictEqual(a[0].roleId, 'generalist');
});

test('空参会者 → 空分配（不崩）', () => {
  assert.deepStrictEqual(assignRoles([], { set: 'trio' }), []);
});

/* ---------------- 校验 ---------------- */

test('★ 角色重复必须被拦下（两人同角色 = 必然产出雷同内容）', () => {
  const bad = assignRoles(['a', 'b'], { roles: ['red-team', 'red-team'] });
  const v = validateAssignment(bad);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('角色重复')), '错误信息要说清是哪个角色重复');
});

test('缺质证类 = 错误（没人挑错 → 会开成互相点赞）', () => {
  const a = assignRoles(['a', 'b', 'c'], { roles: ['architect', 'executor', 'generalist'] });
  const v = validateAssignment(a);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('质证')));
});

test('缺收敛类 = 警告而非错误（可以人工归并）', () => {
  const a = assignRoles(['a', 'b'], { roles: ['architect', 'red-team'] });
  const v = validateAssignment(a);
  assert.strictEqual(v.ok, true);
  assert.ok(v.warnings.some((w) => w.includes('收敛')));
});

test('收敛类角色排在第一位要给出提示（它前面没有发言可收敛）', () => {
  const a = assignRoles(['a', 'b', 'c'], { roles: ['chair-assistant', 'red-team', 'architect'] });
  const v = validateAssignment(a);
  assert.ok(v.warnings.some((w) => w.includes('第一位')));
});

/* ---------------- 与 composePrompt 端到端 ---------------- */

test('★ 端到端：角色分化真的让 3 个 prompt 互不相同（接 composePrompt）', () => {
  const who = ['deepseek-web', 'chatgpt-web', 'gemini-web'];
  const assignment = assignRoles(who, { set: 'trio' });
  const map = toPromptRoleMap(assignment);
  const task = '请评审「接入多智能体框架」这件事。';

  const prompts = who.map((id) => composePrompt({ task, role: map[id], providerId: id }));
  const uniq = new Set(prompts);
  assert.strictEqual(uniq.size, 3, '3 个 AI 必须拿到 3 份不同的 prompt，否则就是 9 个复读机');
  // 每份都必须含自己角色的标志词
  assert.match(prompts[0], /架构师/);
  assert.match(prompts[1], /红队/);
  assert.match(prompts[2], /主持助理/);
  // 本轮任务必须都在场（角色不能把任务挤掉）
  for (const p of prompts) assert.match(p, /接入多智能体框架/);
});

/* ---------------- 列表接口（供 UI 渲染） ---------------- */

test('listRoles / listRoleSets 返回可直接渲染的清单', () => {
  const roles = listRoles();
  assert.ok(roles.length >= 12);
  assert.ok(roles.every((r) => r.id && r.label && r.group && r.prompt));

  const sets = listRoleSets();
  assert.ok(sets.length >= 5);
  assert.ok(sets.every((s) => s.id && s.label && s.seats > 0 && Array.isArray(s.roles)));
  assert.ok(sets.some((s) => s.seats === 3), '必须有一套 3 席的方案（测试阶段用）');
  assert.ok(sets.some((s) => s.seats === 9), '必须有一套 9 席的方案（满员用）');
});
