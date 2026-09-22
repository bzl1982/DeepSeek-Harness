'use strict';
/**
 * core/artifact-bus.js —— 产物总线：把 AI 回复里的代码块变成磁盘上的**真文件**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须有这一层（build 模式的临界点）
 *
 *   build 模式的契约里，「分头实现」阶段的 produces 是 'artifact' ——
 *   它的产出本该是**文件** {path, content}，不是聊天文本。
 *   但在这层出现之前，那段回复只是被当成 content 字符串存进会议记录，
 *   和其他阶段的闲聊没有任何区别。于是：
 *
 *     · 「集成验证」无从验证 —— 磁盘上没有文件可编译，
 *       集成席只能"读一遍说没问题"，而它说的不算数（见 judgeBuildPass 的长注释）；
 *     · judgeBuildPass() 永远返回 null（它诚实地**拒绝采信模型的自述**），
 *       而**没有真实编译结果来接替它** → shouldStop('build') 永远 degraded
 *       → 会议只能跑满 maxIterations(4)，白烧 3 轮。
 *       这与上一轮 winnerId 缺参是**同一族的故障**：判据缺输入 → 静默失效。
 *
 *   本文件补的就是「文本 → 文件」这一段。
 * ─────────────────────────────────────────────────────────────────────
 *
 * ★★ 为什么解析要"宽容"、而 prompt 只教一种写法
 *   各家的代码块标注风格差异极大：```js path=a.js / ```js a.js / ```a.js /
 *   块前一行 // a.js / 干脆吐一坨 {"path":…,"content":…} 的 JSON。
 *   若解析只认一种，换个模型就静默丢文件 —— 而"丢文件"比"报错"危险得多：
 *   会议照常往下走，集成席看到的是残缺产物，"失败"被伪装成"通过"。
 *   所以：**prompt 教一种（推荐写法），解析器认五种（兼容）**，
 *   并且认不出来的块必须进 `rejected` 而不是被悄悄忽略。
 *
 * ★★ 安全闸（三道，缺一不可）
 *   ① normalizeArtifactPath —— 拒绝绝对路径/盘符/UNC/`..`/控制字符/可执行扩展名
 *   ② resolve 之后仍要验"在 root 之内"（纵深防御，不假设 ① 没漏洞）
 *   ③ root **必须由调用方显式传入**，且**没有默认值** ——
 *      绝不能"默认写到项目目录"，否则 AI 产出的文件会覆盖 meeting-lab 自己的源码。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ══════════════════════════════════════════════════════════════════
   给「分头实现」阶段的格式约定（追加到 prompt 末尾，与 VERDICT_TEMPLATE 同款做法）
   ══════════════════════════════════════════════════════════════════ */

const ARTIFACT_TEMPLATE = [
  '【交付要求】你要交的是**文件**，不是说明文字。规则：',
  '1. 每个文件用一个代码块，**在语言后面用 path= 标出相对路径**，例如：',
  '   ```js path=src/util.js',
  '   （代码）',
  '   ```',
  '2. 路径必须是**相对路径**，用 `/` 分隔；不要写盘符、不要以 `/` 开头、不要用 `..`。',
  '3. ★ **只写契约里分给你的模块**。写别人的模块会被判为越界并计入集成冲突。',
  '4. 代码块**外面**可以写必要的解释（为什么这样实现），但**不要把代码贴在正文里**。',
  '5. 代码必须是**完整文件**（不要用 `// ...` 省略号代替已有内容）——落盘时按整份文件写入。',
].join('\n');

/* ══════════════════════════════════════════════════════════════════
   常量
   ══════════════════════════════════════════════════════════════════ */

/**
 * 禁止落盘的可执行扩展名。
 * ★ 理由：产物随后会被交给编译器/解释器处理（build 档甚至会 npm run build），
 *   一个 .exe/.dll 落在工作区里没有任何正当理由 —— 只可能是攻击面。
 *   源码类扩展名（.js/.ts/.py…）不在黑名单里，它们是**正常产物**。
 */
const FORBIDDEN_EXT = Object.freeze([
  '.exe', '.dll', '.so', '.dylib', '.msi', '.com', '.scr', '.sys', '.drv',
  '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.jsе', // 注意最后一个是西里尔字母 е（同形字攻击样例，必须挡）
]);

