'use strict';
/**
 * test/artifact-bus.test.js —— 产物总线：解析与落盘
 *
 * 这些用例针对的是 **build 模式最关键的一次状态跃迁**：
 *   AI 的一段回复  →  磁盘上一个真实文件
 * 此后才有"能被编译"这回事。所以断言的落点全部是**磁盘事实**（fs.existsSync /
 * 读回内容比对），而不是"内存记录里有这么一条" ——
 * 后者曾经掩盖过真实 bug（内存有记录、盘上没有）。
 *
 * ★ 另外两条是这个文件里最值钱的断言：
 *   ① 认不出来的块必须进 `rejected`，**不许静默丢**（丢文件比报错危险）；
 *   ② 跨作者写同一路径时**先到者保留**且冲突被记下 —— 让后者覆盖会把冲突抹掉，
 *      集成席就再也看不到"哪儿断了"。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArtifacts, normalizeArtifactPath, normalizeContent, filesFromJson,
  ArtifactStore, contractModuleNames, defaultPathFor,
  ARTIFACT_TEMPLATE, FORBIDDEN_EXT,
} = require('../core/artifact-bus');

/** 每个用例一个独立工作区，避免互相踩（并保证 clean() 幂等可测） */
let _n = 0;
function tmpRoot(tag) {
  _n += 1;
  return path.join(os.tmpdir(), `dsh-art-test-${process.pid}-${_n}-${tag}`);
}
function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/* ══════════════════════════════════════════════════════════════════
   ① 五种标注写法都能认出来
   ══════════════════════════════════════════════════════════════════ */

test('写法① info 里的 path=（推荐写法）', () => {
  const r = parseArtifacts('说明\n\n```js path=src/util.js\nconst a = 1;\n```\n');
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].path, 'src/util.js');
  assert.strictEqual(r.files[0].how, 'info-string');
  assert.strictEqual(r.files[0].lang, 'js');
  assert.ok(r.files[0].content.includes('const a = 1;'));
});

test('写法② info 里直接跟路径（```js src/app.js）', () => {
  const r = parseArtifacts('```js src/app.js\nconsole.log(1);\n```\n');
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].path, 'src/app.js');
});

test('写法③ info 整段就是路径（```index.html）', () => {
  const r = parseArtifacts('```index.html\n<p>hi</p>\n```\n');
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].path, 'index.html');
});

test('写法④ 代码第一行是路径注释', () => {
  const r = parseArtifacts('```js\n// path: src/a.js\nconst a = 1;\n```\n');
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].path, 'src/a.js');
  assert.strictEqual(r.files[0].how, 'leading-comment');
});

test('写法⑤ 代码块前一行是 Markdown 标题形式的路径', () => {
  const r = parseArtifacts('## src/broken.js\n```js\nconst a = 1;\n```\n');
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].path, 'src/broken.js');
  assert.strictEqual(r.files[0].how, 'preceding-line');
});

test('写法⑤-a 前一行句尾带中文冒号（中文模型最常见的写法，曾整块丢失）', () => {
  const r = parseArtifacts('还有入口文件 `src/index.js`：\n```js\nlet a = 1;\n```\n');
  assert.strictEqual(r.files.length, 1, '带冒号的标题也要认出来');
  assert.strictEqual(r.files[0].path, 'src/index.js');
  assert.strictEqual(r.files[0].how, 'preceding-line');
});

test('写法⑤-b 前一行用 HTML 注释包裹（曾整块丢失）', () => {
  const r = parseArtifacts('<!-- path=src/api.js -->\n```js\nlet b = 2;\n```\n');
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].path, 'src/api.js');
  assert.strictEqual(r.files[0].how, 'preceding-line');
});

test('写法⑤-c 前一行是「文件：xxx.js」的键值形式', () => {
  const r = parseArtifacts('文件：src/db.js\n```js\nlet c = 3;\n```\n');
  assert.strictEqual(r.files[0].path, 'src/db.js');
});

test('★ 写法⑤-d 一行里出现两个路径 → 歧义不猜，返回 null（宁可丢，不可猜错）', () => {
  const r = parseArtifacts('先看 src/old.js 与 src/new.js 的区别：\n```js\nlet d = 4;\n```\n');
  assert.strictEqual(r.files.length, 0, '猜错会把内容写进别人的文件，宁可不认');
  assert.strictEqual(r.rejected.length, 1);
  assert.strictEqual(r.rejected[0].reason, 'no-path');
});

