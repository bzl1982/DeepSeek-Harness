'use strict';
/**
 * test/build-loop.test.js —— build 流水线：契约解析 / 收集落盘 / 出证
 *
 * 三组断言各自对应一个"错了会很贵"的地方：
 *   ① 契约解析：owner 认不出来时**必须丢弃并记账** —— 一个错的归属比没有归属更糟，
 *      它会放行越界写入（AI 写的文件覆盖别人的文件）。
 *   ② 收集落盘：跨作者冲突要被记下，而不是被后者覆盖。
 *   ③ 出证文本：critiquesFrom 必须**逐字稳定** —— 它同时是收敛判据的输入，
 *      字形漂移会让"已修好"被判成"又出现新批评"，收敛永不发生（判据静默失效）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CONTRACT_TEMPLATE, parseContractModules, contractFor, artifactPromptFor,
  collectStageArtifacts, verifyWorkspace, buildReportText, critiquesFrom,
  readPackageJson, failureKey,
} = require('../core/build-loop');

let _n = 0;
const tmpRoot = (tag) => path.join(os.tmpdir(), `dsh-bl-test-${process.pid}-${_n++}-${tag}`);
const cleanup = (root) => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* ignore */ } };

const PEOPLE = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];

/* ══════════════════════════════════════════════════════════════════
   ① 契约：文本 → 结构
   ══════════════════════════════════════════════════════════════════ */

test('解析 markdown 表格形式的模块表', () => {
  const text = [
    '## 模块划分',
    '',
    '| 模块路径 | 负责人 | 对外签名 |',
    '|---|---|---|',
    '| src/util.js | p4 | add(a, b): number |',
    '| src/app.js | p1 | main(): void |',
  ].join('\n');
  const r = parseContractModules(text, { participants: PEOPLE });
  assert.strictEqual(r.modules.length, 2);
  assert.deepStrictEqual(r.modules.map((m) => [m.module, m.owner]), [
    ['src/util.js', 'p4'], ['src/app.js', 'p1'],
  ]);
  assert.strictEqual(r.modules[0].signature, 'add(a, b): number');
  assert.strictEqual(r.modules[0].how, 'table');
  assert.strictEqual(r.rejected.length, 0, '分隔行 |---|---| 不该产出垃圾条目');
});

test('表格里有前导序号列也能认出来', () => {
  const text = '| 1 | src/a.js | p3 | f() |\n| 2 | src/b.js | p5 | g() |';
  const r = parseContractModules(text, { participants: PEOPLE });
  assert.deepStrictEqual(r.modules.map((m) => [m.module, m.owner]), [
    ['src/a.js', 'p3'], ['src/b.js', 'p5'],
  ]);
});

test('解析列表形式的模块表（多种分隔符）', () => {
  const text = [
    '- src/util.js — p4 — add(a,b)',
    '* src/app.js : p1 : main()',
    '- src/db.js，p6，query()',
  ].join('\n');
  const r = parseContractModules(text, { participants: PEOPLE });
  assert.deepStrictEqual(r.modules.map((m) => m.owner), ['p4', 'p1', 'p6']);
});

test('列表形式里「负责人：p4」写在同段也能认', () => {
  const r = parseContractModules('- src/util.js 负责人：p4', { participants: PEOPLE });
  assert.strictEqual(r.modules.length, 1);
  assert.strictEqual(r.modules[0].owner, 'p4');
});

test('解析行内注明形式', () => {
  const r = parseContractModules('`src/util.js`（负责人：p4）提供加法', { participants: PEOPLE });
  assert.strictEqual(r.modules.length, 1);
  assert.strictEqual(r.modules[0].module, 'src/util.js');
  assert.strictEqual(r.modules[0].owner, 'p4');
});

test('★ 负责人不在参会名单里 → 丢弃并记账（一个错的归属比没有归属更糟）', () => {
  const text = [
    '| src/a.js | 架构师 | f() |',
    '| src/b.js | Agent-1 | g() |',
    '| src/c.js | p4 | h() |',
  ].join('\n');
  const r = parseContractModules(text, { participants: PEOPLE });
  assert.deepStrictEqual(r.modules.map((m) => m.module), ['src/c.js'], '只有真参会者那行才算数');
  assert.strictEqual(r.rejected.length, 2);
  assert.ok(r.rejected.every((x) => x.reason === 'unknown-owner'));
  assert.deepStrictEqual(r.rejected.map((x) => x.owner), ['架构师', 'Agent-1']);
});

test('★ 只写角色名、完全不写路径的内容不会产出模块（避免把散文当契约）', () => {
  const r = parseContractModules(
    '架构师负责整体设计。执行者负责实现。我们约定用 CommonJS。',
    { participants: PEOPLE },
  );
  assert.strictEqual(r.modules.length, 0);
});

