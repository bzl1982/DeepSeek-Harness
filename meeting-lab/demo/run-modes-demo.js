'use strict';
/**
 * demo/run-modes-demo.js —— 会议模式 & 角色分化 终端演示
 *
 * 完全离线：不需要浏览器、不需要真 AI、不碰客户端。
 * 用途：在接到 Electron 之前，先把"这场会到底会发生什么"看清楚。
 *
 *   node demo/run-modes-demo.js
 */

const { assignRoles, validateAssignment, listRoleSets, listRoles } = require('../core/roles');
const { listModes, planPhases, selectSlice, shouldStop, newCritiques } = require('../core/modes');
const { composePrompt } = require('../core/context-strategy');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  blue: '\x1b[36m', gray: '\x1b[90m',
};

const who = ['deepseek-web', 'chatgpt-web', 'gemini-web'];
const line = (s = '') => console.log(s);
const hr = (t) => { line(); line(`${C.bold}${C.blue}━━ ${t} ━━${C.reset}`); };

/* ══════════════════════════════════════════════════════════
   1. 角色库概览
   ══════════════════════════════════════════════════════════ */
hr('1. 角色库（14 个角色，按四大认知职能分类）');
const GROUP_CN = { challenge: '质证（挑错）', build: '建设（给方案）', represent: '代表（换立场）', converge: '收敛（收结论）' };
const byGroup = {};
for (const r of listRoles()) (byGroup[r.group] ||= []).push(r);
for (const [g, roles] of Object.entries(byGroup)) {
  line(`  ${C.yellow}${GROUP_CN[g]}${C.reset}（${roles.length}）：${roles.map((r) => r.label).join('、')}`);
}

/* ══════════════════════════════════════════════════════════
   2. 「角色设定多种」：同一批 AI，换一套角色组 = 另一场会
   ══════════════════════════════════════════════════════════ */
hr('2. 同一批 3 个 AI，换角色组 = 另一场会（这就是「角色设定多种」）');
line(`  参会者：${who.join('  ')}`);
line();
for (const set of listRoleSets().filter((s) => s.seats === 3)) {
  const a = assignRoles(who, { set: set.id });
  const v = validateAssignment(a);
  line(`  ${C.bold}${set.label}${C.reset}  ${C.gray}[${set.id}]${C.reset}  ${v.ok ? C.green + '✔ 健康' : C.red + '✘ 有问题'}${C.reset}`);
  for (const x of a) line(`      ${who.indexOf(x.providerId) + 1}号格 → ${C.yellow}${x.label}${C.reset} ${C.gray}(${GROUP_CN[x.group]})${C.reset}`);
}

hr('3. 角色前缀长什么样（互斥输出约束 + 格式约束 = 反趋同机制）');
const trio = assignRoles(who, { set: 'trio' });
for (const x of trio) {
  line(`  ${C.yellow}${x.label}${C.reset}`);
  line(`  ${C.gray}${x.prompt}${C.reset}`);
  line();
}

hr('4. 端到端：3 个 AI 实际收到的 prompt 完全不同的开头');
const roleMap = Object.fromEntries(trio.map((x) => [x.providerId, x.prompt]));
const task = '请评审「通辽会议接入多智能体框架」的可行路径。';
for (const id of who) {
  const p = composePrompt({ task, role: roleMap[id], providerId: id });
  line(`  ${C.blue}[${id}]${C.reset} ${p.split('\n')[0].slice(0, 46)}…`);
}
line(`  ${C.dim}→ 三份 prompt 互不相同，才不是 3 个复读机${C.reset}`);

/* ══════════════════════════════════════════════════════════
   5. 会议模式：每个模式展开成"谁发言、看什么"
   ══════════════════════════════════════════════════════════ */
hr('5. 七种会议模式（阶段展开 = 这场会实际会发生什么）');
const SLICE_CN = {
  task: '只看本轮任务', material: '只看待审材料', others: '只看别人发言',
  all: '看全部发言', critiques: '只看批评清单', draft: '只看当前草稿', none: '不带上下文',
};
for (const m of listModes()) {
  line(`  ${C.bold}${m.label}${C.reset} ${C.gray}[${m.id}]${C.reset}` + (m.loop ? ` ${C.yellow}↻ 循环${C.reset}` : '') + (m.requiresChairman ? ` ${C.yellow}需主席API${C.reset}` : ''));
  line(`    ${C.gray}${m.desc}${C.reset}`);
  const plan = planPhases(m.id, { participants: who, assignment: trio, picked: 'chatgpt-web' });
  for (const p of plan) {
    const names = p.speakers.map((id) => `${who.indexOf(id) + 1}号`).join('+') || '（等人）';
    const flag = p.degraded ? ` ${C.red}[退化]${C.reset}` : '';
    line(`      ${String(p.index + 1).padStart(2)}. ${p.name.padEnd(6, '　')} ${C.green}${names.padEnd(8)}${C.reset} ${p.speak === 'parallel' ? '并行' : '串行'} ｜ ${SLICE_CN[p.slice]}${flag}`);
  }
  line();
}