test('★ 写法⑤-e 句尾带句号的散文不当标题（那更可能是在叙述，不是在指名文件）', () => {
  const r = parseArtifacts('我已经把 src/a.js 改好了。\n```js\nlet e = 5;\n```\n');
  assert.strictEqual(r.files.length, 0, '句号结尾的行不作数——防止把下一块内容写到错的文件');
});

test('写法⑥ json 代码块里包一个 {files:[…]} 产物包', () => {
  const body = JSON.stringify({ files: [{ path: 'a/b.js', content: 'const x=1;\n' }, { path: 'c.json', content: '{}' }] });
  const r = parseArtifacts('```json\n' + body + '\n```\n');
  assert.strictEqual(r.files.length, 2);
  assert.deepStrictEqual(r.files.map((f) => f.path), ['a/b.js', 'c.json']);
  assert.strictEqual(r.stats.fromJsonBlock, 1);
});

test('写法⑥-变体 整段没有任何 fenced 块，就是裸 JSON', () => {
  const r = parseArtifacts(JSON.stringify({ path: 'x.js', content: 'let y = 2;\n' }));
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].path, 'x.js');
  assert.strictEqual(r.files[0].how, 'raw-json');
});

test('文件名字面的 {path, content}（用例名即契约）', () => {
  const r = parseArtifacts('```js path="src/quoted.js"\nconst q = 1;\n```\n');
  assert.strictEqual(r.files[0].path, 'src/quoted.js', '路径两边的引号要被剥掉');
});

/* ══════════════════════════════════════════════════════════════════
   ② 路径安全闸 —— 每一条都是"宁可拒绝，不能写错地方"
   ══════════════════════════════════════════════════════════════════ */

test('★ 绝对路径/盘符/UNC/家目录写法 一律拒绝', () => {
  const bad = [
    ['/etc/passwd', 'absolute'],
    ['C:\\Windows\\system32\\x.js', 'absolute-drive'],
    ['c:/x.js', 'absolute-drive'],
    ['\\\\server\\share\\x.js', 'unc'],
    ['//server/share/x.js', 'unc'],
    ['~/secret.js', 'home-shorthand'],
  ];
  for (const [p, reason] of bad) {
    const r = normalizeArtifactPath(p);
    assert.strictEqual(r.ok, false, `${p} 必须被拒绝`);
    assert.strictEqual(r.reason, reason, `${p} → ${reason}`);
  }
});

test('★ `..` 逐段判：真穿越拒绝，而 `a..b/c.js` 是合法文件名', () => {
  assert.strictEqual(normalizeArtifactPath('../../etc/x').ok, false);
  assert.strictEqual(normalizeArtifactPath('../../etc/x').reason, 'traversal');
  assert.strictEqual(normalizeArtifactPath('src/../x.js').reason, 'traversal');
  // 边界：文件名里含两个点不是穿越
  assert.strictEqual(normalizeArtifactPath('src/a..b/c.js').ok, true);
});

test('★ 可执行扩展名一律拒绝（产物随后会被真跑）', () => {
  for (const ext of FORBIDDEN_EXT) {
    const r = normalizeArtifactPath(`bin/payload${ext}`);
    assert.strictEqual(r.ok, false, `${ext} 必须被拒绝`);
    assert.strictEqual(r.reason, 'forbidden-ext');
  }
});

test('Windows 保留名与控制字符被拒', () => {
  assert.strictEqual(normalizeArtifactPath('CON.js').reason, 'reserved-name');
  assert.strictEqual(normalizeArtifactPath('src/aux.txt').reason, 'reserved-name');
  assert.strictEqual(normalizeArtifactPath('a\u0000b.js').reason, 'control-char');
  assert.strictEqual(normalizeArtifactPath('a\u001bb.js').reason, 'control-char');
});

test('尾随点被拒；尾随空格则 trim 掉（都不能静默落到意料之外的路径）', () => {
  // 末尾的点在 Windows 上会被文件系统静默剥掉 → 归一化结果与预期不符，必须拒
  assert.strictEqual(normalizeArtifactPath('src/a.js.').reason, 'trailing-dot-or-space');
  // 末尾空格：trim 之后正常通过。模型/人不会故意用空格当文件名，trim 才是对的行为
  const sp = normalizeArtifactPath('src/a.js ');
  assert.strictEqual(sp.ok, true);
  assert.strictEqual(sp.path, 'src/a.js');
});

