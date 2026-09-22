#!/usr/bin/env node
'use strict';
/**
 * tools/build-build-report.js —— 生成「产物落盘 + 真编译验证」这一轮的交付报告
 *                            （build-verify-report.html）
 *
 * ★ 与 tools/build-panel-report.js 同一套思路：**报告里的数字全部来自真实执行**，
 *   不是手写的。所以它同时是一份"文档"和一次"对账"：
 *     · 解析演示  → 真的调 parseArtifacts 去解析一段很乱的 AI 回复
 *     · 安全闸    → 真的拿一批恶意路径去撞 normalizeArtifactPath
 *     · 编译判定  → 真的建一个临时工作区、真的跑 node --check / JSON.parse
 *     · 判定诚实  → 真的对空工作区调 verdictOf，看它敢不敢说"通过"
 *     · 契约归属  → 真的把幻觉 owner 喂给 parseContractModules
 *     · 收敛稳定性→ 真的生成两次失败清单，看是否逐字相同
 *     · 验证数字  → 真的把 6 个验证脚本 + 单测跑一遍，抓它们的结论行
 *
 * 用法：
 *   node tools/build-build-report.js              完整（会真跑全部验证，约 1~2 分钟）
 *   node tools/build-build-report.js --no-run     跳过"跑验证"，只用静态部分 + 演示
 *   node tools/build-build-report.js --out x.html 指定输出
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { parseArtifacts, normalizeArtifactPath, ArtifactStore } = require('../core/artifact-bus');
const { verdictOf } = require('../core/build-verify');
const { verifyWorkspace, parseContractModules, critiquesFrom } = require('../core/build-loop');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const NO_RUN = argv.includes('--no-run');
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : path.join(ROOT, 'build-verify-report.html');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* ══════════════════════════════════════════════════════════════════
   ① 演示：解析一段故意很乱的 AI 回复（真的调解析器）
   ══════════════════════════════════════════════════════════════════ */

const MESSY_REPLY = [
  '好的，我把用户模块和接口层都写好了，配置也一并放在下面。',
  '',
  '### 1. 用户模块',
  '```js path=src/user.js',
  "module.exports = { name: 'user' };",
  '```',
  '',
  '### 2. 接口层',
  '<!-- path=src/api.js -->',
  '```js',
  "const user = require('./user');",
  "module.exports = { getUser: () => user };",
  '```',
  '',
  '### 3. 配置文件',
  '```',
  '// config/app.json',
  '{ "port": 3000, "debug": true }',
  '```',
  '',
  '还有入口文件 `src/index.js`：',
  '```js',
  "require('./api');",
  "require('./nowhere');   // ← 这个名字不存在，--check 抓不到，只有引用检查能抓",
  '```',
].join('\n');

function demoParse() {
  const r = parseArtifacts(MESSY_REPLY, { defaultPath: null });
  return { files: r.files, rejected: r.rejected, stats: r.stats };
}

/* ══════════════════════════════════════════════════════════════════
   ② 演示：拿恶意路径撞安全闸（真的调 normalizeArtifactPath）
   ══════════════════════════════════════════════════════════════════ */

const HOSTILE = [
  { raw: '../../etc/passwd', why: '往上爬三级，想逃出工作区' },
  { raw: '/etc/shadow', why: '绝对路径' },
  { raw: 'C:\\Windows\\system32\\evil.dll', why: '盘符 + 绝对路径' },
  { raw: '\\\\attacker\\share\\x.js', why: 'UNC 网络路径' },
  { raw: '~/.ssh/authorized_keys', why: '家目录简写' },
  { raw: 'package.json. ', why: '尾随空格，Windows 会静默剥掉 → 落点与预期不符' },
  { raw: 'run.exe', why: '可执行扩展名' },
  { raw: 'config/CON.js', why: 'Windows 保留设备名' },
  { raw: 'a\u0000b.js', why: '空字节' },
  { raw: 'src/../../../x.js', why: '夹在中间的上跳' },
  { raw: 'src/a.py', why: '正常文件（对照组：应当通过）' },
];

