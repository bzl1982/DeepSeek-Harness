'use strict';
/**
 * test/build-verify.test.js —— 真编译验证：buildPass 是不是**可信**的
 *
 * 这个文件里最要紧的一条断言是：
 *     模型自述"全部通过、可以交付" **不能**把 verdict 翻成通过。
 * 因为那正是 judgeBuildPass 存在的理由（它宁可返回 null 也不采信模型的自我评价），
 * 而本层是它等着的那个"真实执行结果"。
 *
 * 次要但同样重要的一组：**不许误报**。
 * 误报不是"保守"，它的代价是让会议白跑一轮修复回路 —— 所以
 * 注释里的 require、字符串里的示例、外链 CDN、HTML 注释掉的标签，都必须不被算作问题。
 *
 * 全部在真实临时目录里跑真子进程（node --check），无 mock。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  planVerification, runVerification, verdictOf, feedbackText, verdictLine,
  extractRelativeRefs, extractHtmlRefs, resolveRef, diagnoseSyntax,
} = require('../core/build-verify');

let _n = 0;
const tmpRoot = (tag) => path.join(os.tmpdir(), `dsh-bv-test-${process.pid}-${_n++}-${tag}`);
const cleanup = (root) => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* ignore */ } };

function walkDir(root) {
  const out = [];
  const rec = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { rec(abs); continue; }
      out.push({ path: path.relative(root, abs).split(path.sep).join('/'), absPath: abs });
    }
  };
  rec(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 造一个真工作区 → 规划 → 执行 → 判定 */
async function rig(files, { level = 'static', pkg = null } = {}) {
  const root = tmpRoot('rig');
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  /* ★ pkg 要真的写进磁盘 —— Node 的模块类型判定读的就是工作区里这份 package.json，
   *   只传给 planVerification 是测不到真实行为的。 */
  if (pkg) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg), 'utf8');

  const list = walkDir(root);
  // 让 planVerification 也看到磁盘上的 package.json
  const effPkg = pkg || (list.some((f) => f.path === 'package.json')
    ? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) : null);
  const plan = planVerification({ files: list, level, pkg: effPkg });
  const res = await runVerification(plan, { root, files: list });
  return { root, list, plan, res, v: verdictOf(res), done: () => cleanup(root) };
}

/* ══════════════════════════════════════════════════════════════════
   ① 语法：真的抓到错，且不误报对的
   ══════════════════════════════════════════════════════════════════ */

test('语法正确的 JS 不误报', async () => {
  const r = await rig({
    'ok.js': 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n',
  });
  try {
    assert.strictEqual(r.v.buildPass, true, '干净的产物必须判通过');
    assert.strictEqual(r.v.errors.length, 0);
    assert.ok(r.res.summary.byKind.syntax.ran >= 1, '确实跑了 node --check');
  } finally { r.done(); }
});

test('★ 语法错误的 JS 被抓到，并带出准确行号', async () => {
  const r = await rig({
    'broken.js': 'const a = 1;\nconst b = 2;\nfunction oops( {\n  return 3;\n}\n',
  });
  try {
    assert.strictEqual(r.v.buildPass, false);
    const f = r.v.errors.find((x) => x.file === 'broken.js');
    assert.ok(f, '必须有 broken.js 的错误条目');
    assert.strictEqual(f.kind, 'syntax');
    assert.strictEqual(f.code, 'syntax-error');
    assert.ok(f.line >= 2, `行号应被解析出来（实际 ${f.line}）`);
    assert.ok(f.message.length > 0, '要有原始报错文本（给 AI 修用）');
  } finally { r.done(); }
});

test('★ 平台事实：无 package.json 时含 import 的 .js **不该**被判错（Node 22.7+ 自动检测 ESM）', async () => {
  /* 这一条是实测出来的（Node 24.19）：
   *   Node 22.7+ 起 --experimental-detect-module 默认开启，一个含 import 的 .js
   *   在没有 package.json 时会被自动判定为 ESM —— **它是能跑起来的**。
   *   所以"文件里有 import 就报错"是**误报**，代价是让会议白跑一轮修复。
   *   这条用例的价值是把它钉住：将来谁把诊断改成"见到 import 就报错"，会立刻红。 */
  const r = await rig({ 'a.js': "import fs from 'fs';\nexport default fs;\n" });
  try {
    assert.strictEqual(r.v.buildPass, true, '★ 自动检测 ESM 是合法产物，不许误报');
  } finally { r.done(); }
});