/* ══════════════════════════════════════════════════════════
   6. 「共同审阅」为什么必须"先独立后交叉"
   ══════════════════════════════════════════════════════════ */
hr('6. 共同审阅：第一阶段绝不能看到彼此（防锚定效应）');
const reviewPlan = planPhases('review', { participants: who, assignment: trio });
const fakeMsgs = [
  { senderId: 'deepseek-web', content: '我建议先做完成检测' },
  { senderId: 'chatgpt-web', content: '我建议先补 localPath' },
];
line(`  阶段 1「${reviewPlan[0].name}」切片 = ${reviewPlan[0].slice}`);
const s1 = selectSlice(reviewPlan[0].slice, { material: '【材料】方案 V3 全文…', messages: fakeMsgs, selfId: 'deepseek-web' });
line(`    → 拿到：${C.green}${s1.included.join(',') || '（空）'}${C.reset}  ${C.gray}双方各看材料、互不影响，视角不收敛${C.reset}`);
line(`  阶段 2「${reviewPlan[1].name}」切片 = ${reviewPlan[1].slice}`);
const s2 = selectSlice(reviewPlan[1].slice, { messages: fakeMsgs, selfId: 'chatgpt-web' });
line(`    → 拿到：${C.green}${s2.included.join(',')}${C.reset}`);
line(`    → 内容里 ${C.yellow}不含自己${C.reset}说过的话：${C.gray}${s2.text}${C.reset}`);

/* ══════════════════════════════════════════════════════════
   7. 「反复修正」的收敛判据（客观，不靠轮数硬切）
   ══════════════════════════════════════════════════════════ */
hr('7. 反复修正：靠「有没有新批评」决定停不停，不靠轮数');
const history = [
  { iter: 1, critiques: [] },
  { iter: 2, critiques: ['缺少失败回退方案', '成本估算没算人力'] },
  { iter: 3, critiques: ['缺少失败回退方案', '成本估算没算人力', '并发下可能丢消息'] },
  { iter: 4, critiques: ['缺少失败回退方案。', '成本估算没算人力！'] }, // 只换标点
];
let prev = [];
for (const h of history) {
  const fresh = newCritiques(h.critiques, prev);
  const verdict = shouldStop('iterate', { iteration: h.iter, critiques: h.critiques, prevCritiques: prev });
  const mark = verdict.stop ? `${C.green}■ 停${C.reset}` : `${C.yellow}▶ 继续${C.reset}`;
  line(`  第 ${h.iter} 轮：批评 ${String(h.critiques.length).padStart(2)} 条，新增 ${String(fresh.length).padStart(2)} 条  → ${mark}  ${C.gray}${verdict.reason}${C.reset}`);
  prev = h.critiques;
}
line(`  ${C.dim}→ 第 4 轮只是换了标点，被规范化掉，判定收敛。烧配额刷废话被客观拦住。${C.reset}`);

hr('8. 迭代上限兜底（防死循环）');
const r = shouldStop('iterate', { iteration: 5, critiques: ['永远新鲜的问题'], prevCritiques: ['别的问题'] });
line(`  第 5 轮（上限）：${r.stop ? C.green + '强制停止' : C.red + '继续'}${C.reset}  ${C.gray}${r.reason}${C.reset}`);

/* ══════════════════════════════════════════════════════════
   9. 主席模式：没点名就不许发言
   ══════════════════════════════════════════════════════════ */
hr('9. 主席点名模式：未点名时绝不允许任何人发言');
const nonPicked = planPhases('chairman', { participants: who, assignment: trio, picked: null });
line(`  未点名 → 发言者：${nonPicked[0].speakers.length ? C.red + nonPicked[0].speakers.join(',') : C.green + '（无人发言）'}${C.reset}  ${C.gray}${nonPicked[0].reason}${C.reset}`);
const picked = planPhases('chairman', { participants: who, assignment: trio, picked: 'b' });
line(`  点名 2 号 → 发言者：${C.green}${picked[0].speakers.join(',')}${C.reset}`);

line();
line(`${C.bold}${C.green}全部演示完成。${C.reset} 这些逻辑都有单测覆盖：node --test test/*.test.js`);
line();