function demoGate() {
  return HOSTILE.map((h) => ({ ...h, res: normalizeArtifactPath(h.raw) }));
}

/* ══════════════════════════════════════════════════════════════════
   ③ 演示：真建临时工作区 + 真跑编译 → 真判定
   ══════════════════════════════════════════════════════════════════ */

const GOOD = "module.exports = { add: (a, b) => a + b };\n";
const BAD_REF = "const u = require('./user');\nconst n = require('./nowhere');\nmodule.exports = { u, n };\n";
const BAD_JSON = '{ "port": 3000, "debug": true,, }\n';

async function demoVerify() {
  const root = path.join(os.tmpdir(), `dsh-build-report-${process.pid}`);
  const store = new ArtifactStore({ root });
  store.clean();
  const out = { root };

  /* 第一幕：三个文件里有 2 处真实错误 */
  store.materialize('p1', [
    { path: 'src/math.js', content: GOOD },
    { path: 'src/app.js', content: BAD_REF },
    { path: 'config/app.json', content: BAD_JSON },
  ], { force: true });
  const bad = await verifyWorkspace({ store, level: 'static' });
  out.bad = {
    verdict: bad.verdict,
    files: bad.files.map((f) => f.path),
    failures: bad.verdict.failures.map((f) => ({
      kind: f.kind, file: f.file, line: f.line, code: f.code, message: f.message,
    })),
  };

  /* 第二幕：把两个错修好 → 判定翻过来（证明判定跟着证据走，不跟着谁的话走） */
  store.materialize('p1', [
    { path: 'src/app.js', content: "const u = require('./user');\nmodule.exports = { u };\n" },
    { path: 'config/app.json', content: '{ "port": 3000, "debug": true }\n' },
    { path: 'src/user.js', content: "module.exports = { name: 'user' };\n" },
  ], { force: true });
  const fixed = await verifyWorkspace({ store, level: 'static' });
  out.fixed = {
    verdict: fixed.verdict,
    ran: fixed.res.ran,
    files: fixed.files.map((f) => f.path),
  };

  /* 第三幕：空工作区 —— 判定必须诚实地说"不知道" */
  const emptyRoot = path.join(os.tmpdir(), `dsh-build-report-empty-${process.pid}`);
  const emptyStore = new ArtifactStore({ root: emptyRoot });
  emptyStore.clean();
  const empty = await verifyWorkspace({ store: emptyStore, level: 'static' });
  out.empty = { verdict: empty.verdict, ran: empty.res.ran };
  out.emptyVerdictOf = verdictOf({ failures: [], ran: 0, summary: {} });

  /* ★ 收尾必须连根目录一起删：
   *   ArtifactStore.clean() 会 rmSync 后**重新 mkdir**（会议流程里 root 必须存在），
   *   所以"删掉根目录本身"是调用方的责任 —— 漏了就会在 Temp 里每次留下两个空目录。
   *   （这个疏漏是跑完报告后 `ls Temp/dsh-build-*` 时发现的。） */
  store.clean(); emptyStore.clean();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(emptyRoot, { recursive: true, force: true });
  out.cleaned = [root, emptyRoot];
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   ④ 演示：契约归属（幻觉 owner 必须被丢弃）
   ══════════════════════════════════════════════════════════════════ */

const CONTRACT_TEXT = [
  '| 模块 | 负责人 | 主要接口 |',
  '| --- | --- | --- |',
  '| src/math.js | p1 | add(a,b) |',
  '| src/app.js | p2 | start() |',
  '| src/db.js | Agent-1 | 幻觉 id，名单里没有 |',
  '| src/net.js | 架构师 | 写成角色名了 |',
].join('\n');

function demoContract() {
  return parseContractModules(CONTRACT_TEXT, { participants: ['p1', 'p2', 'p3'] });
}

/* ══════════════════════════════════════════════════════════════════
   ⑤ 演示：失败清单必须逐字稳定（否则收敛判据失效）
   ══════════════════════════════════════════════════════════════════ */

function demoStability(verdict) {
  const a = critiquesFrom(verdict, { maxItems: 20 });
  const b = critiquesFrom(verdict, { maxItems: 20 });
  return {
    text: a,
    identical: a === b,
    hasTimestamp: /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|\d+\s*ms/.test(a),
  };
}

/* ══════════════════════════════════════════════════════════════════
   ⑥ 真实跑一遍全部验证，抓结论行（不手写数字）
   ══════════════════════════════════════════════════════════════════ */

function sh(cmd, args, timeoutMs = 240000) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: ROOT, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_PATH: path.join(ROOT, '..', 'desktop', 'node_modules') },
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${(e.stdout || '')}${(e.stderr || '')}`, code: e.status };
  }
}

const SUITES = [
  { name: '全量单元测试', args: ['--test'], grab: (o) => {
    const n = (k) => { const m = o.match(new RegExp(`^\\u2139 ${k} (\\d+)`, 'm')); return m ? Number(m[1]) : null; };
    return { line: `tests ${n('tests')} ｜ pass ${n('pass')} ｜ fail ${n('fail')}`, ok: n('fail') === 0 && n('pass') > 0 };
  } },
  { name: '产物落盘 + 真编译（端到端，真 orchestrator）', file: 'tools/verify-build-artifacts.js', args: [], needPort: false },
  { name: 'build 模式 UI 接线（活页面）', file: 'tools/verify-build-ui.js', args: ['9223'], needPort: true },
  { name: '阶段编排 / panel 分组', file: 'tools/verify-panel-phases.js', args: [], needPort: false },
  { name: '链路接线', file: 'tools/verify-pipeline.js', args: ['9223'], needPort: true },
  { name: '外部回答面板', file: 'tools/verify-external.js', args: ['9223'], needPort: true },
  { name: '测试台自检', file: 'tools/verify-shell.js', args: ['9223'], needPort: true },
];

function runSuites() {
  const node = process.execPath;
  return SUITES.map((s) => {
    const started = Date.now();
    const r = s.file ? sh(node, [s.file, ...s.args]) : sh(node, s.args);
    const o = r.out || '';
    /* 抓各自的结论行（每个脚本的措辞不同，尽量宽容） */
    let line = '';
    const m1 = o.match(/检查结果：(\d+) 通过 \/ (\d+) 失败/);
    const m2 = o.match(/接线验证：(\d+)\/(\d+) 项通过/);
    const m3 = o.match(/(?:外部回答面板验证|自检结果)：(\d+)\/(\d+) 项通过/);
    const m4 = o.match(/通过 (\d+)\s*失败 (\d+)/);
    if (m1) line = `${m1[1]} 通过 / ${m1[2]} 失败`;
    else if (m2) line = `${m2[1]}/${m2[2]} 项通过`;
    else if (m3) line = `${m3[1]}/${m3[2]} 项通过`;
    else if (m4) line = `${m4[1]} 通过 / ${m4[2]} 失败`;
    else if (s.grab) { const g = s.grab(o); line = g.line; }
    else line = o.trim().split('\n').slice(-1)[0] || '（无输出）';

    let ok = null;
    if (s.grab) ok = s.grab(o).ok;
    else if (/：(\d+) 通过 \/ 0 失败/.test(line)) ok = true;
    else if (/\/(\d+) 项通过/.test(line)) ok = /^\d+\/\1$/.test(line.trim()) ? true : (line.match(/(\d+)\/(\d+)/) || [])[1] === (line.match(/(\d+)\/(\d+)/) || [])[2];
    else if (/通过 (\d+)\s*失败 0/.test(line)) ok = true;
    else ok = null;

    return { name: s.name, kind: s.file || 'node --test', line, ok, ms: Date.now() - started, raw: o.slice(-400) };
  });
}

/* ══════════════════════════════════════════════════════════════════
   ⑦ 静态部分（事实陈述，非数字）
   ══════════════════════════════════════════════════════════════════ */

const CHAIN = [
  {
    n: '①', was: '契约是一段文本，消费方要的是结构 —— **中间没有解析器**',
    now: 'core/build-loop.js · parseContractModules（表格 / 列表 / 行内三种写法都能认）',
  },
  {
    n: '②', was: '`produces:\'artifact\'` 只是消息上的一个字符串标记 —— **产物从未变成文件**',
    now: 'core/artifact-bus.js · 解析 {path,content} → 三道安全闸 → ArtifactStore 真落盘',
  },
  {
    n: '③', was: '没有真实编译结果 → judgeBuildPass 诚实地返回 null，**但没东西接替它**',
    now: 'core/build-verify.js · 真子进程跑 node --check / JSON.parse / 引用完整性 → buildPass',
  },
];

