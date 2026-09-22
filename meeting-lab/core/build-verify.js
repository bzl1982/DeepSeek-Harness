'use strict';
/**
 * core/build-verify.js —— 真编译验证：让 buildPass 变成**可信**的值。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须有这一层（它接的是 judgeBuildPass 留下的空缺）
 *
 *   modes.js 的 judgeBuildPass() 设计得很对：模型自述"已经通过、可以交付"
 *   **不可采信** —— 它没编译过，那句话是"生成"的，不是"验证"的。
 *   所以那个函数在文本说"通过"时刻意返回 pass=null，注释写着：
 *
 *       "真正可信的 build-pass 只能来自真实执行结果（编译退出码 / 测试报告）"
 *
 *   问题是：**那条路一直没被建出来**。于是 shell 里
 *       buildPass = judgeBuildPass(text).pass   →  恒为 null
 *       shouldStop('build', { buildPass: null }) →  恒返回 degraded + missingInput
 *   结果：判据静默失效，会议只能跑满 maxIterations(4)。不报错、不崩溃，只是白烧钱。
 *   ——与上一轮 winnerId 缺参是**同一族的故障**。
 *
 *   本文件就是那句注释所指的"真实执行结果"。
 * ─────────────────────────────────────────────────────────────────────
 *
 * ★★ 三档强度（默认选最安全的那档，且**升级必须显式**）
 *
 *   ① syntax（零执行）
 *      `node --check <file>` —— 这是**真解析**：Node 自己按语法读一遍文件，
 *      报出准确的行列号。它**不执行任何代码**，所以对 AI 产出的代码是安全的。
 *   ② static（零执行，默认档 = syntax + 本档）
 *      引用完整性：把 `require('./x')` / `import … from './x'` / HTML 的
 *      `<script src>` 解析成相对路径，检查目标是否真在产物里。
 *      ★ 这条价值极高且**极便宜**：集成失败最常见的形态就是"模块名写错/文件没交"，
 *        而 `node --check` **抓不到**（语法完全正确）。零执行、零风险、零误报。
 *   ③ build（★ 会执行任意代码，必须显式开启）
 *      工作区有 `package.json` 且带 `scripts.build` 时跑 `npm run build`。
 *      **默认关闭**：这一步等于把 AI 写的代码在本机跑起来，风险性质与 ①② 完全不同。
 *      要开必须显式传 level:'build'，且调用方（UI）应为此给用户一个明确开关。
 *
 * ★ 诚实原则（比"看起来全能"重要）
 *   - 验证不了的东西**要报"未验证"，不报"通过"**：`.ts/.jsx` 没有 tsc 就用不了
 *     node --check，那就记 skipped 并写进 summary，而不是当成 OK。
 *   - 工作区空 / 一个命令都没跑 → `buildPass = null`（不撒谎），
 *     绝不能因为"没发现错误"就返回 true —— 那正好是 judgeBuildPass 拒绝犯的错。
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 用不了 node --check 的扩展名（JSX/TS 语法 Node 不认，需要专门的编译器） */
const TS_LIKE = Object.freeze(['.ts', '.tsx', '.jsx']);
/** Node 能真解析的扩展名 */
const CHECKABLE = Object.freeze(['.js', '.mjs', '.cjs']);
/** 只做 JSON.parse 校验 */
const JSON_LIKE = Object.freeze(['.json']);
/** 检查本地资源引用是否存在 */
const HTML_LIKE = Object.freeze(['.html', '.htm']);

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CONCURRENCY = 4;
const MAX_BUFFER = 1024 * 1024;

/* ══════════════════════════════════════════════════════════════════
   执行原语
   ══════════════════════════════════════════════════════════════════ */

/**
 * 跑一个子进程并**永不 reject**（异常收敛成 { code, error }）。
 * ★ 用 process.execPath 而不是裸 `node`：本机 PATH 里没有 node，
 *   而 process.execPath 就是"正在跑这段代码的那个 node"，一定可用。
 */