/** 已知的语言标记 —— 用于把 info string 里的"语言"与"路径"分开 */
const KNOWN_LANGS = new Set([
  'js', 'javascript', 'jsx', 'mjs', 'cjs', 'ts', 'typescript', 'tsx',
  'json', 'jsonc', 'html', 'htm', 'xml', 'css', 'scss', 'less', 'sass',
  'md', 'markdown', 'py', 'python', 'rb', 'ruby', 'go', 'golang', 'rs', 'rust',
  'java', 'kt', 'kotlin', 'c', 'h', 'cpp', 'c++', 'cc', 'hpp', 'cs', 'csharp',
  'php', 'swift', 'dart', 'lua', 'pl', 'perl', 'r', 'sql', 'sh', 'bash', 'zsh',
  'ps', 'ps1', 'yaml', 'yml', 'toml', 'ini', 'conf', 'txt', 'text', 'plaintext',
  'vue', 'svelte', 'dockerfile', 'makefile', 'diff', 'patch', 'log', 'env',
]);

/** 一个代码块的最大字节数（单块，防"一整份 minified 依赖"把内存撑爆） */
const MAX_BLOCK_BYTES = 512 * 1024;

/* ══════════════════════════════════════════════════════════════════
   路径安全
   ══════════════════════════════════════════════════════════════════ */

function isWindowsReservedSegment(seg) {
  const base = String(seg).split('.')[0].toUpperCase();
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base);
}

/**
 * 归一化产物路径 —— **安全闸 ①**。
 *
 * 返回 { ok:true, path, ext, nested } 或 { ok:false, reason, detail }。
 * 归一化后一律是 POSIX 风格的相对路径（`a/b/c.js`），与宿主平台无关 ——
 * 这样"同一份产物在 Windows / Linux 上算同一个文件"，测试与去重才可靠。
 *
 * @param {string} raw 模型给出的原始路径串（可能带引号/反引号/包裹符号）
 */