test('反斜杠被归一成 /，且去掉 ./ 前缀与重复斜杠', () => {
  assert.strictEqual(normalizeArtifactPath('src\\a\\b.js').path, 'src/a/b.js');
  assert.strictEqual(normalizeArtifactPath('./src/a.js').path, 'src/a.js');
  assert.strictEqual(normalizeArtifactPath('src//a.js').path, 'src/a.js');
  assert.strictEqual(normalizeArtifactPath('src/a.js').nested, true);
  assert.strictEqual(normalizeArtifactPath('a.js').nested, false);
});

/* ══════════════════════════════════════════════════════════════════
   ③ 正文规范化
   ══════════════════════════════════════════════════════════════════ */

test('正文：CRLF 归一成 LF，末尾恰好一个换行', () => {
  assert.strictEqual(normalizeContent('a\r\nb\r\n'), 'a\nb\n');
  assert.strictEqual(normalizeContent('a\n\n\n'), 'a\n');
  assert.strictEqual(normalizeContent(''), '');
  assert.strictEqual(normalizeContent('\n\n'), '');
});

test('空内容 / 纯空白块 → rejected（不是"写了空文件"）', () => {
  const r = parseArtifacts('```js path=empty.js\n\n   \n```\n');
  assert.strictEqual(r.files.length, 0);
  assert.strictEqual(r.rejected.length, 1);
  assert.strictEqual(r.rejected[0].reason, 'empty-content');
  assert.strictEqual(r.rejected[0].snippet, 'empty.js', 'rejected 要带能定位的信息');
});

/* ══════════════════════════════════════════════════════════════════
   ④ ★ 宁可报"认不出"，不许静默丢
   ══════════════════════════════════════════════════════════════════ */

test('★ 认不出路径的代码块必须进 rejected，不能被悄悄忽略', () => {
  const r = parseArtifacts('这是解释\n\n```js\nconst a = 1;\n```\n');
  assert.strictEqual(r.files.length, 0);
  assert.strictEqual(r.rejected.length, 1);
  assert.strictEqual(r.rejected[0].reason, 'no-path');
  assert.ok(r.rejected[0].snippet.includes('const a = 1;'), '要能看出是哪一段被丢了');
});

test('★ 不安全路径的块进 rejected，其余照常产出（不做"全有或全无"）', () => {
  const src = [
    '```js path=src/good.js', 'const g = 1;', '```', '',
    '```js path=../../evil.js', 'const e = 1;', '```',
  ].join('\n');
  const r = parseArtifacts(src);
  assert.deepStrictEqual(r.files.map((f) => f.path), ['src/good.js']);
  assert.strictEqual(r.rejected.length, 1);
  assert.strictEqual(r.rejected[0].reason, 'traversal');
});

test('同一批里同路径重复 → 只留一份，后者取代前者并标记（可审计）', () => {
  const src = [
    '```js path=a.js', 'const v = 1;', '```', '',
    '```js path=a.js', 'const v = 2;', '```',
  ].join('\n');
  const r = parseArtifacts(src);
  assert.strictEqual(r.files.length, 1, '同一路径只产出一条');
  assert.ok(r.files[0].content.includes('const v = 2;'),
    '★ 后者必须取代前者 —— 只给旧记录打标记却不换数组元素，会留下"标着被取代却仍是产出结果"的自相矛盾');
  assert.strictEqual(r.files[0].superseded, true, '取代这件事要留在记录上供审计');
});

test('超大代码块被拒（防一整份 minified 依赖撑爆内存）', () => {
  const big = 'x'.repeat(600 * 1024);
  const r = parseArtifacts('```js path=big.js\n' + big + '\n```\n');
  assert.strictEqual(r.files.length, 0);
  assert.strictEqual(r.rejected[0].reason, 'block-too-large');
});

/* ══════════════════════════════════════════════════════════════════
   ⑤ 契约兜底路径 —— ★ 只在能唯一确定时才给
   ══════════════════════════════════════════════════════════════════ */

test('defaultPath 兜底：模型忘标路径时用契约里分给它的模块', () => {
  const r = parseArtifacts('```js\nconst a = 1;\n```\n', { defaultPath: 'src/util.js' });
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].path, 'src/util.js');
  assert.strictEqual(r.files[0].how, 'contract-default');
});

test('★ 契约里此人名下有多个模块时**不给兜底**（猜错就覆盖别人的文件）', () => {
  const contract = {
    modules: [
      { owner: 'a', module: 'src/one.js' },
      { owner: 'a', module: 'src/two.js' },
    ],
  };
  assert.strictEqual(defaultPathFor(contract, 'a'), null);
});

test('契约兜底：多个模块里若有一个像入口（index.js）则用它', () => {
  const contract = {
    modules: [
      { owner: 'a', module: 'src/index.js' },
      { owner: 'a', module: 'src/helper.js' },
    ],
  };
  assert.strictEqual(defaultPathFor(contract, 'a'), 'src/index.js');
});

