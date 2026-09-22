'use strict';
/**
 * demo/run-casting-demo.js —— 模型能力档案 + 模式场景 + 能力感知选角
 *
 * 用法： node demo/run-casting-demo.js
 *
 * 这个演示回答用户的三个问题：
 *   ① 「你这个模式我没看懂」        → §二 每个模式的使用场景（人话）
 *   ② 「要考虑每个模型的特长缺点」    → §一 能力档案表
 *   ③ 「随机设定角色要考虑模型能力」  → §三 选角：随机但不失配 + 随机性验证
 */

const { listModels, TRAITS, TRAIT_LABELS, complementarity } = require('../core/models');
const { listModes } = require('../core/modes');
const { listRoleSets } = require('../core/roles');
const { castRoles, autoCast } = require('../core/casting');

/* ── 终端颜色（Windows 终端也认 ANSI） ── */
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

const line = (n = 78, ch = '─') => ch.repeat(n);
const h1 = (t) => { console.log(''); console.log(C.bold + C.cyan + `══ ${t} ` + line(74 - t.length, '═') + C.reset); };
const h2 = (t) => { console.log(''); console.log(C.bold + `▍${t}` + C.reset); };

/** 按显示宽度对齐（中文字符占 2 列） */
function pad(s, w) {
  const str = String(s);
  let width = 0;
  for (const ch of str) width += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, w - width));
}

/* ══════════════════════════════════════════════════════════════
   §一、模型能力档案
   ══════════════════════════════════════════════════════════════ */
function section1() {
  h1('一、模型能力档案（八维打分 1–5）');

  const web = listModels().filter((m) => m.channel === 'web');
  const api = listModels().filter((m) => m.channel === 'api');

  const header = pad('模型', 20) + pad('通道', 6)
    + TRAITS.map((t) => pad(TRAIT_LABELS[t].slice(0, 4), 6)).join('');

  console.log(C.gray + header + C.reset);
  console.log(C.gray + line(20 + 6 + TRAITS.length * 6) + C.reset);

  for (const m of [...web, ...api]) {
    const cells = TRAITS.map((t) => {
      const v = m.traits[t];
      // 5 分绿、1–2 分红：一眼看出强弱项
      const color = v >= 5 ? C.green : v <= 2 ? C.red : C.reset;
      return pad(`${color}${v}${C.reset}`, 6 + (color.length));
    }).join('');
    console.log(pad(m.label, 20) + pad(m.channel === 'web' ? '网页' : C.magenta + 'API' + C.reset, 6 + (m.channel === 'web' ? 0 : C.magenta.length + C.reset.length)) + cells);
  }

  h2('特长与缺点（每个模型都有，选角时直接用）');
  for (const m of [...web, ...api]) {
    console.log('');
    console.log(`  ${C.bold}${m.label}${C.reset} ${C.gray}(${m.channel === 'web' ? '网页版' : 'API 通道'})${C.reset}`);
    console.log(`    ${C.green}✔${C.reset} ${m.strengths.join('\n      ')}`);
    console.log(`    ${C.red}✘${C.reset} ${m.weaknesses.join('\n      ')}`);
    console.log(`    ${C.cyan}会议用法${C.reset} ${m.meetingNote}`);
  }
}

/* ══════════════════════════════════════════════════════════════
   §二、会议模式与使用场景
   ══════════════════════════════════════════════════════════════ */