test('路径归一：反斜杠转 /，剥掉 ./ 前缀与包裹符号', () => {
  const r = parseContractModules('| `src\\a.js` | p4 | f() |\n| ./src/b.js | p1 | g() |', { participants: PEOPLE });
  assert.deepStrictEqual(r.modules.map((m) => m.module), ['src/a.js', 'src/b.js']);
});

test('同一模块重复出现只留一条（去重）', () => {
  const text = '| src/a.js | p4 | f() |\n| src/a.js | p4 | f() |';
  const r = parseContractModules(text, { participants: PEOPLE });
  assert.strictEqual(r.modules.length, 1);
});

test('contractFor：解析不出模块表也要保留契约正文', () => {
  const c = contractFor('这是没有任何表格的契约正文。', { participants: PEOPLE });
  assert.strictEqual(c.text, '这是没有任何表格的契约正文。');
  assert.deepStrictEqual(c.modules, []);
});

test('contractFor：正常解析出 modules', () => {
  const c = contractFor('| src/a.js | p4 | f() |', { participants: PEOPLE });
  assert.strictEqual(c.modules.length, 1);
  assert.strictEqual(c.text, '| src/a.js | p4 | f() |');
});

test('★ 合同模板必须教"负责人写 id 而不是角色名"（否则归属校验整个失效）', () => {
  assert.ok(CONTRACT_TEMPLATE.includes('参会者的 id'));
  assert.ok(CONTRACT_TEMPLATE.includes('不要写角色名'));
  assert.ok(CONTRACT_TEMPLATE.includes('不能重名'));
});

/* ══════════════════════════════════════════════════════════════════
   ② artifactPromptFor：把归属在提问时就钉死
   ══════════════════════════════════════════════════════════════════ */

test('★ artifactPromptFor：明确告诉这个人该交哪个文件', () => {
  const contract = { modules: [{ owner: 'p4', module: 'src/util.js', signature: 'add(a,b)' }] };
  const t = artifactPromptFor(contract, 'p4');
  assert.ok(t.includes('src/util.js'), '要点名文件');
  assert.ok(t.includes('add(a,b)'), '要带签名');
  assert.ok(t.includes('只交这些文件'), '要说清边界');
  assert.ok(t.includes('path='), '要带上格式约定');
});

test('artifactPromptFor：不是他的模块就不列出来', () => {
  const contract = { modules: [{ owner: 'p1', module: 'src/app.js' }] };
  const t = artifactPromptFor(contract, 'p4');
  assert.ok(!t.includes('src/app.js'), '别人的文件不该出现在他的交付说明里');
  assert.ok(t.includes('没有明确你的模块归属'), '没归属要诚实说明，让他自己标 path=');
});

/* ══════════════════════════════════════════════════════════════════
   ③ 收集落盘
   ══════════════════════════════════════════════════════════════════ */

function mkStore(tag) {
  const root = tmpRoot(tag);
  const store = new (require('../core/artifact-bus').ArtifactStore)({ root });
  store.clean();
  return { store, root };
}

test('收集多人产物：全部落盘，按作者归因', () => {
  const { store, root } = mkStore('collect');
  try {
    const stageResult = {
      name: '分头实现',
      results: [
        { providerId: 'p1', ok: true, text: '```js path=src/app.js\nconst u = require("./util");\nmodule.exports = u;\n```' },
        { providerId: 'p2', ok: true, text: '```js path=src/util.js\nmodule.exports = { add: 1 };\n```' },
      ],
    };
    const out = collectStageArtifacts(stageResult, { store });
    assert.strictEqual(out.written, 2);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.byOwner.p1.paths, ['src/app.js']);
    assert.deepStrictEqual(out.byOwner.p2.paths, ['src/util.js']);
    assert.ok(fs.existsSync(path.join(root, 'src', 'app.js')), '磁盘上要真的有');
  } finally { cleanup(root); }
});

test('阶段失败的人被标记，不产生文件', () => {
  const { store, root } = mkStore('failed');
  try {
    const out = collectStageArtifacts({
      name: '分头实现',
      results: [
        { providerId: 'p1', ok: false, text: '', state: 'TIMEOUT' },
        { providerId: 'p2', ok: true, text: '```js path=a.js\nmodule.exports = 1;\n```' },
      ],
    }, { store });
    assert.strictEqual(out.byOwner.p1.ok, false);
    assert.strictEqual(out.byOwner.p1.reason, 'stage-failed');
    assert.strictEqual(out.byOwner.p2.files, 1);
  } finally { cleanup(root); }
});