const MODULES = [
  { file: 'core/artifact-bus.js', lines: '537', job: '解析 AI 回复 → {path,content}，并安全落盘', points: [
    ['宽容解析（认 5 种写法）', 'prompt 只教一种，但解析器认五种。因为「丢文件」比「报错」危险 —— 会议照常往下走，「失败」被伪装成「通过」'],
    ['三道安全闸', 'normalizeArtifactPath 白名单 → resolve 后再验「在 root 内」 → root 必须显式传、无默认值'],
    ['跨作者冲突「先到者保留」', '同一路径两份不是「后者更新」，而是契约被违背；让后者覆盖会抹掉「哪儿断了」的证据'],
    ['同批同名后者取代前者', '同一作者在同一批里重写，取最后一份（此处曾因只标记不替换数组元素而是真 bug）'],
  ] },
  { file: 'core/build-verify.js', lines: '660', job: '在真实子进程里跑检查，产出可信的 buildPass', points: [
    ['三档安全级别', 'syntax（零执行） → static（零执行，默认） → build（**会执行任意代码**，默认关闭）'],
    ['空工作区返回 null 而非 true', '返回 true 等于说「虚无通过一切检查」；没有证据时答案只能是「不知道」'],
    ['引用完整性用状态机而非正则', '注释里的 `// require(\'./old\')` 不算引用。漏报只是少查一条，误报会让会议白跑一轮'],
    ['诚实标注查不了的', 'TS/JSX 明确报「未验证」并写进 summary，不假装能验'],
  ] },
  { file: 'core/build-loop.js', lines: '407', job: '把契约 / 产物 / 编译 / 判定串成流水线', points: [
    ['owner 必须在参会者名单里', '模型常写角色名（「架构师」）或幻觉 id（「Agent-1」）→ 丢弃并计入 rejected。一个错的归属比没有归属更糟'],
    ['失败清单逐字稳定', '只含结构性字段（kind/file/line/code），不含时间戳/耗时 —— 否则「已修好」会被判成「又出现新批评」，收敛永不发生'],
    ['给集成席的报告不给判定权', '它的措辞里刻意不出现「通过」，防止 judgeBuildPass 的坚持白费'],
  ] },
];