function section2() {
  h1('二、会议模式与使用场景（每个模式：什么时候用 / 什么时候别用）');

  const modes = listModes();
  modes.forEach((m, i) => {
    console.log('');
    console.log(`  ${C.bold}${C.yellow}[${i + 1}] ${m.label}${C.reset}`
      + `${m.loop ? C.green + '  ↻ 自动循环至收敛' + C.reset : ''}`
      + `${m.requiresChairman ? C.magenta + '  ★ 必须走 API' + C.reset : ''}`);
    console.log(`      ${C.cyan}什么时候用${C.reset}  ${m.scene.when}`);
    console.log(`      ${C.cyan}典型例子${C.reset}    ${m.scene.example}`);
    console.log(`      ${C.red}什么时候别用${C.reset} ${m.scene.notFor}`);
    console.log(`      ${C.green}产出${C.reset}        ${m.scene.output}`);
    const phases = m.phaseList.map((p, j) =>
      `${j + 1}.${p.name}${p.speak === 'parallel' ? '(并行)' : '(串行)'}`).join(' → ');
    console.log(`      ${C.gray}阶段流程${C.reset}    ${phases}`);
    const need = Object.entries(m.modelFit.need)
      .map(([k, v]) => `${TRAIT_LABELS[k] || k}≥${v}`).join('、');
    console.log(`      ${C.gray}模型要求${C.reset}    ${need} ${C.gray}| 推荐角色组：${m.modelFit.recommendSet}${C.reset}`);
    console.log(`      ${C.gray}提示${C.reset}        ${m.modelFit.tips}`);
  });
}

/* ══════════════════════════════════════════════════════════════
   §三、能力感知选角
   ══════════════════════════════════════════════════════════════ */
function section3() {
  h1('三、能力感知选角：随机 ✕ 能力约束');

  const all = listModels().map((m) => m.id);

  console.log(`  候选池：${all.length} 个模型（9 个网页版 + 3 个 API 通道）`);
  console.log(`  角色组：${listRoleSets().map((s) => `${s.label}(${s.seats}席)`).join(' / ')}`);

  // ── 3.1 一次典型分配 ──
  h2('3.1 一次分配（seed=demo-1，产品评审九人组）');
  const r = castRoles(all, { set: 'product-9', seed: 'demo-1' });
  console.log(`  ${C.gray}seed=${r.seed}${C.reset}`);
  console.log('');
  console.log('  ' + C.gray + pad('席位', 18) + pad('模型', 22) + pad('适配分', 8) + '为什么是它' + C.reset);
  console.log('  ' + C.gray + line(76) + C.reset);
  for (const a of r.assignment) {
    const color = a.fitScore >= 90 ? C.green : a.fitScore >= 70 ? C.reset : C.yellow;
    console.log('  ' + pad(a.label, 18) + pad(a.providerId, 22)
      + color + pad(a.fitScore, 8) + C.reset + C.gray + a.reason + C.reset);
  }
  console.log('');
  for (const w of r.warnings) console.log(`  ${C.yellow}⚠ ${w}${C.reset}`);

  // ── 3.2 随机性：换 seed 就是另一场会 ──
  h2('3.2 「随机」是真实存在的（换 seed = 换一套编制）');
  const seedPicks = {};
  for (let i = 1; i <= 8; i++) {
    const x = castRoles(all, { set: 'tech-7', seed: `s${i}` });
    seedPicks[`s${i}`] = x.assignment.map((a) => a.providerId).join(',');
  }
  const uniq = new Set(Object.values(seedPicks));
  console.log(`  同一套角色组（技术选型七人组），8 个不同 seed → ${uniq.size} 种不同编制`);
  console.log('');
  for (const [s, v] of Object.entries(seedPicks)) {
    console.log(`    ${C.gray}${s}${C.reset}  ${C.dim}${v.slice(0, 68)}${C.reset}`);
  }

  // ── 3.3 但能力约束永远不破 ──
  h2('3.3 但"能力约束"永远不破（100 次随机，0 次错配）');
  const N = 100;
  let violations = 0;
  const checks = [];
  for (let i = 0; i < N; i++) {
    const x = castRoles(all, { set: 'product-9', seed: `v${i}` });
    for (const a of x.assignment) {
      const led = x.ledger.find((l) => l.roleId === a.roleId);
      if (led && led.degradedFrom) violations += 1;   // 降级 = 能力不匹配的人坐上了
      checks.push(a);
    }
  }
  console.log(`  ${N} 次随机分配，共 ${checks.length} 个席位：`);
  console.log(`    能力不匹配（需降级）的席位：${violations === 0 ? C.green + '0 个 ✔' + C.reset : C.red + violations + ' 个' + C.reset}`);

  // ── 3.4 硬约束抽样展示 ──
  h2('3.4 硬约束长什么样（几个真实的"不许"）');
  const demos = [
    ['wenxin-web', 'red-team', '文心推理 2 分 < 红队门槛 4'],
    ['deepseek-web', 'clerk', 'DeepSeek 速度 2 分 < 书记员门槛 4'],
    ['google-search', 'architect', '纯搜索引擎不能当对话角色'],
    ['doubao-web', 'red-team', '豆包易谄媚，档案里禁了质证席位'],
  ];
  const { fitScore } = require('../core/models');
  const { roleReq } = require('../core/roles');
  for (const [model, role, why] of demos) {
    const f = fitScore(model, roleReq(role));
    const mark = f.veto ? `${C.red}拒绝${C.reset}` : `${C.green}允许${C.reset}`;
    console.log(`    ${mark}  ${pad(model, 16)} → ${pad(role, 16)} ${C.gray}${f.veto || why}${C.reset}`);
  }

  // ── 3.5 互补性 ──
  h2('3.5 反同质化：对立席位优先选"能力互补"的模型');
  const pairs = [
    ['deepseek-web', 'doubao-web'],
    ['deepseek-web', 'chatgpt-web'],
    ['kimi-web', 'yuanbao-web'],
  ];
  for (const [a, b] of pairs) {
    const c = complementarity(a, b);
    const bar = '█'.repeat(Math.round(c / 5));
    console.log(`    ${pad(a, 16)} × ${pad(b, 16)} 互补度 ${String(c).padStart(3)}  ${C.cyan}${bar}${C.reset}`);
  }
  console.log('');
  console.log(`  ${C.gray}互补度越高，两个模型越不容易说同样的话——适合安排在互相对立的席位上。${C.reset}`);
}