test('★ type:commonjs + import → 真报错，并给出可操作的专门诊断', async () => {
  const r = await rig(
    { 'a.js': "import fs from 'fs';\nexport default fs;\n" },
    { pkg: { name: 'demo', type: 'commonjs' } },
  );
  try {
    assert.strictEqual(r.v.buildPass, false);
    const f = r.v.errors.find((x) => x.file === 'a.js');
    assert.ok(f, '必须有 a.js 的错误');
    assert.strictEqual(f.code, 'esm-without-module-type');
    assert.ok(f.hint.includes('type'), '提示要告诉用户怎么补，而不是只说"语法错"');
    assert.strictEqual(f.line, 1, '★ 行号要能穿过前面那行 (node:NNNN) Warning 取到');
  } finally { r.done(); }
});

test('diagnoseSyntax：跳过 (node:NNNN) Warning 行取到真实行号', () => {
  // 这是 Node 在 type:commonjs + import 场景下的**真实** stderr 形态
  const d = diagnoseSyntax('esm.js', {
    stderr: [
      '(node:32224) Warning: Failed to load the ES module: D:\\t\\esm.js. Make sure to set "type": "module" in the nearest package.json file or use the .mjs extension.',
      '(Use `node --trace-warnings ...` to show where the warning was created)',
      'D:\\t\\esm.js:1',
      'import fs from "fs";',
      '^^^^^^',
      '',
      'SyntaxError: Cannot use import statement outside a module',
      '    at wrapSafe (node:internal/modules/cjs/loader:1804:18)',
    ].join('\n'),
  });
  assert.strictEqual(d.code, 'esm-without-module-type');
  assert.strictEqual(d.line, 1, '★ 不能把进程号 (node:32224) 当成行号，也不能返回 null');
  assert.ok(d.message.includes('Cannot use import statement'));
});

test('diagnoseSyntax：普通语法错也能取到行号与消息', () => {
  const d = diagnoseSyntax('x.js', {
    stderr: 'D:\\t\\x.js:3\nconst a = ;\n        ^\n\nSyntaxError: Unexpected token \';\'\n    at ...',
  });
  assert.strictEqual(d.line, 3);
  assert.strictEqual(d.code, 'syntax-error');
  assert.ok(d.message.includes('Unexpected token'));
});

/* ══════════════════════════════════════════════════════════════════
   ② JSON
   ══════════════════════════════════════════════════════════════════ */

test('坏 JSON 被抓到；好 JSON 不误报', async () => {
  const r = await rig({
    'good.json': '{"name":"demo","version":"1.0.0"}',
    'bad.json': '{"a":1,,}',
  });
  try {
    assert.strictEqual(r.v.buildPass, false);
    assert.strictEqual(r.v.errors.length, 1);
    assert.strictEqual(r.v.errors[0].file, 'bad.json');
    assert.strictEqual(r.v.errors[0].code, 'invalid-json');
  } finally { r.done(); }
});

/* ══════════════════════════════════════════════════════════════════
   ③ ★ 引用完整性 —— 本层性价比最高的一条（node --check 抓不到）
   ══════════════════════════════════════════════════════════════════ */

test('★ 引用了不存在的模块 → 抓到（语法完全正确，--check 抓不到）', async () => {
  const r = await rig({
    'src/app.js': "const { add } = require('./util');\nconst { x } = require('./nowhere');\nmodule.exports = { add, x };\n",
    'src/util.js': 'module.exports = { add: (a, b) => a + b };\n',
  });
  try {
    assert.strictEqual(r.v.buildPass, false);
    const f = r.v.errors.find((x) => x.code === 'missing-ref');
    assert.ok(f, '必须报出缺失引用');
    assert.strictEqual(f.file, 'src/app.js');
    assert.strictEqual(f.ref, './nowhere');
    assert.ok(f.message.includes('src/nowhere'), '要说清楚缺的是哪个文件');
  } finally { r.done(); }
});