test('契约兜底：单一模块时优先保留契约原样的路径形态（src/a.js 而非 a.js）', () => {
  const contract = { modules: [{ owner: 'a', module: 'src/a.js' }] };
  assert.strictEqual(defaultPathFor(contract, 'a'), 'src/a.js');
  assert.strictEqual(defaultPathFor(contract, 'b'), null, '不是我的模块不给兜底');
});

test('contractModuleNames 同时收原样与 basename 两种形态（产物可能多带一层目录）', () => {
  const contract = { modules: [{ owner: 'a', module: 'src/util.js' }] };
  const names = contractModuleNames(contract, 'a');
  assert.ok(names.has('src/util.js'));
  assert.ok(names.has('util.js'));
  assert.strictEqual(contractModuleNames(contract, 'b').size, 0);
});

/* ══════════════════════════════════════════════════════════════════
   ⑥ ArtifactStore：真落盘
   ══════════════════════════════════════════════════════════════════ */

test('★ root 必须显式传 —— 不允许"默认写到项目目录"', () => {
  assert.throws(() => new ArtifactStore({}), /root 必须显式传入/);
  assert.throws(() => new ArtifactStore(), /root 必须显式传入/);
});

test('真落盘：文件在磁盘上存在、内容一致、sha256 可核', () => {
  const root = tmpRoot('write');
  const store = new ArtifactStore({ root });
  store.clean();
  try {
    const r = store.materialize('a', [
      { path: 'src/util.js', content: 'const a = 1;\n' },
      { path: 'index.html', content: '<p>hi</p>\n' },
    ]);
    assert.deepStrictEqual(r.written.map((w) => w.path), ['src/util.js', 'index.html']);
    assert.strictEqual(r.conflicts.length, 0);

    const abs = path.join(root, 'src', 'util.js');
    assert.ok(fs.existsSync(abs), '★ 磁盘上必须真的有这个文件');
    assert.strictEqual(fs.readFileSync(abs, 'utf8'), 'const a = 1;\n');
    assert.strictEqual(store.read('src/util.js'), 'const a = 1;\n');
  } finally { cleanup(root); }
});

test('walk() 从磁盘读事实（而不是读内存记录）', () => {
  const root = tmpRoot('walk');
  const store = new ArtifactStore({ root });
  store.clean();
  try {
    store.materialize('a', [{ path: 'x/y/z.js', content: 'const z = 1;\n' }]);
    // 手工丢一个"外人"文件进去 —— walk 必须看得见它（内存记录里没有）
    fs.writeFileSync(path.join(root, 'stray.txt'), 'stray', 'utf8');
    const files = store.walk();
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes('x/y/z.js'));
    assert.ok(paths.includes('stray.txt'), '★ walk 反映磁盘事实，不是内存账本');
  } finally { cleanup(root); }
});

test('★ 路径越界在 resolve 之后仍被拦（纵深防御第二道闸）', () => {
  const root = tmpRoot('escape');
  const store = new ArtifactStore({ root });
  try {
    assert.throws(() => store.absPath('../outside.js'), /越界/);
    assert.throws(() => store.absPath('../../etc/passwd'), /越界/);
  } finally { cleanup(root); }
});

test('★ 跨作者写同一路径：先到者保留，冲突被记下（不许后者静默覆盖）', () => {
  const root = tmpRoot('conflict');
  const store = new ArtifactStore({ root });
  store.clean();
  try {
    store.materialize('a', [{ path: 'src/util.js', content: '来自 A\n' }]);
    const r2 = store.materialize('b', [{ path: 'src/util.js', content: '来自 B\n' }]);

    assert.strictEqual(r2.written.length, 0, '冲突文件不写盘');
    assert.strictEqual(r2.conflicts.length, 1);
    assert.strictEqual(r2.conflicts[0].path, 'src/util.js');
    assert.strictEqual(r2.conflicts[0].kept, 'a');
    assert.strictEqual(r2.conflicts[0].rejected, 'b');
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'util.js'), 'utf8'), '来自 A\n',
      '★ 先到者必须保留 —— 否则"哪儿断了"的证据就被抹掉了');
  } finally { cleanup(root); }
});