test('★ 成功但没解析出文件 → 明确记为 no-artifact-parsed（不假装成功）', () => {
  const { store, root } = mkStore('noart');
  try {
    const out = collectStageArtifacts({
      name: '分头实现',
      results: [{ providerId: 'p1', ok: true, text: '我觉得这个模块应该这样设计……（只有散文，没有代码块）' }],
    }, { store });
    assert.strictEqual(out.written, 0);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.byOwner.p1.reason, 'no-artifact-parsed');
  } finally { cleanup(root); }
});

test('★ 跨作者写同一路径 → 冲突被记下且先到者保留', () => {
  const { store, root } = mkStore('conflict');
  try {
    const out = collectStageArtifacts({
      name: '分头实现',
      results: [
        { providerId: 'p1', ok: true, text: '```js path=src/shared.js\nmodule.exports = "from p1";\n```' },
        { providerId: 'p2', ok: true, text: '```js path=src/shared.js\nmodule.exports = "from p2";\n```' },
      ],
    }, { store, round: 1 });
    assert.strictEqual(out.conflicts.length, 1);
    assert.strictEqual(out.conflicts[0].kept, 'p1');
    assert.strictEqual(out.conflicts[0].rejected, 'p2');
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'shared.js'), 'utf8'), 'module.exports = "from p1";\n');
  } finally { cleanup(root); }
});

test('修复回路（round>1）允许同一作者覆盖自己的文件', () => {
  const { store, root } = mkStore('round2');
  try {
    collectStageArtifacts({
      name: '分头实现',
      results: [{ providerId: 'p1', ok: true, text: '```js path=a.js\nmodule.exports = "v1";\n```' }],
    }, { store, round: 1 });
    collectStageArtifacts({
      name: '修复',
      results: [{ providerId: 'p1', ok: true, text: '```js path=a.js\nmodule.exports = "v2";\n```' }],
    }, { store, round: 2 });
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'module.exports = "v2";\n');
  } finally { cleanup(root); }
});

test('契约兜底：模型忘标 path 时用契约里分给它的模块', () => {
  const { store, root } = mkStore('default');
  try {
    const contract = { modules: [{ owner: 'p4', module: 'src/util.js' }] };
    const out = collectStageArtifacts({
      name: '分头实现',
      results: [{ providerId: 'p4', ok: true, text: '```js\nmodule.exports = { add: 1 };\n```' }],
    }, { store, contract });
    assert.deepStrictEqual(out.byOwner.p4.paths, ['src/util.js']);
  } finally { cleanup(root); }
});

test('写了不属于自己的模块 → 记进 outOfContract，但仍落盘', () => {
  const { store, root } = mkStore('ooc');
  try {
    const contract = { modules: [{ owner: 'p1', module: 'src/mine.js' }] };
    const out = collectStageArtifacts({
      name: '分头实现',
      results: [{ providerId: 'p1', ok: true, text: '```js path=src/others.js\nmodule.exports = 1;\n```' }],
    }, { store, contract });
    assert.strictEqual(out.outOfContract.length, 1);
    assert.strictEqual(out.outOfContract[0].path, 'src/others.js');
  } finally { cleanup(root); }
});

test('解析被拒的块会计入 rejected（不静默丢）', () => {
  const { store, root } = mkStore('rej');
  try {
    const out = collectStageArtifacts({
      name: '分头实现',
      results: [{
        providerId: 'p1', ok: true,
        text: '```js path=../evil.js\nmodule.exports = 1;\n```\n```js path=ok.js\nmodule.exports = 2;\n```',
      }],
    }, { store });
    assert.strictEqual(out.written, 1);
    assert.ok(out.rejected.some((r) => r.reason === 'traversal'), '越界路径要在 rejected 里露面');
  } finally { cleanup(root); }
});

/* ══════════════════════════════════════════════════════════════════
   ④ verifyWorkspace：真验证
   ══════════════════════════════════════════════════════════════════ */

test('★ verifyWorkspace 基于磁盘事实：落盘后编译抓错，修好后通过', async () => {
  const { store, root } = mkStore('verify');
  try {
    // 第一轮：语法错
    collectStageArtifacts({
      name: '分头实现',
      results: [{ providerId: 'p1', ok: true, text: '```js path=a.js\nfunction oops( {\n  return 1;\n}\n```' }],
    }, { store, round: 1 });
    const v1 = await verifyWorkspace({ store, level: 'static' });
    assert.strictEqual(v1.verdict.buildPass, false, '坏代码必须判未通过');
    assert.strictEqual(v1.verdict.errors.length, 1);

    // 第二轮：修好了
    collectStageArtifacts({
      name: '修复',
      results: [{ providerId: 'p1', ok: true, text: '```js path=a.js\nfunction ok() {\n  return 1;\n}\nmodule.exports = ok;\n```' }],
    }, { store, round: 2 });
    const v2 = await verifyWorkspace({ store, level: 'static' });
    assert.strictEqual(v2.verdict.buildPass, true, '修好后必须判通过');
  } finally { cleanup(root); }
});