test('引用存在（含省略扩展名）→ 不误报', async () => {
  const r = await rig({
    'src/app.js': "const { add } = require('./util');\nmodule.exports = add;\n",
    'src/util.js': 'module.exports = { add: 1 };\n',
  });
  try {
    assert.strictEqual(r.v.buildPass, true, "require('./util') 应补全成 util.js 后命中");
  } finally { r.done(); }
});

test('引用目录 → 补全 index.js', async () => {
  const r = await rig({
    'src/app.js': "const u = require('./lib');\nmodule.exports = u;\n",
    'src/lib/index.js': 'module.exports = {};\n',
  });
  try {
    assert.strictEqual(r.v.buildPass, true);
  } finally { r.done(); }
});

test('★ 注释里 / 字符串里的 require 不算引用（误报会让会议白跑一轮）', async () => {
  const r = await rig({
    'a.js': [
      "const a = require('./real');",
      "// 注意：不要写成 require('./comment-only')",
      'const demo = "require(\'./in-string\')";',
      "/* 块注释里的 require('./in-block') 也不算 */",
      'module.exports = { a, demo };',
    ].join('\n') + '\n',
    'real.js': 'module.exports = {};\n',
  });
  try {
    assert.strictEqual(r.v.buildPass, true,
      '★ 注释与字符串里的示例路径不该被算作缺失引用');
  } finally { r.done(); }
});

test('export … from / 动态 import / side-effect import 都算引用', async () => {
  const r = await rig({
    'a.js': [
      "export { x } from './gone1';",
      "export const load = () => import('./gone2');",
      "import './gone3';",
    ].join('\n') + '\n',
  });
  try {
    const refs = r.v.errors.map((f) => f.ref).sort();
    assert.deepStrictEqual(refs, ['./gone1', './gone2', './gone3']);
  } finally { r.done(); }
});

test('extractRelativeRefs：裸模块名不归本层（react/fs 不该被当本地文件查）', () => {
  const refs = extractRelativeRefs("const a = require('react');\nconst b = require('node:fs');\nconst c = require('./x');\n");
  assert.deepStrictEqual(refs.map((r) => r.spec), ['./x']);
});

test('★ 相对路径逃出工作区 → 单独的错误码（不是笼统的 missing）', async () => {
  const r = await rig({
    'a.js': "const x = require('../../outside');\nmodule.exports = x;\n",
  });
  try {
    const f = r.v.errors.find((x) => x.kind === 'refs');
    assert.ok(f);
    assert.strictEqual(f.code, 'ref-escapes-workspace');
  } finally { r.done(); }
});

test('resolveRef：命中 / 未命中 / 逃逸 三种情形', () => {
  const have = new Set(['src/util.js', 'lib/index.js']);
  assert.deepStrictEqual(resolveRef('src/app.js', './util', have), { ok: true, target: 'src/util.js' });
  assert.deepStrictEqual(resolveRef('src/app.js', './nope', have), { ok: false, reason: 'missing', target: 'src/nope' });
  assert.strictEqual(resolveRef('src/app.js', '../../etc', have).reason, 'escapes-workspace');
  assert.deepStrictEqual(resolveRef('a.js', './lib', have), { ok: true, target: 'lib/index.js' });
});

/* ══════════════════════════════════════════════════════════════════
   ④ HTML
   ══════════════════════════════════════════════════════════════════ */