function normalizeArtifactPath(raw) {
  let p = String(raw == null ? '' : raw).trim();
  if (!p) return { ok: false, reason: 'empty' };

  // 去掉常见的包裹符号：`"src/a.js"` / `` `src/a.js` `` / `<src/a.js>`
  p = p.replace(/^[`'"<(]+/, '').replace(/[`'">)]+$/, '').trim();
  if (!p) return { ok: false, reason: 'empty-after-strip' };

  // —— 绝对路径族：一律拒绝（产物必须落在工作区内的相对路径上）——
  if (/^[a-zA-Z]:/.test(p)) return { ok: false, reason: 'absolute-drive', detail: p.slice(0, 8) };
  if (p.startsWith('\\\\') || p.startsWith('//')) return { ok: false, reason: 'unc', detail: p.slice(0, 12) };
  if (p.startsWith('/')) return { ok: false, reason: 'absolute' };
  if (p.startsWith('~')) return { ok: false, reason: 'home-shorthand' };

  // —— 控制字符 / BOM / 空字节 ——
  if (/[\u0000-\u001f\u007f\ufeff]/.test(p)) return { ok: false, reason: 'control-char' };

  const norm = p.replace(/\\/g, '/');
  const segs = norm.split('/');

  // ★ `..` 必须**逐段**判，不能用 includes('..')：`a..b/c.js` 是合法文件名
  if (segs.some((s) => s === '..')) return { ok: false, reason: 'traversal' };
  if (segs.some(isWindowsReservedSegment)) return { ok: false, reason: 'reserved-name' };

  const clean = segs.filter((s) => s && s !== '.').join('/');
  if (!clean) return { ok: false, reason: 'empty-after-normalize' };
  if (clean.length > 200) return { ok: false, reason: 'too-long', detail: String(clean.length) };
  // 尾随 `.` 或空格在 Windows 上会被静默剥掉 → 归一化结果与预期不符，直接拒
  if (/[. ]$/.test(clean)) return { ok: false, reason: 'trailing-dot-or-space' };

  const ext = path.extname(clean).toLowerCase();
  if (FORBIDDEN_EXT.includes(ext)) return { ok: false, reason: 'forbidden-ext', detail: ext };

  return { ok: true, path: clean, ext, nested: clean.includes('/') };
}

/* ══════════════════════════════════════════════════════════════════
   解析：AI 回复 → [{ path, content }]
   ══════════════════════════════════════════════════════════════════ */

/** 从 info string 里抽路径（写法 ①②③） */
function pathFromInfo(info) {
  const s = String(info || '').trim();
  if (!s) return null;

  // ① 显式键值：path= / file= / filename= / 文件=  （顺序无所谓，可带引号）
  const kv = s.match(/(?:^|\s)(?:path|file|filename|文件)\s*[=:]\s*("([^"]+)"|'([^']+)'|`([^`]+)`|(\S+))/i);
  if (kv) return kv[2] || kv[3] || kv[4] || kv[5] || null;

  const tokens = s.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  // 语言标记在最前 → 消费掉
  let rest = tokens;
  if (KNOWN_LANGS.has(tokens[0].toLowerCase())) rest = tokens.slice(1);
  else if (tokens.length > 1 && KNOWN_LANGS.has(tokens[1].toLowerCase())) rest = [tokens[0], ...tokens.slice(2)];
  if (!rest.length) return null;

  // ② rest 里第一个"像路径"的 token（含 / 或带扩展名）
  const looksPath = (t) => /[/\\]/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t);
  const cand = rest.find(looksPath);
  if (cand) return cand;

  // ③ 整个 info 就是路径（且不是语言名）
  if (!KNOWN_LANGS.has(s.toLowerCase()) && looksPath(s)) return s;
  return null;
}

/** 从代码体第一行的注释里抽路径（写法 ④） */
function pathFromLeadingComment(body) {
  const first = String(body || '').split('\n', 1)[0] || '';
  const m = first.match(/^\s*(?:\/\/|#|--|\/\*|<!--)\s*(?:path|file|filename|文件)?\s*[:=]?\s*([^\s*<>]+\.\w{1,8})/i);
  return m ? m[1] : null;
}

/** 从代码块**前一行**的说明里抽路径（写法 ⑤） */
function pathFromPrecedingLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;

  /* ★ 尾锚放宽（2026-09-22 实测后补）：
   *   原来要求路径**紧贴行尾**，于是两种极常见的写法整块丢失 ——
   *     · 「还有入口文件 `src/index.js`：」 —— 句尾带中文冒号（中文模型的强习惯）
   *     · 「<!-- path=src/api.js -->」  —— HTML 注释包裹
   *   丢掉一块产物 = 那个文件根本不存在 → 编译期报「引用不存在」，
   *   严重的是会议**不知道少了一个文件**（"丢文件"比"报错"危险，这是本文件的核心判断）。
   *   所以尾锚只放宽到「收尾符号 + 中英文冒号」这一档；**故意不放宽句号/逗号**
   *   —— 句尾带句号的行更可能是散文（「我已经把 src/a.js 改好了。」），
   *     把它当标题会把下一块的内容写到错的文件上。 */
  const m = s.match(/(?:\*\*|`|【|\[)?\s*(?:文件|path|file(?:name)?)?\s*[:：=]?\s*([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})\s*(?:\*\*|`|】|\]|-->)?\s*[：:]?\s*$/);
  if (!m) return null;

  /* ★ 歧义不猜：同一行里除了它还有别的路径 → 返回 null。
   *   例「先看 src/old.js 与 src/new.js 的区别：」——猜错会把内容写进别人的文件。
   *   宁可丢（丢会被"引用不存在"检查抓到），不可猜错（猜错会静默写到错的地方）。 */
  const others = (s.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}/g) || []).filter((x) => x !== m[1]);
  if (others.length) return null;

  return m[1];
}

/** 尝试把一段文本当"结构化产物 JSON"解析（写法 ⑥，与 fenced 块并列） */
function filesFromJson(text) {
  const s = String(text || '').trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
  let obj;
  try { obj = JSON.parse(s); } catch (e) { return null; }

  const arr = Array.isArray(obj) ? obj
    : Array.isArray(obj && obj.files) ? obj.files
      : (obj && typeof obj.path === 'string') ? [obj]
        : null;
  if (!arr) return null;

  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    if (typeof it.path !== 'string') continue;
    out.push({ path: it.path, content: String(it.content != null ? it.content : '') });
  }
  return out.length ? out : null;
}