function run(cmd, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = null } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (out) => { if (!done) { done = true; resolve({ ...out, ms: Date.now() - started }); } };

    let child;
    try {
      child = execFile(cmd, args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: env || process.env,
      }, (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          if (typeof err.code === 'number') code = err.code;
          else if (err.killed) code = 124;          // 超时（约定 124，与 GNU timeout 一致）
          else code = 1;
        }
        finish({
          code,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut: !!(err && err.killed),
          spawnError: err && !err.code && !err.killed ? String(err.message) : null,
        });
      });
      if (child && typeof child.on === 'function') {
        child.on('error', (e) => finish({ code: 1, stdout: '', stderr: '', spawnError: String(e.message) }));
      }
    } catch (e) {
      finish({ code: 1, stdout: '', stderr: '', spawnError: String(e.message) });
    }
  });
}

/** 简单并发池（保序返回） */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit || 1, items.length || 1));
  await Promise.all(Array.from({ length: n }, async () => {
    /* eslint-disable no-constant-condition */
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      /* eslint-disable-next-line no-await-in-loop */
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   静态引用检查（零执行 —— 本层性价比最高的一项）
   ══════════════════════════════════════════════════════════════════ */

/**
 * 从 JS 源码里抽出**真实的**相对路径引用。
 *
 * ★ 为什么不能用"正则一把梭"
 *   注释和字符串里的 `require('./x')` 会被一起扫出来。而这样的行非常常见：
 *       // 注意：不要写成 require('./old')   ← 讲"别这么写"的注释
 *       const demo = "import x from './gone'"
 *   误报的代价很实在：集成判定把"没问题"判成失败 → 会议白跑一轮修复回路。
 *   所以这里用一个轻量状态机 —— **只在代码态读取字符串**，注释整段跳过。
 *
 * 已知边界（有意不做，且注释说明）：
 *   · 正则字面量里的 `//`（如 /a\/\//）会被当成注释起点 → 后果是**漏报**（少查一条），
 *     不是误报（不会白跑一轮）。两害相权取其轻。
 *   · 模板串里嵌套的 `${…}` 不展开 → 同属漏报。
 */
function extractRelativeRefs(source) {
  const s = String(source == null ? '' : source);
  const n = s.length;
  const found = [];
  let i = 0;
  /* 代码态最近一段字符 —— 用来判断"这个字符串是不是某个 require/import 的参数"。
   * 注释/字符串之后会断开（避免把上一个语句的上下文错误地接到下一处）。 */
  let buf = '';
  const keep = (ch) => { buf = (buf + ch).slice(-120); };

  const readString = (q) => {
    let j = i + 1;
    let val = '';
    while (j < n) {
      const c = s[j];
      if (c === '\\') { val += s[j + 1] || ''; j += 2; continue; }
      if (c === q) return { val, end: j + 1 };
      if (q !== '`' && c === '\n') return { val, end: j };   // 未闭合（容错，别吞掉整个文件）
      val += c;
      j += 1;
    }
    return { val, end: n };
  };

  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];

    if (c === '/' && c2 === '/') {                 // 行注释
      const e = s.indexOf('\n', i);
      if (e < 0) break;
      i = e;
      buf = '';
      continue;
    }
    if (c === '/' && c2 === '*') {                 // 块注释
      const e = s.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      buf = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const { val, end } = readString(c);
      const before = buf;
      if (/(?:require\s*\(\s*|\bfrom\s*)$/.test(before)) {
        found.push({ spec: val, kind: /require\s*\(\s*$/.test(before) ? 'require' : 'import' });
      } else if (/\bimport\s*\(\s*$/.test(before)) {
        found.push({ spec: val, kind: 'dynamic-import' });
      } else if (/(?:^|\n)[ \t]*import[ \t]*$/.test(before)) {
        found.push({ spec: val, kind: 'import-side-effect' });   // import './polyfill'
      }
      buf = '';
      i = end;
      continue;
    }
    keep(c);
    i += 1;
  }

  // 只留相对路径 + 去重（同一条引用写两次只报一次）
  const seen = new Set();
  const out = [];
  for (const r of found) {
    if (!(r.spec.startsWith('./') || r.spec.startsWith('../'))) continue;
    const k = `${r.kind}|${r.spec}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** 从 HTML 里抽出本地资源引用（先剥掉 HTML 注释 —— 注释里的示例标签不该算引用） */
function extractHtmlRefs(source) {
  const s = String(source == null ? '' : source).replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const attrs = [
    [/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi, 'script-src'],
    [/<link[^>]*\shref\s*=\s*["']([^"']+)["']/gi, 'link-href'],
    [/<img[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi, 'img-src'],
  ];
  for (const [re, kind] of attrs) {
    let m;
    /* eslint-disable-next-line no-cond-assign */
    while ((m = re.exec(s)) !== null) {
      const v = m[1].trim();
      // 只查本地相对资源：跳过 http(s)://、//cdn、data:/mailto:、#anchor、绝对路径
      if (/^(https?:)?\/\//i.test(v) || /^(data|mailto|tel|javascript):/i.test(v)) continue;
      if (v.startsWith('#') || v.startsWith('/')) continue;
      out.push({ spec: v, kind });
    }
  }
  return out;
}

/**
 * 判断一个相对引用指向的文件是否存在于产物里。
 * 按 Node 的解析习惯做候选补全：原样 → .js/.mjs/.cjs/.json → /index.js
 */
function resolveRef(fromRel, spec, existingSet) {
  const baseDir = path.posix.dirname(fromRel);
  let target = path.posix.normalize(path.posix.join(baseDir === '.' ? '' : baseDir, spec));
  if (target.startsWith('..')) return { ok: false, reason: 'escapes-workspace', target };

  const cands = [target];
  if (!path.posix.extname(target)) {
    for (const e of ['.js', '.mjs', '.cjs', '.json']) cands.push(target + e);
    for (const e of ['.js', '.mjs', '.cjs']) cands.push(`${target}/index${e}`);
  }
  const hit = cands.find((c) => existingSet.has(c));
  return hit ? { ok: true, target: hit } : { ok: false, reason: 'missing', target };
}

/* ══════════════════════════════════════════════════════════════════
   验证计划
   ══════════════════════════════════════════════════════════════════ */

function isTsLike(rel) { return TS_LIKE.includes(path.posix.extname(rel).toLowerCase()); }

/**
 * 生成验证计划（**不执行**，纯规划 —— 可单测）。
 *
 * @param {object} opts
 *   - files   [{ path, absPath, bytes }]  磁盘真实文件（ArtifactStore.walk() 的结果）
 *   - level   'syntax' | 'static'(默认) | 'build'
 *   - pkg     工作区 package.json 的内容（对象；null = 没有）
 *   - nodePath 覆盖 node 可执行文件（默认 process.execPath）
 *   - npmPath  覆盖 npm（默认按 node 同目录找）
 * @returns {{ level, steps:Array, skipped:Array }}
 */
function planVerification({ files = [], level = 'static', pkg = null, nodePath = null, npmPath = null } = {}) {
  const steps = [];
  const skipped = [];

  for (const f of files) {
    const rel = f.path;
    const abs = f.absPath;
    const ext = path.posix.extname(rel).toLowerCase();

    if (CHECKABLE.includes(ext)) {
      steps.push({
        kind: 'syntax', file: rel, absPath: abs,
        cmd: nodePath || process.execPath, args: ['--check', abs], label: `node --check ${rel}`,
      });
      continue;
    }
    if (JSON_LIKE.includes(ext)) {
      steps.push({ kind: 'json', file: rel, absPath: abs, label: `JSON.parse ${rel}` });
      continue;
    }
    if (isTsLike(rel)) {
      /* ★ 不假装能验证：Node 不认 JSX/TS 语法，用它去 check 只会得到一堆假错误。
       *   诚实报"未验证"，并在 summary 里说出来。 */
      skipped.push({ kind: 'syntax', file: rel, reason: 'no-ts-compiler', detail: 'TS/JSX 需要 tsc，本层未内置' });
      continue;
    }
    if (HTML_LIKE.includes(ext) || ext === '.css') {
      skipped.push({ kind: 'syntax', file: rel, reason: 'not-applicable' });
      continue;
    }
    skipped.push({ kind: 'syntax', file: rel, reason: 'unknown-ext', detail: ext || '(none)' });
  }

  /* 引用完整性：只要有源码/HTML 就跑（零执行，便宜） */
  if (level !== 'syntax') {
    const refTargets = files.filter((f) => {
      const e = path.posix.extname(f.path).toLowerCase();
      return CHECKABLE.includes(e) || JSON_LIKE.includes(e) || HTML_LIKE.includes(e);
    });
    if (refTargets.length) {
      steps.push({ kind: 'refs', file: null, absPath: null, label: '引用完整性（相对路径 / 本地资源）' });
    }
  }

  /* 真跑构建：**仅在显式 level:'build' 且确实有构建脚本时** */
  if (level === 'build') {
    const script = pkg && pkg.scripts && pkg.scripts.build;
    if (!script) {
      skipped.push({ kind: 'build', file: 'package.json', reason: 'no-build-script', detail: '未声明 scripts.build' });
    } else {
      const npm = npmPath || defaultNpmPath(nodePath);
      if (!npm) {
        skipped.push({ kind: 'build', file: 'package.json', reason: 'npm-not-found', detail: '找不到 npm（与 node 同目录）' });
      } else {
        /* ★ npm 在 Windows 上是 npm.cmd，必须走 shell 才能执行 */
        steps.push({
          kind: 'build', file: 'package.json', cmd: npm,
          args: ['run', 'build'], shell: process.platform === 'win32',
          label: `npm run build（${String(script).slice(0, 40)}）`,
        });
      }
    }
  } else {
    skipped.push({ kind: 'build', file: null, reason: 'level-disabled', detail: `level=${level} 不执行构建（会执行任意代码，需显式开启）` });
  }

  return { level, steps, skipped };
}

function defaultNpmPath(nodePath) {
  const dir = path.dirname(nodePath || process.execPath);
  const cands = process.platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
  for (const c of cands) {
    const p = path.join(dir, c);
    try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════
   执行验证
   ══════════════════════════════════════════════════════════════════ */

/**
 * 把 node --check 的 stderr 变成给人看的失败条目。
 *
 * ★ 实测记录（Node 24.19，2026-09-22）—— 这条会影响"什么才算错"：
 *
 *   | 场景                              | 退出码 | 说明 |
 *   |-----------------------------------|--------|------|
 *   | 无 package.json + import/export   | **0**  | Node 22.7+ 起 `--experimental-detect-module` 默认开启，
 *   |                                   |        | 会自动判定为 ESM —— **这是能跑起来的**，不该判失败 |
 *   | `"type":"commonjs"` + import      | 1      | 真报错（`Cannot use import statement outside a module`）|
 *   | `"type":"module"` + import        | 0      | 正常 |
 *   | 真语法错                          | 1      | 带准确行号 |
 *
 *   推论：**不能凭"文件里有 import"就判它错** —— 那在 Node 24 上是误报。
 *   subprocess 的 cwd 设成工作区，Node 自己去读工作区的 package.json，
 *   得到的就是"产物真的跑起来时会怎样"。这个准确性是免费拿到的，别自己另写一套判断。
 */
function diagnoseSyntax(rel, res) {
  const err = String(res.stderr || '').trim();
  const lines = err.split('\n').filter(Boolean);

  /* 行号：**不能只看第一行** —— Node 报语法错前可能先打一行警告
   * （如 `(node:32224) Warning: Failed to load the ES module: …`），
   * 那行里带的是进程号不是行号，拿它当 head 会得到 line=null。 */
  const fileLine = lines.find((l) => /:\d+\s*$/.test(l) && !/^\s*\(node:/.test(l)) || '';
  const mm = fileLine.match(/:(\d+)\s*$/) || err.match(/:(\d+):(\d+)/);
  const msgLine = lines.find((l) => /(?:Syntax)?Error:/.test(l)) || lines[lines.length - 1] || '语法错误';

  const base = {
    kind: 'syntax', file: rel,
    line: mm ? Number(mm[1]) : null,
    message: msgLine.replace(/^.*?Error:\s*/, '').trim().slice(0, 300),
  };

  if (/Cannot use import statement outside a module|Cannot use export|Unexpected token 'export'/.test(err)) {
    return {
      ...base, severity: 'error', code: 'esm-without-module-type',
      hint: '产物用了 ESM 语法（import/export），但工作区的 package.json 声明了 "type":"commonjs"（或产物要跑在旧版 Node 上）。补上 "type":"module"，或改用 CJS 的 require。',
    };
  }
  if (/Cannot find module/.test(err)) {
    return { ...base, severity: 'error', code: 'syntax-missing-module', hint: '语法解析阶段就找不到模块名（通常是把模块路径写成了变量）。' };
  }
  return { ...base, severity: 'error', code: 'syntax-error', hint: '按报出的行列号修这一处；不要重写整个文件。' };
}

/**
 * 执行验证计划。**永不 reject**。
 *
 * @param {object} plan planVerification 的返回值
 * @param {object} opts
 *   - root       工作区根（子进程 cwd）
 *   - files      磁盘文件清单（引用检查要用）
 *   - timeoutMs  单个命令超时
 *   - concurrency 并发度
 *   - env        覆盖子进程环境（build 档可用来收紧）
 * @returns {Promise<{ results:Array, failures:Array, skipped:Array, ran:number, summary:object }>}
 */
async function runVerification(plan, {
  root, files = [], timeoutMs = DEFAULT_TIMEOUT_MS, concurrency = DEFAULT_CONCURRENCY, env = null,
} = {}) {
  if (!root) throw new Error('runVerification: root required');
  const results = [];
  const failures = [];
  const existing = new Set(files.map((f) => f.path));

  /* ── ① 语法 / JSON —— 真跑 ── */
  const runnable = plan.steps.filter((s) => s.kind === 'syntax');
  const syntaxResults = await pool(runnable, concurrency, async (step) => {
    const res = await run(step.cmd, step.args, { cwd: root, timeoutMs, env });
    if (res.code === 0) {
      return { kind: 'syntax', file: step.file, ok: true, code: 0, ms: res.ms, timedOut: false };
    }
    if (res.timedOut) {
      return {
        kind: 'syntax', file: step.file, ok: false, code: 124, ms: res.ms, timedOut: true,
        failure: { kind: 'syntax', file: step.file, severity: 'error', code: 'timeout', message: `语法检查超时（${timeoutMs}ms）`, hint: '文件可能异常大或子进程异常。' },
      };
    }
    return {
      kind: 'syntax', file: step.file, ok: false, code: res.code, ms: res.ms, timedOut: false,
      failure: diagnoseSyntax(step.file, res),
    };
  });
  for (const r of syntaxResults) {
    results.push(r);
    if (r.failure) failures.push(r.failure);
  }

  /* ── ② JSON.parse ── */
  for (const step of plan.steps.filter((s) => s.kind === 'json')) {
    /* eslint-disable-next-line no-await-in-loop */
    let text = '';
    try { text = fs.readFileSync(step.absPath, 'utf8'); } catch (e) { text = null; }
    if (text == null) {
      const fl = { kind: 'json', file: step.file, severity: 'error', code: 'unreadable', message: '文件读不出来', hint: '检查落盘是否成功。' };
      results.push({ kind: 'json', file: step.file, ok: false, code: 1, failure: fl });
      failures.push(fl);
      continue;
    }
    try {
      JSON.parse(text);
      results.push({ kind: 'json', file: step.file, ok: true, code: 0 });
    } catch (e) {
      const fl = {
        kind: 'json', file: step.file, severity: 'error', code: 'invalid-json',
        message: String(e.message).slice(0, 200), hint: 'JSON 语法错误会让任何读取它的代码直接抛异常。',
      };
      results.push({ kind: 'json', file: step.file, ok: false, code: 1, failure: fl });
      failures.push(fl);
    }
  }

  /* ── ③ 引用完整性（零执行） ── */
  const refStep = plan.steps.find((s) => s.kind === 'refs');
  if (refStep) {
    for (const f of files) {
      const ext = path.posix.extname(f.path).toLowerCase();
      let src = '';
      try { src = fs.readFileSync(f.absPath, 'utf8'); } catch (e) { continue; }

      const refs = CHECKABLE.includes(ext) ? extractRelativeRefs(src)
        : (HTML_LIKE.includes(ext) ? extractHtmlRefs(src) : []);
      for (const r of refs) {
        // HTML 的引用按 HTML 所在目录解析；JS 按自身目录解析（resolveRef 已处理）
        const res = resolveRef(f.path, r.spec, existing);
        if (res.ok) continue;
        failures.push({
          kind: 'refs', file: f.path, ref: r.spec, severity: 'error',
          code: res.reason === 'missing' ? 'missing-ref' : 'ref-escapes-workspace',
          message: `${r.kind} 引用了「${r.spec}」，但产物里没有 ${res.target}`,
          hint: '要么补上这个文件，要么把引用改成实际存在的路径 —— 别改引用的写法来"绕过"检查。',
        });
      }
    }
    results.push({
      kind: 'refs', file: null,
      ok: !failures.some((x) => x.kind === 'refs'),
      code: failures.some((x) => x.kind === 'refs') ? 1 : 0,
    });
  }

  /* ── ④ 真构建（仅在用户显式开启后才有这一步） ── */
  for (const step of plan.steps.filter((s) => s.kind === 'build')) {
    /* eslint-disable-next-line no-await-in-loop */
    const res = await run(step.cmd, step.args, {
      cwd: root, timeoutMs: Math.max(timeoutMs, 60000), env, shell: step.shell,
    });
    const ok = res.code === 0;
    const r = {
      kind: 'build', file: step.file, ok, code: res.code, ms: res.ms, timedOut: res.timedOut,
      stdout: res.stdout.slice(-2000), stderr: res.stderr.slice(-2000),
      spawnError: res.spawnError || null,
    };
    results.push(r);
    if (!ok) {
      failures.push({
        kind: 'build', file: step.file, severity: 'error',
        code: res.timedOut ? 'build-timeout' : 'build-failed',
        message: `构建命令失败（退出码 ${res.code}）`,
        /* ★ 把真实输出前几行塞进去 —— 这是给 AI 修 bug 用的**证据**，
         *   比"构建失败"四个字有用一万倍。 */
        detail: firstLines(res.stderr || res.stdout, 12),
        hint: '读上面的真实报错定位；只改出问题的地方。',
      });
    }
  }

  return {
    results,
    failures,
    skipped: plan.skipped,
    ran: results.length,
    summary: summarize(results, failures, plan),
  };
}

function firstLines(text, n) {
  return String(text || '').split('\n').filter(Boolean).slice(0, n).join('\n').slice(0, 1200);
}

function summarize(results, failures, plan) {
  const byKind = {};
  for (const r of results) {
    byKind[r.kind] = byKind[r.kind] || { ran: 0, ok: 0 };
    byKind[r.kind].ran += 1;
    if (r.ok) byKind[r.kind].ok += 1;
  }
  return {
    level: plan.level,
    ran: results.length,
    failed: failures.length,
    errors: failures.filter((f) => f.severity === 'error').length,
    warnings: failures.filter((f) => f.severity === 'warning').length,
    byKind,
    skipped: plan.skipped.length,
    unverified: plan.skipped.filter((s) => s.reason === 'no-ts-compiler').map((s) => s.file),
  };
}

/* ══════════════════════════════════════════════════════════════════
   判定
   ══════════════════════════════════════════════════════════════════ */

/**
 * ★ 汇总成 buildPass —— **喂给 shouldStop('build', { buildPass })** 的那个值。
 *
 * 语义（与 judgeBuildPass 的 null 契约对齐）：
 *   - 真的跑了检查且全过 → true
 *   - 跑了检查且有 error → false
 *   - **一个检查都没跑**（工作区空 / 全是无法验证的类型）→ null（不撒谎）
 *
 * ★ 为什么空工作区必须返回 null 而不是 true：
 *   返回 true 就等于说"没有文件通过了一切检查"= "虚无通过一切检查"，
 *   这正是 judgeBuildPass 拒绝犯的错（它不肯因一句"通过了"就给 true）。
 *   没有证据时，答案只能是"不知道"。
 */
function verdictOf(runResult) {
  const failures = (runResult && runResult.failures) || [];
  const errors = failures.filter((f) => f.severity === 'error');
  const ran = (runResult && runResult.ran) || 0;
  const summary = (runResult && runResult.summary) || {};

  if (!ran) {
    return {
      buildPass: null,
      reason: '没有任何检查可执行（工作区为空，或文件类型都不在可验证范围内）→ 不给出"通过"',
      failures, errors, unverified: summary.unverified || [],
    };
  }
  if (errors.length) {
    return { buildPass: false, reason: `${errors.length} 处真实错误（本机执行结果，非模型自述）`, failures, errors, unverified: summary.unverified || [] };
  }
  const unverified = summary.unverified || [];
  return {
    buildPass: true,
    reason: unverified.length
      ? `全部可执行的检查通过（★ 但有 ${unverified.length} 个文件未验证：${unverified.join('、')}）`
      : `全部 ${ran} 项检查通过`,
    failures, errors, unverified,
  };
}

/**
 * 把真实失败清单转成**喂给 AI 的批评文本**。
 *
 * ★ 为什么要单独一个函数、而不是让调用方 join('\n')：
 *   格式里有三条硬要求，写散在调用方就会漂：
 *     ① 必须点明"这是本机执行结果，不是谁的判断"——否则模型会当成"某个 AI 的意见"来辩论；
 *     ② 每条必须带**文件 + 位置 + 原始报错**，否则模型只能猜；
 *     ③ 必须限定"只修这些、只交回改动过的文件"——否则它借机重写整个项目，
 *        把上一轮已经通过的部分改坏（这是修复回路最典型的退化方式）。
 */
function feedbackText(verdict, { maxItems = 20 } = {}) {
  const errs = (verdict && verdict.errors) || [];
  if (!errs.length) return '';
  const lines = [
    '【本机真实检查结果 —— 不是谁的判断，是编译器/解析器的输出】',
    `共 ${errs.length} 处错误：`,
  ];
  errs.slice(0, maxItems).forEach((f, i) => {
    const loc = [f.file, f.line ? `第 ${f.line} 行` : null].filter(Boolean).join(' ') || '(全局)';
    lines.push(`${i + 1}. [${f.kind}] ${loc}`);
    if (f.message) lines.push(`   报错：${String(f.message).slice(0, 300)}`);
    if (f.detail) lines.push(`   输出：${String(f.detail).split('\n').slice(0, 6).join('\n         ')}`);
    if (f.hint) lines.push(`   提示：${f.hint}`);
  });
  if (errs.length > maxItems) lines.push(`…另有 ${errs.length - maxItems} 处未列出。`);
  lines.push('');
  lines.push('★ 要求：');
  lines.push('1. 只修上面列出的问题，**不要重写整个文件**；');
  lines.push('2. 只交回**你改动过的文件**（每个文件一个代码块，照旧用 path= 标路径）；');
  lines.push('3. 不要解释，不要复述报错内容。');
  return lines.join('\n');
}

/** 一段给用户看的单行摘要 */
function verdictLine(verdict) {
  if (!verdict) return '（无验证结果）';
  const tag = verdict.buildPass === true ? '✔ 通过' : (verdict.buildPass === false ? '✗ 未通过' : '? 未验证');
  return `${tag} — ${verdict.reason}`;
}

module.exports = {
  TS_LIKE,
  CHECKABLE,
  JSON_LIKE,
  HTML_LIKE,
  DEFAULT_TIMEOUT_MS,
  run,
  pool,
  extractRelativeRefs,
  extractHtmlRefs,
  resolveRef,
  planVerification,
  runVerification,
  verdictOf,
  feedbackText,
  verdictLine,
  defaultNpmPath,
  diagnoseSyntax,
};