test('★ HTML 引用了不存在的本地脚本 → 抓到；外链/锚点/注释掉的 → 不算', async () => {
  const r = await rig({
    'index.html': [
      '<html><head>',
      '<link href="style.css" rel="stylesheet">',
      '<script src="https://cdn.example.com/lib.js"></script>',
      '<!-- <script src="commented.js"></script> -->',
      '<img src="#icon">',
      '</head><body><script src="app.js"></script></body></html>',
    ].join('\n'),
    'style.css': 'body { margin: 0; }\n',
    'app.js': 'console.log(1);\n',
  });
  try {
    assert.strictEqual(r.v.buildPass, true, 'app.js/style.css 都在，不该报错');
    const refs = extractHtmlRefs(fs.readFileSync(path.join(r.root, 'index.html'), 'utf8'));
    assert.deepStrictEqual(refs.map((x) => x.spec).sort(), ['app.js', 'style.css']);
  } finally { r.done(); }
});

test('HTML 引用了缺失的 script → 报出来', async () => {
  const r = await rig({
    'index.html': '<html><body><script src="missing.js"></script></body></html>',
  });
  try {
    assert.strictEqual(r.v.buildPass, false);
    assert.strictEqual(r.v.errors[0].code, 'missing-ref');
    assert.strictEqual(r.v.errors[0].ref, 'missing.js');
  } finally { r.done(); }
});

/* ══════════════════════════════════════════════════════════════════
   ⑤ 诚实原则：验证不了就说"未验证"
   ══════════════════════════════════════════════════════════════════ */

test('★ TS/JSX 文件 → 记 skipped 而不是假装通过或误报', async () => {
  const r = await rig({ 'a.ts': 'const x: number = 1;\nexport default x;\n' });
  try {
    const sk = r.plan.skipped.find((s) => s.reason === 'no-ts-compiler');
    assert.ok(sk, 'TS 必须被标成"未验证"');
    assert.strictEqual(sk.file, 'a.ts');
    assert.deepStrictEqual(r.v.unverified, ['a.ts'], 'verdict 要带上"未验证清单"');
  } finally { r.done(); }
});

test('未知扩展名 → skip 并说明，不静默当通过', () => {
  const plan = planVerification({ files: [{ path: 'a.weird', absPath: '/x/a.weird' }], level: 'static' });
  const sk = plan.skipped.find((s) => s.file === 'a.weird');
  assert.ok(sk);
  assert.strictEqual(sk.reason, 'unknown-ext');
});

test('★ 空工作区 → buildPass 是 null（**不许**因"没发现错"就返回 true）', async () => {
  const r = await rig({});
  try {
    assert.strictEqual(r.v.buildPass, null,
      '★ 没有证据时答案只能是"不知道" —— 这正是 judgeBuildPass 拒绝犯的错');
    assert.ok(r.v.reason.includes('没有任何检查可执行'));
  } finally { r.done(); }
});

test('全部文件都无法验证（只有 TS）→ 仍不返回 true', async () => {
  const r = await rig({ 'a.ts': 'export const a = 1;\n', 'b.tsx': 'export const B = () => null;\n' });
  try {
    assert.strictEqual(r.v.buildPass, null, '一项可执行的检查都没有 → 不撒谎');
    assert.strictEqual(r.v.unverified.length, 2);
  } finally { r.done(); }
});

/* ══════════════════════════════════════════════════════════════════
   ⑥ 档位：默认不执行任何 AI 写的代码
   ══════════════════════════════════════════════════════════════════ */

test('★ 默认档位（static）不跑 npm —— 执行任意代码必须显式开启', async () => {
  const r = await rig({ 'a.js': 'module.exports = 1;\n' }, {
    pkg: { scripts: { build: 'node build.js' } },
  });
  try {
    const sk = r.plan.skipped.find((s) => s.kind === 'build');
    assert.ok(sk, '默认档位应跳过构建');
    assert.strictEqual(sk.reason, 'level-disabled');
    assert.ok(!r.res.results.some((x) => x.kind === 'build'), '★ 不该有任何 build 步骤真的执行');
  } finally { r.done(); }
});

test('level:syntax 连引用检查都不做（纯语法档）', () => {
  const plan = planVerification({
    files: [{ path: 'a.js', absPath: '/x/a.js' }], level: 'syntax',
  });
  assert.ok(!plan.steps.some((s) => s.kind === 'refs'));
  assert.ok(plan.steps.some((s) => s.kind === 'syntax'));
});