/** 规范化文件正文：统一换行符，末尾恰好一个换行 */
function normalizeContent(raw) {
  let c = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
  c = c.replace(/\n+$/, '');
  return c.length ? `${c}\n` : '';
}

/**
 * ★ 从模型回复里解析出全部产物文件。
 *
 * **纯函数、不做任何 IO** —— 因此可以被穷举单测（这是它敢"宽容"的前提）。
 *
 * @param {string} text 模型回复原文
 * @param {object} opts
 *   - defaultPath  找不到路径时的兜底（由调用方从 `contract.modules` 取"分给这个人的模块"）。
 *                  ★ 兜底也**只能有一个**；若有多个候选，宁可不给 —— 猜错路径 = 覆盖别人的文件。
 * @returns {{ files:Array, rejected:Array, stats:object }}
 *   files:    [{ path, content, lang, how }]   how = 靠哪种写法认出来的（可审计）
 *   rejected: [{ reason, detail, snippet }]    认不出来/不安全的块 —— **必须上报，不许静默丢**
 */
function parseArtifacts(text, { defaultPath = null } = {}) {
  const src = String(text == null ? '' : text);
  const files = [];
  const rejected = [];
  const stats = { blocks: 0, fromJsonBlock: 0, fromFence: 0, usedDefault: 0 };

  /** 统一收口：归一化 + 归一化正文 + 去重（同一批里同名取后者，并记 superseded） */
  const seen = new Map();
  const push = (rawPath, rawContent, lang, how) => {
    const np = normalizeArtifactPath(rawPath);
    if (!np.ok) {
      rejected.push({ reason: np.reason, detail: np.detail || null, snippet: String(rawPath || '').slice(0, 80) });
      return;
    }
    const content = normalizeContent(rawContent);
    if (!content.trim()) {
      rejected.push({ reason: 'empty-content', detail: null, snippet: np.path });
      return;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_BLOCK_BYTES) {
      rejected.push({ reason: 'block-too-large', detail: String(Buffer.byteLength(content, 'utf8')), snippet: np.path });
      return;
    }
    /* ★ 同一批里同名：**后者取代前者**，并把"取代"这件事留在新记录的 superseded 上。
     *   注意不能只给旧记录打标记却不换数组里的元素 ——
     *   那会变成"标着被取代、却仍然是产出结果"的自相矛盾状态（用例抓到过一次）。 */
    const prev = seen.get(np.path);
    const rec = { path: np.path, content, lang: lang || null, how };
    if (prev) rec.superseded = true;
    seen.set(np.path, rec);
    const idx = files.findIndex((f) => f.path === np.path);
    if (idx >= 0) files[idx] = rec;
    else files.push(rec);
  };

  /* ── 写法 ①②③④⑤：fenced 代码块 ── */
  const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\n]*)\n([\s\S]*?)^[ \t]*\2[ \t]*$/gm;
  let m;
  while ((m = FENCE.exec(src)) !== null) {
    stats.blocks += 1;
    const info = (m[3] || '').trim();
    const body = m[4] || '';
    const lang = (info.split(/\s+/)[0] || '').toLowerCase() || null;

    /* ⑥-变体：info 是 json，且 body 是一个结构化产物包 —— 一次吐出多个文件。
     *   这比"把人写的 JSON 当代码文件"更常见（模型爱用这种格式交作业）。 */
    if (/^json(c|5)?$/i.test(info)) {
      const pack = filesFromJson(body);
      if (pack) {
        stats.fromJsonBlock += 1;
        for (const it of pack) push(it.path, it.content, 'json-pack', 'fence-json-pack');
        continue;
      }
    }

    let p = pathFromInfo(info);
    let how = p ? 'info-string' : null;
    if (!p) {
      p = pathFromLeadingComment(body);
      if (p) how = 'leading-comment';
    }
    if (!p) {
      // 块前一行（如 `### src/a.js` / `**文件：src/a.js**`）
      const before = src.slice(0, m.index).replace(/\n$/, '');
      const lastLine = before.split('\n').pop() || '';
      p = pathFromPrecedingLine(lastLine);
      if (p) how = 'preceding-line';
    }
    if (!p && defaultPath) {
      p = defaultPath;
      how = 'contract-default';
      stats.usedDefault += 1;
    }
    if (!p) {
      rejected.push({ reason: 'no-path', detail: lang, snippet: body.trim().slice(0, 80) });
      continue;
    }
    stats.fromFence += 1;
    push(p, body, lang, how);
  }

  /* ── 写法 ⑥：整段就是结构化 JSON（没有任何 fenced 块时） ── */
  if (!stats.blocks) {
    const pack = filesFromJson(src);
    if (pack) {
      stats.fromJsonBlock += 1;
      for (const it of pack) push(it.path, it.content, null, 'raw-json');
    }
  }

  return { files, rejected, stats };
}