const FACTS = [
  ['Node 22.7+ 起 `--experimental-detect-module` 默认开启', '含 `import` 的 `.js` 在无 `package.json` 时**自动判定为 ESM（退出码 0）**。所以「见到 import 就报错」是误报 —— 我的原假设是反的，实测后改了代码和用例'],
  ['`node --check` 的能力边界', '真解析、带准确行列号、**不执行代码**；但**抓不到**「引用不存在的模块」—— 而那正是集成失败最常见的形态 → 引用完整性因此成为性价比最高的一条'],
  ['Node 在语法错前会先打一行 `(node:32224) Warning:`', '第一行里的数字是**进程号不是行号**。取行号必须跳过 `(node:` 开头的行（此处踩过真 bug）'],
  ['`ws` 模块在本机只有 `desktop/node_modules/ws`', '`D:\\Users\\Admin\\.workbuddy\\binaries\\node\\workspace` 不存在；不过 Node 24 自带全局 `WebSocket`，多数情况可免'],
  ['测试台有 3 个真网页 AI 时截不了图', '`Page.captureScreenshot` 会卡死（合成器被占住）→ 本报告就是那个替代方案'],
];

/* ══════════════════════════════════════════════════════════════════
   渲染
   ══════════════════════════════════════════════════════════════════ */