test('空工作区 → buildPass 是 null（不撒谎）', async () => {
  const { store, root } = mkStore('empty');
  try {
    const v = await verifyWorkspace({ store, level: 'static' });
    assert.strictEqual(v.verdict.buildPass, null);
  } finally { cleanup(root); }
});

test('readPackageJson 读得到 / 读不到都给安全结果', () => {
  const { store, root } = mkStore('pkg');
  try {
    assert.strictEqual(readPackageJson(store), null, '没有就是 null');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x","type":"commonjs"}', 'utf8');
    assert.strictEqual(readPackageJson(store).name, 'x');
    fs.writeFileSync(path.join(root, 'package.json'), '{坏 JSON', 'utf8');
    assert.strictEqual(readPackageJson(store), null, '坏 JSON 不该抛，返回 null 让上层走"没有构建脚本"分支');
  } finally { cleanup(root); }
});

/* ══════════════════════════════════════════════════════════════════
   ⑤ 出证
   ══════════════════════════════════════════════════════════════════ */

const V_BAD = {
  buildPass: false,
  reason: '2 处真实错误（本机执行结果，非模型自述）',
  errors: [
    { kind: 'syntax', file: 'a.js', line: 2, code: 'syntax-error', message: 'Unexpected number', hint: '按行列号修' },
    { kind: 'refs', file: 'b.js', ref: './gone', code: 'missing-ref', message: '引用了 ./gone，但产物里没有 b/gone', hint: '补上或改引用' },
  ],
};

test('★ buildReportText 不给集成席"判定权"，只给"定位与指派"', () => {
  const txt = buildReportText({
    verdict: V_BAD,
    res: { ran: 3, failures: V_BAD.errors, skipped: [] },
    files: [{ path: 'a.js', bytes: 20 }, { path: 'b.js', bytes: 30 }],
    root: 'D:\\tmp\\build-x',
    level: 'static',
  });
  assert.ok(txt.includes('本机真实执行结果'), '要声明可信度来源');
  assert.ok(txt.includes('a.js'));
  assert.ok(txt.includes('第 2 行'));
  assert.ok(txt.includes('disk') || txt.includes('磁盘文件'), '要让集成席看到工作区实际内容');
  assert.ok(txt.includes('指派到**具体的人**'), '★ 它的职责是定位+指派，不是判定');
  assert.ok(txt.includes('不要声称'), '★ 明确禁止它自称"已通过"（否则 judgeBuildPass 的坚持就白费了）');
  assert.ok(!/请你判断是否通过/.test(txt), '★ 不许把判定权交给它');
});

test('buildReportText 在"未经验证"时要显式说出来', () => {
  const txt = buildReportText({
    verdict: V_BAD,
    res: { ran: 1, failures: [], skipped: [{ kind: 'syntax', file: 'x.ts', reason: 'no-ts-compiler' }] },
    files: [{ path: 'x.ts' }],
    root: '/t', level: 'static',
  });
  assert.ok(txt.includes('未经验证'), 'TS 没验证过就必须讲明白，不能让它读成"全部检查过"');
  assert.ok(txt.includes('x.ts'));
});

test('critiquesFrom：无错误时返回空数组（不许塞空字符串，那会污染收敛判据）', () => {
  assert.deepStrictEqual(critiquesFrom({ errors: [] }), []);
  assert.deepStrictEqual(critiquesFrom(null), []);
});

test('★ critiquesFrom 逐字稳定 —— 否则"已修好"会被判成"又出现新批评"，收敛永不发生', () => {
  const a = critiquesFrom(V_BAD);
  const b = critiquesFrom(V_BAD);
  assert.deepStrictEqual(a, b, '同一份失败必须产生完全相同的文本');
  // 且不含任何会漂移的东西
  assert.ok(!/\d{4}-\d{2}-\d{2}|\d+ms|durationMs/.test(a[0]), '不许含时间戳/耗时');
});

test('failureKey 稳定可比较（同一次失败 → 同一个 key）', () => {
  assert.strictEqual(failureKey(V_BAD.errors[0]), failureKey({ ...V_BAD.errors[0] }));
  assert.notStrictEqual(failureKey(V_BAD.errors[0]), failureKey(V_BAD.errors[1]));
});