/* ══════════════════════════════════════════════════════════════════
   落盘
   ══════════════════════════════════════════════════════════════════ */

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 产物工作区。
 *
 * ★ root 必须显式传入，**故意不给默认值**：
 *   一旦有默认值，就会有人（包括未来的我）图省事让它落到项目目录，
 *   而 AI 产出的 `index.html`、`package.json` 会**覆盖真实仓库的文件**。
 *   宁可多写一行 `path.join(os.tmpdir(), …)`，也不要一个危险的默认。
 */
class ArtifactStore {
  /**
   * @param {object} opts
   *   - root           工作区根目录（必填，绝对路径优先）
   *   - maxFileBytes   单文件上限
   *   - maxTotalBytes  总量上限
   *   - logger
   */
  constructor({
    root = null,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    logger = null,
  } = {}) {
    if (!root) throw new Error('ArtifactStore: root 必须显式传入（不接受默认值——防止 AI 产物覆盖项目目录）');
    this.root = path.resolve(root);
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.logger = logger || (() => {});
    /** relPath -> { path, ownerId, bytes, sha256, lang, how } */
    this.files = new Map();
  }

  /** 绝对路径（**安全闸 ②**：resolve 之后再验一次"在 root 内"） */
  absPath(rel) {
    const abs = path.resolve(this.root, rel);
    const r = path.relative(this.root, abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) {
      throw new Error(`ArtifactStore: 路径越界（${rel}）→ 拒绝`);
    }
    return abs;
  }

  alreadyOwnedBy(rel, ownerId) {
    const cur = this.files.get(rel);
    return cur ? cur.ownerId : null;
  }

  /** 已落盘总量 */
  totalBytes() {
    let n = 0;
    for (const f of this.files.values()) n += f.bytes;
    return n;
  }