test('同一作者重写同一路径：force=true 才覆盖（修复回路的正当用法）', () => {
  const root = tmpRoot('force');
  const store = new ArtifactStore({ root });
  store.clean();
  try {
    store.materialize('a', [{ path: 'src/util.js', content: 'v1\n' }]);
    store.materialize('a', [{ path: 'src/util.js', content: 'v2\n' }]);  // 同作者 → 允许更新
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'util.js'), 'utf8'), 'v2\n');
  } finally { cleanup(root); }
});

test('写了契约里不属于自己的模块 → 记进 outOfContract（能落盘，但要被看见）', () => {
  const root = tmpRoot('contract');
  const store = new ArtifactStore({ root });
  store.clean();
  try {
    const contract = { modules: [{ owner: 'a', module: 'src/mine.js' }] };
    const r = store.materialize('a', [
      { path: 'src/mine.js', content: 'ok\n' },
      { path: 'src/others.js', content: '越界\n' },
    ], { contract });
    assert.strictEqual(r.written.length, 2, '越界不是致命错，仍要落盘');
    assert.strictEqual(r.outOfContract.length, 1);
    assert.strictEqual(r.outOfContract[0].path, 'src/others.js');
  } finally { cleanup(root); }
});

test('契约用 basename 也能匹配上（契约写 util.js，产物写 src/util.js 不算越界）', () => {
  const root = tmpRoot('contract-base');
  const store = new ArtifactStore({ root });
  store.clean();
  try {
    const contract = { modules: [{ owner: 'a', module: 'util.js' }] };
    const r = store.materialize('a', [{ path: 'src/util.js', content: 'ok\n' }], { contract });
    assert.strictEqual(r.outOfContract.length, 0);
  } finally { cleanup(root); }
});

test('单文件与总量上限生效（skip 而不是炸掉）', () => {
  const root = tmpRoot('limits');
  const store = new ArtifactStore({ root, maxFileBytes: 20, maxTotalBytes: 50 });
  store.clean();
  try {
    const r = store.materialize('a', [
      { path: 'big.js', content: 'x'.repeat(100) },
      { path: 'ok.js', content: 'const a = 1;\n' },
    ]);
    assert.deepStrictEqual(r.written.map((w) => w.path), ['ok.js']);
    assert.strictEqual(r.skipped[0].reason, 'file-too-large');
    assert.ok(!fs.existsSync(path.join(root, 'big.js')), '超限文件不应留下');
  } finally { cleanup(root); }
});

test('clean() 幂等：连清两次都不炸，且真的清空', () => {
  const root = tmpRoot('clean');
  const store = new ArtifactStore({ root });
  try {
    store.materialize('a', [{ path: 'a.js', content: 'const a = 1;\n' }]);
    store.clean();
    assert.strictEqual(store.walk().length, 0);
    assert.strictEqual(store.totalBytes(), 0);
    store.clean();
    assert.strictEqual(store.walk().length, 0);
  } finally { cleanup(root); }
});

test('落盘清单带 ownerId / sha256（集成与审计都要按作者归因）', () => {
  const root = tmpRoot('meta');
  const store = new ArtifactStore({ root });
  store.clean();
  try {
    const r = store.materialize('agentX', [{ path: 'a.js', content: 'const a = 1;\n' }]);
    assert.strictEqual(r.written[0].ownerId, 'agentX');
    assert.match(r.written[0].sha256, /^[0-9a-f]{64}$/);
  } finally { cleanup(root); }
});

/* ══════════════════════════════════════════════════════════════════
   ⑦ prompt 模板与 JSON 解析器
   ══════════════════════════════════════════════════════════════════ */

test('★ 给模型的格式约定必须包含三条硬要求（路径相对 / 只写自己的 / 完整文件）', () => {
  assert.ok(ARTIFACT_TEMPLATE.includes('path='), '要教 path= 写法');
  assert.ok(ARTIFACT_TEMPLATE.includes('相对路径'));
  assert.ok(ARTIFACT_TEMPLATE.includes('只写契约里分给你的模块'), '★ 越界是本层要防的主要事故');
  assert.ok(ARTIFACT_TEMPLATE.includes('完整文件'));
});

test('filesFromJson：数组 / {files} / 单个 {path,content} 三种都认', () => {
  assert.strictEqual(filesFromJson('[{"path":"a.js","content":"1"}]').length, 1);
  assert.strictEqual(filesFromJson('{"files":[{"path":"a.js","content":"1"}]}').length, 1);
  assert.strictEqual(filesFromJson('{"path":"a.js","content":"1"}').length, 1);
  assert.strictEqual(filesFromJson('{"nope":1}'), null);
  assert.strictEqual(filesFromJson('这不是 JSON'), null);
  assert.strictEqual(filesFromJson(''), null);
});