/* ══════════════════════════════════════════════════════════════
   §四、双通道（网页版 + API 同场开会）
   ══════════════════════════════════════════════════════════════ */
function section4() {
  h1('四、双管齐下：网页版与 API 同场开会');

  const { getRedacted } = require('../adapters/dsh-config');
  const red = getRedacted({});

  console.log(`  ${C.gray}配置来源：${red.dir}${C.reset}`);
  console.log('');
  console.log('  ' + C.gray + pad('提供方', 12) + pad('端点', 38) + pad('密钥', 8) + '模型数' + C.reset);
  console.log('  ' + C.gray + line(70) + C.reset);
  for (const p of red.providers) {
    console.log('  ' + pad(p.key, 12) + pad(p.host, 38)
      + pad(p.hasKey ? `${C.green}✔${C.reset}` : `${C.red}✘${C.reset}`, 8 + (p.hasKey ? C.green.length + C.reset.length : C.red.length + C.reset.length))
      + p.modelCount);
  }
  for (const w of red.warnings) console.log(`  ${C.yellow}⚠ ${w}${C.reset}`);

  console.log('');
  console.log(`  ${C.bold}两路各自适合什么：${C.reset}`);
  console.log(`    ${C.magenta}API 通道${C.reset}  快、稳、可编程（流结束=答完，无假完成风险）`);
  console.log(`              → 适合：主席 / 书记员 / 判停 / 轮纪要（高频、要即时）`);
  console.log(`              → 弱点：无联网、按量计费`);
  console.log(`    ${C.blue}网页版  ${C.reset}  免费、能联网、9 宫格可视化（保留产品形态）`);
  console.log(`              → 适合：需要检索/长材料/多模态的席位`);
  console.log(`              → 弱点：慢、完成检测靠探测（已修假阳性）`);
  console.log('');
  console.log(`  ${C.green}关键：两者是同一个契约（contract.js），编排层完全看不出差别。${C.reset}`);
}

/* ══════════════════════════════════════════════════════════════ */
function main() {
  console.log('');
  console.log(C.bold + C.blue + '  通辽会议 · 模式 / 模型能力 / 选角 全景演示' + C.reset);
  console.log(C.gray + '  ' + line(74) + C.reset);
  console.log(C.gray + '  回答三个问题：模式怎么用、模型擅长什么、角色怎么分配' + C.reset);

  section1();
  section2();
  section3();
  section4();

  console.log('');
  console.log(C.gray + '  ' + line(74) + C.reset);
  console.log('');
}

main();