  /**
   * 落盘一个人的产物。
   *
   * ★ 冲突策略（有意选择"先到者保留"）：
   *   同一个路径被**不同的 AI** 写出两份 —— 这不是"后写的更新"，而是**契约被违背**
   *   （契约已经分了模块归属）。若让后者覆盖前者，集成席看到的是"一份看起来完整的代码"，
   *   真正的冲突被抹掉了；而保留先到者 + 记录冲突，就能把"哪儿断了"作为**证据**交给集成席。
   *   force=true 时才覆盖 —— 那是"同一作者修 bug"的场景，由调用方显式声明。
   *
   * @returns {{ written:Array, conflicts:Array, skipped:Array, outOfContract:Array }}
   */
  materialize(ownerId, files = [], { contract = null, force = false } = {}) {
    const written = [];
    const conflicts = [];
    const skipped = [];
    const outOfContract = [];
    const owned = contractModuleNames(contract, ownerId);

    for (const f of files) {
      const np = normalizeArtifactPath(f.path);
      if (!np.ok) {
        skipped.push({ path: String(f.path || ''), reason: np.reason });
        continue;
      }
      const rel = np.path;
      const content = String(f.content == null ? '' : f.content);
      const bytes = Buffer.byteLength(content, 'utf8');

      if (bytes > this.maxFileBytes) {
        skipped.push({ path: rel, reason: 'file-too-large', detail: `${bytes}>${this.maxFileBytes}` });
        continue;
      }
      if (this.totalBytes() + bytes > this.maxTotalBytes) {
        skipped.push({ path: rel, reason: 'total-too-large', detail: `${this.totalBytes() + bytes}>${this.maxTotalBytes}` });
        continue;
      }

      // —— 契约归属校验（越界不是致命错，但必须报出来给集成席看）——
      if (owned.size) {
        const base = rel.split('/').pop();
        if (!owned.has(base) && !owned.has(rel)) outOfContract.push({ path: rel, ownerId });
      }

      const holder = this.alreadyOwnedBy(rel, ownerId);
      if (holder && holder !== ownerId && !force) {
        /* 跨作者冲突：**保留先到者**，记下双方，供集成验证出证 */
        conflicts.push({ path: rel, kept: holder, rejected: ownerId });
        skipped.push({ path: rel, reason: 'conflict-kept-first', detail: holder });
        continue;
      }

      const abs = this.absPath(rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');

      const rec = {
        path: rel, ownerId, bytes, sha256: sha256(content),
        lang: f.lang || null, how: f.how || null, absPath: abs,
      };
      this.files.set(rel, rec);
      written.push({ path: rel, bytes, sha256: rec.sha256, ownerId });
    }

    return { written, conflicts, skipped, outOfContract };
  }

  /**
   * 从磁盘**真实**读一遍工作区（不是读内存记录）。
   * ★ 编译验证必须基于磁盘事实 —— 否则"内存里有记录但盘上没有"这种 bug 会被掩盖。
   */
  walk() {
    const out = [];
    const rec = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { rec(abs); continue; }
        if (!e.isFile()) continue;
        const rel = path.relative(this.root, abs).split(path.sep).join('/');
        let bytes = 0;
        try { bytes = fs.statSync(abs).size; } catch (e2) { /* ignore */ }
        out.push({ path: rel, absPath: abs, bytes });
      }
    };
    rec(this.root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  read(rel) {
    return fs.readFileSync(this.absPath(rel), 'utf8');
  }

  /** 清空工作区（幂等验证必须 —— 否则第二次跑会撞上一次的残留） */
  clean() {
    try { fs.rmSync(this.root, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    fs.mkdirSync(this.root, { recursive: true });
    this.files.clear();
    return true;
  }
}

/** 取契约里"分给某人的模块名"集合（basename + 原样两种都能匹配） */
function contractModuleNames(contract, ownerId) {
  const set = new Set();
  if (!contract || !Array.isArray(contract.modules)) return set;
  for (const m of contract.modules) {
    if (!m || m.owner !== ownerId || !m.module) continue;
    const s = String(m.module).trim();
    set.add(s);
    set.add(s.split('/').pop());
  }
  return set;
}

/**
 * 从契约文本里猜"某人的默认路径"。
 *
 * 用途：模型忘了标路径时兜底。**只在能唯一确定时才给** ——
 * 契约声明了 2 个以上模块却要兜底，说明模型漏标了，宁可报 rejected 让人看见，
 * 也不要猜错路径去覆盖别人的文件。
 */
function defaultPathFor(contract, ownerId) {
  const names = [...contractModuleNames(contract, ownerId)];
  if (!names.length) return null;
  const bases = [...new Set(names.map((n) => n.split('/').pop()))].filter(Boolean);
  /** 从 basename 还原契约里的原形态（src/index.js），不能返回光秃秃的 index.js */
  const restore = (base) => names.find((n) => n.includes('/') && n.split('/').pop() === base) || base;

  if (bases.length > 1) {
    // 多个候选：若其中一个"像入口"（index/main/app）优先，否则放弃兜底
    const idx = bases.find((b) => /^(index|main|app)\.[a-z0-9]+$/i.test(b));
    return idx ? restore(idx) : null;
  }
  return restore(bases[0]) || null;
}

module.exports = {
  ARTIFACT_TEMPLATE,
  FORBIDDEN_EXT,
  KNOWN_LANGS,
  MAX_BLOCK_BYTES,
  normalizeArtifactPath,
  parseArtifacts,
  normalizeContent,
  filesFromJson,
  ArtifactStore,
  contractModuleNames,
  defaultPathFor,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
};