test('level:build 但 package.json 没有 scripts.build → skip 并说明', () => {
  const plan = planVerification({
    files: [{ path: 'a.js', absPath: '/x/a.js' }], level: 'build', pkg: { scripts: { test: 'x' } },
  });
  const sk = plan.skipped.find((s) => s.kind === 'build');
  assert.strictEqual(sk.reason, 'no-build-script');
});

test('level:build 且有构建脚本 → 计划里出现 build 步骤', () => {
  const plan = planVerification({
    files: [{ path: 'a.js', absPath: '/x/a.js' }],
    level: 'build',
    pkg: { scripts: { build: 'node build.js' } },
    nodePath: process.execPath,
    npmPath: path.join(path.dirname(process.execPath), 'npm.cmd'),
  });
  const step = plan.steps.find((s) => s.kind === 'build');
  // 本机可能存在也可能不存在 npm；两种结果都必须是"有步骤"或"有明确 skip 原因"
  if (step) assert.deepStrictEqual(step.args, ['run', 'build']);
  else assert.ok(plan.skipped.some((s) => s.kind === 'build' && s.reason === 'npm-not-found'));
});

/* ══════════════════════════════════════════════════════════════════
   ⑦ ★ 判定与反馈
   ══════════════════════════════════════════════════════════════════ */

test('★ 模型自述"全部通过、可以交付"不能改变 verdict —— 只有执行结果算数', async () => {
  const r = await rig({ 'bad.js': 'function oops( {\n  return 1;\n}\n' });
  try {
    /* 这一刻，某个 AI 在会议上说"我已经全部检查通过，可以交付了"。
     * judgeBuildPass 会对这句话返回 pass=null（不采信）。
     * 本层的职责是：verdict 只反映**真实执行结果**，任何自我评价都插不进来。 */
    const before = r.v.buildPass;
    assert.strictEqual(before, false);
    const v2 = verdictOf(r.res);           // 再算一次，结果不能变
    assert.strictEqual(v2.buildPass, false, '★ 判定必须只来自执行结果，不可被自述覆盖');
    assert.ok(v2.reason.includes('本机执行结果'), '理由要显式声明可信度来源');
  } finally { r.done(); }
});

test('verdictLine 三态可读', () => {
  assert.ok(verdictLine({ buildPass: true, reason: 'x' }).startsWith('✔'));
  assert.ok(verdictLine({ buildPass: false, reason: 'x' }).startsWith('✗'));
  assert.ok(verdictLine({ buildPass: null, reason: 'x' }).startsWith('?'));
  assert.strictEqual(verdictLine(null), '（无验证结果）');
});

test('★ feedbackText 必须带三条硬要求（否则修复回路会退化成"重写整个项目"）', async () => {
  const r = await rig({
    'bad.js': 'function oops( {\n  return 1;\n}\n',
    'app.js': "const x = require('./nowhere');\nmodule.exports = x;\n",
  });
  try {
    const txt = feedbackText(r.v);
    assert.ok(txt.includes('本机真实检查结果'), '① 要声明这是执行结果，不是某个 AI 的意见');
    assert.ok(txt.includes('bad.js'), '② 要带文件名');
    assert.ok(txt.includes('第 2 行'), '② 要带行号');
    assert.ok(txt.includes('不要重写整个文件'), '③ 要限制改动范围');
    assert.ok(txt.includes('只交回**你改动过的文件**'), '③ 要限制交付范围');
    assert.ok(!feedbackText({ errors: [] }), '没有错误时返回空串');
  } finally { r.done(); }
});

test('feedbackText 超量时截断并说明还有多少条', () => {
  const errors = Array.from({ length: 25 }, (_, i) => ({ kind: 'syntax', file: `f${i}.js`, message: 'boom' }));
  const txt = feedbackText({ errors }, { maxItems: 20 });
  assert.ok(txt.includes('另有 5 处未列出'));
  assert.ok(!txt.includes('f24.js'), '超出上限的不列');
});