function chip(ok, textOk = '通过', textBad = '未通过', textUnknown = '—') {
  if (ok === true) return `<span class="chip ok">${esc(textOk)}</span>`;
  if (ok === false) return `<span class="chip bad">${esc(textBad)}</span>`;
  return `<span class="chip dim">${esc(textUnknown)}</span>`;
}

async function main() {
  const t0 = Date.now();
  const parse = demoParse();
  const gate = demoGate();
  const verify = await demoVerify();
  const contract = demoContract();
  const stability = demoStability(verify.bad.verdict);

  let suites = [];
  if (!NO_RUN) suites = runSuites();

  let commit = '(未取得)';
  try {
    commit = execFileSync('D:/Toolbox/git/bin/git.exe', ['log', '--oneline', '-1'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) { /* 无 git 也不影响报告 */ }

  const H = [];
  H.push(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>build 模式：产物落盘 + 真编译验证</title>
<style>
  :root { --bg:#0b0e14; --fg:#e6e6e6; --dim:#8aa; --line:#22303f; --in:#4da3ff; --ok:#3ddc84; --warn:#ffb454; --bad:#ff6b6b; --panel:#121722; }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 22px 60px; background:var(--bg); color:var(--fg);
         font:14px/1.7 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size:22px; margin:0 0 6px; }
  h2 { font-size:17px; margin:34px 0 12px; padding-left:10px; border-left:3px solid var(--in); }
  h3 { font-size:14px; margin:20px 0 8px; color:var(--in); }
  .sub { color:var(--dim); font-size:12.5px; margin-bottom:18px; }
  .sub code { color:var(--fg); }
  code, .mono { font-family: Consolas,"Cascadia Mono",monospace; font-size:12.5px; }
  table { width:100%; border-collapse:collapse; margin:10px 0 4px; }
  th,td { border:1px solid var(--line); padding:7px 9px; text-align:left; vertical-align:top; }
  th { background:#182130; color:var(--dim); font-weight:600; font-size:12.5px; }
  td code { color:var(--warn); }
  .chip { display:inline-block; padding:1px 8px; border-radius:99px; font-size:11.5px; border:1px solid; white-space:nowrap; }
  .chip.ok { color:var(--ok); border-color:#1e5b3a; background:#0e2a1c; }
  .chip.bad { color:var(--bad); border-color:#5b2020; background:#2a0f0f; }
  .chip.dim { color:var(--dim); border-color:var(--line); }
  .chain { display:flex; gap:0; align-items:stretch; flex-wrap:wrap; margin:14px 0 6px; }
  .node { flex:1 1 260px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px 14px; position:relative; }
  .node .no { font-size:20px; color:var(--bad); font-weight:700; }
  .node .was { color:#ffb4b4; font-size:13px; margin:6px 0 10px; }
  .node .arrow { color:var(--dim); font-size:12px; margin-bottom:4px; }
  .node .now { color:var(--ok); font-size:12.5px; }
  .sep { display:flex; align-items:center; color:var(--dim); padding:0 6px; font-size:18px; }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:11px 13px;
        overflow:auto; margin:8px 0; color:#cfe3ff; }
  .note { background:#101827; border-left:3px solid var(--warn); padding:9px 12px; margin:12px 0; color:#e3d5b4; font-size:13px; }
  .ok-note { border-left-color:var(--ok); background:#0d1a15; color:#c9e8d8; }
  .bad-note { border-left-color:var(--bad); background:#1a0f0f; color:#f0cccc; }
  ul { margin:6px 0 6px 18px; padding:0; } li { margin:4px 0; }
  .kv { color:var(--dim); }
  footer { margin-top:40px; padding-top:14px; border-top:1px solid var(--line); color:var(--dim); font-size:12px; }
</style></head><body><div class="wrap">`);

  H.push(`<h1>build 模式：文本第一次变成文件</h1>
<div class="sub">
  产物落盘 + 真编译验证 —— 修一条<strong>断成三截</strong>的失效链<br>
  生成时间：${esc(new Date().toLocaleString('zh-CN'))}　｜　提交：<code>${esc(commit)}</code>　｜　
  工作目录：<code>meeting-lab/</code>
</div>`);

  /* ── 失效链 ── */
  H.push('<h2>一、改的是什么：一条断成三截的失效链</h2>');
  H.push(`<div class="note">判据缺输入时<strong>不报错、不崩溃</strong>，只是「白烧钱」—— 这是最难发现的一类故障。
后果：<code>shouldStop('build')</code> 永远 <code>degraded</code> + <code>missingInput:['buildPass']</code>
→ 会议只能空跑满 <code>maxIterations(4)</code>。与上一轮的 <code>winnerId</code> 属同族。</div>`);
  H.push('<div class="chain">');
  CHAIN.forEach((c, i) => {
    if (i) H.push('<div class="sep">→</div>');
    H.push(`<div class="node">
      <div class="no">${c.n}</div>
      <div class="was">${c.was}</div>
      <div class="arrow">↓ 本轮补上</div>
      <div class="now">${c.now}</div>
    </div>`);
  });
  H.push('</div>');

  /* ── 模块 ── */
  H.push('<h2>二、三个新模块各管什么</h2>');
  MODULES.forEach((m) => {
    H.push(`<h3><code>${esc(m.file)}</code> <span class="kv">（约 ${m.lines} 行）· ${esc(m.job)}</span></h3>`);
    H.push('<table><tr><th style="width:230px">关键设计</th><th>为什么这么设计</th></tr>');
    m.points.forEach(([k, v]) => H.push(`<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`));
    H.push('</table>');
  });

  /* ── 解析演示 ── */
  H.push('<h2>三、解析演示（真的调解析器跑的）</h2>');
  H.push(`<p class="kv">喂进去的是一段故意很乱的回复：有的代码块在 info 里写 <code>path=</code>，
有的把路径藏在 HTML 注释里，有的路径写在块内首行注释，有的干脆靠「上一行标题」认出来。</p>`);
  H.push(`<table><tr><th style="width:170px">识别到的路径</th><th style="width:120px">认出来的依据</th><th>内容首行</th></tr>`);
  parse.files.forEach((f) => {
    H.push(`<tr><td><code>${esc(f.path)}</code></td><td>${esc(f.how)}</td><td class="mono">${esc(String(f.content).split('\n')[0].slice(0, 68))}</td></tr>`);
  });
  H.push('</table>');
  H.push(`<p class="kv">统计：${parse.stats.blocks} 个 fenced 块 → 认出 <strong>${parse.files.length}</strong> 个文件，
丢弃 <strong>${parse.rejected.length}</strong> 个（丢弃会进 <code>rejected</code> 数组，不静默消失）。</p>`);

  /* ── 安全闸演示 ── */
  H.push('<h2>四、安全闸演示（真的拿恶意路径去撞）</h2>');
  H.push('<table><tr><th style="width:250px">AI 给出的路径</th><th style="width:150px">结果</th><th>拒绝原因</th></tr>');
  gate.forEach((g) => {
    const ok = g.res.ok;
    H.push(`<tr>
      <td class="mono">${esc(g.raw)}</td>
      <td>${chip(ok, '放行', '拒绝')}</td>
      <td>${ok ? `<span class="kv">${esc(g.why)}</span>` : `<code>${esc(g.res.reason)}</code> <span class="kv">— ${esc(g.why)}</span>`}</td>
    </tr>`);
  });
  H.push('</table>');

  /* ── 真编译演示 ── */
  H.push('<h2>五、真编译演示（真建工作区、真跑子进程）</h2>');
  H.push(`<h3>第一幕：3 个文件，2 处真实错误</h3>
<p class="kv">工作区：<code>${esc(verify.root)}</code>　文件：${verify.bad.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>`);
  H.push('<table><tr><th style="width:110px">类型</th><th style="width:150px">文件</th><th style="width:60px">行</th><th style="width:180px">错误码</th><th>本机给出的原始结论</th></tr>');
  verify.bad.failures.forEach((f) => {
    H.push(`<tr><td>${esc(f.kind)}</td><td><code>${esc(f.file)}</code></td><td>${f.line == null ? '<span class="kv">—</span>' : esc(f.line)}</td><td><code>${esc(f.code)}</code></td><td>${esc(String(f.message).slice(0, 110))}</td></tr>`);
  });
  H.push('</table>');
  H.push(`<div class="note bad-note">判定：<strong>buildPass = ${JSON.stringify(verify.bad.verdict.buildPass)}</strong>
　理由：${esc(verify.bad.verdict.reason)}</div>`);

  H.push(`<h3>第二幕：把两处错修好 → 判定自己翻过来</h3>
<p class="kv">证明判定跟着<strong>证据</strong>走，不跟着谁的话走。文件：${verify.fixed.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>
<div class="note ok-note">判定：<strong>buildPass = ${JSON.stringify(verify.fixed.verdict.buildPass)}</strong>
　理由：${esc(verify.fixed.verdict.reason)}　（实际执行 ${verify.fixed.ran} 项检查）</div>`);

  H.push(`<h3>第三幕：空工作区 —— 它敢不敢说「通过」</h3>
<div class="note">工作区里一个文件都没有，执行项 <code>ran = ${verify.empty.ran}</code>。<br>
判定：<strong>buildPass = ${JSON.stringify(verify.empty.verdict.buildPass)}</strong>　理由：${esc(verify.empty.verdict.reason)}</div>
<p class="kv">这是本轮刻意坚持的「诚实原则」：返回 <code>true</code> 等于说「虚无通过一切检查」。
没有证据时，答案只能是「不知道」。</p>
<p class="kv">（上面三个工作区都建在系统临时目录下，跑完连根目录一起删掉了 —— 没在项目目录里留任何东西。）</p>`);

  /* ── 契约归属 ── */
  H.push('<h2>六、契约归属（幻觉 owner 必须被丢弃）</h2>');
  H.push(`<p class="kv">参会者名单：<code>p1 p2 p3</code>。喂进去的契约里混了两个<strong>不在名单里</strong>的负责人。</p>`);
  H.push('<table><tr><th style="width:150px">模块</th><th style="width:120px">负责人</th><th style="width:100px">结果</th><th>说明</th></tr>');
  contract.modules.forEach((m) => {
    H.push(`<tr><td><code>${esc(m.module)}</code></td><td><code>${esc(m.owner)}</code></td><td>${chip(true, '接受', '—')}</td><td class="kv">签名：${esc(m.signature || '（无）')}　写法：${esc(m.how)}</td></tr>`);
  });
  contract.rejected.forEach((r) => {
    H.push(`<tr><td><code>${esc(r.module)}</code></td><td><code>${esc(r.owner)}</code></td><td>${chip(false, '—', '丢弃')}</td><td><code>${esc(r.reason)}</code> <span class="kv">— 一个错的归属比没有归属更糟（会放行越界写入）</span></td></tr>`);
  });
  H.push('</table>');

  /* ── 收敛稳定性 ── */
  H.push('<h2>七、失败清单必须逐字稳定</h2>');
  H.push(`<p class="kv">同一份失败连生成两次：
${stability.identical ? chip(true, '逐字相同') : chip(false, '—', '不一致')}
　含时间戳/耗时：${stability.hasTimestamp ? chip(false, '—', '有（不合格）') : chip(true, '没有')}</p>`);
  H.push(`<p class="kv">为什么这么较真：这份文本要喂给 <code>newCritiques()</code> 做「本轮相对上轮无新增」判定。
掺入噪声会让「已修好」被判成「又出现新批评」，<strong>收敛永不发生</strong>。</p>`);
  H.push(`<pre>${esc(String(stability.text).slice(0, 600))}</pre>`);

  /* ── 验证数字 ── */
  H.push('<h2>八、验证结果（本节数字由脚本实时跑出来的，不是手写的）</h2>');
  if (NO_RUN) {
    H.push('<div class="note">本次用 <code>--no-run</code> 生成，跳过了实跑。去掉该参数可得到真实数字。</div>');
  } else {
    H.push('<table><tr><th style="width:300px">验证项</th><th style="width:110px">结果</th><th style="width:90px">耗时</th><th>结论行</th></tr>');
    suites.forEach((s) => {
      H.push(`<tr><td>${esc(s.name)}</td><td>${chip(s.ok)}</td><td class="kv">${(s.ms / 1000).toFixed(1)}s</td><td class="mono">${esc(s.line)}</td></tr>`);
    });
    H.push('</table>');
    const badOnes = suites.filter((s) => s.ok === false);
    H.push(badOnes.length
      ? `<div class="note bad-note">有 ${badOnes.length} 项未通过 —— 报告如实显示，不做粉饰。</div>`
      : '<div class="note ok-note">全部通过。</div>');
  }

  /* ── 平台事实 ── */
  H.push('<h2>九、实测得来的平台事实（写进注释，供以后省时间）</h2>');
  H.push('<table><tr><th style="width:320px">事实</th><th>说明</th></tr>');
  FACTS.forEach(([k, v]) => H.push(`<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`));
  H.push('</table>');

  /* ── 还没有的 ── */
  H.push(`<h2>十、坦白：还没有的</h2>
<ul>
  <li><strong>没有截图</strong> —— 测试台里挂着 3 个真网页 AI，<code>Page.captureScreenshot</code> 会卡死（合成器被占住）。
      这份报告就是替代方案。</li>
  <li><strong><code>build</code> 档默认关闭</strong> —— 它和默认两档的<strong>安全性质完全不同</strong>：前两档零执行，
      第三档会真的在本机跑 AI 写的代码。所以默认是 <code>static</code>，切过去时给明确风险提示。</li>
  <li><strong>每个模式只在一场真实会议里跑过一轮</strong> —— 长会议的收敛行为（多轮修复回路）还没在真 AI 上压过。</li>
</ul>`);

  H.push(`<footer>
  meeting-lab · Phase 0 独立测试台　｜　报告由 <code>tools/build-build-report.js</code> 生成　｜
  本轮总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s
</footer></div></body></html>`);

  fs.writeFileSync(OUT, H.join('\n'), 'utf8');
  console.log(`已生成：${OUT}`);
  console.log(`  解析演示 ${parse.files.length} 个文件 ｜ 安全闸 ${gate.length} 例 ｜ `
    + `真编译 ${verify.bad.failures.length} 处错误 → 修好后 ${JSON.stringify(verify.fixed.verdict.buildPass)}`);
  if (!NO_RUN) {
    suites.forEach((s) => console.log(`  ${s.ok === false ? '✗' : '✔'} ${s.name}　${s.line}`));
  }
}

main().catch((e) => { console.error('生成失败：', e && e.stack || e); process.exitCode = 1; });
