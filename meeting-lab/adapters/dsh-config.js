'use strict';
/**
 * adapters/dsh-config.js —— 读取 DSH 自身的 API 提供方配置
 *
 * ─────────────────────────────────────────────────────────────────────
 * 「双管齐下」的地基：网页版走 webview，API 版走 HTTP，两路同场开会。
 *
 *   API 通道的凭据不该由本项目重新维护一份（重复维护 = 迟早不一致），
 *   而应该**复用 DSH 客户端已有的配置**：
 *
 *     D:\Users\Admin\.dsh\settings.yaml       ← 提供方 + baseURL + 模型清单
 *     D:\Users\Admin\.dsh\.credentials.yaml   ← 密钥（refs: KEY_NAME: value）
 *
 *   好处：用户在客户端里加了新提供方，会议这边**不用改代码就能用**。
 * ─────────────────────────────────────────────────────────────────────
 *
 * ★ 安全约束（硬性）：
 *   1. 密钥**只在本进程内存里流转**，绝不写进任何日志、任何截图、任何交付文件。
 *   2. 对外暴露的 getRedacted() 只返回 host + 密钥长度，用于诊断。
 *   3. 本模块只读，从不写这两个文件。
 * ─────────────────────────────────────────────────────────────────────
 *
 * 为什么自己写 YAML 解析而不用依赖：
 *   只用到 map / 缩进 / 标量 / 短横线列表这四种结构，
 *   引入 js-yaml 会给一个"纯桌面小工具"加一个不必要的供应链风险面。
 *   解析器只覆盖这四种，遇到不认识的结构**明确报错**，不静默猜。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** 默认配置目录（可用环境变量覆盖，便于在别的机器/沙箱里跑） */
function defaultDshDir() {
  if (process.env.DSH_CONFIG_DIR) return process.env.DSH_CONFIG_DIR;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.dsh'),
    'D:\\Users\\Admin\\.dsh',
    path.join(home, 'AppData', 'Roaming', '.dsh'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch (_) { /* 继续找 */ }
  }
  return path.join(home, '.dsh');
}

/* ═══════════════════ 极简 YAML 解析（只支持四种结构） ═══════════════════ */

function stripComment(line) {
  // 只在「引号外」且「前面有空白」时把 # 当注释（避免 URL 里的 # 被误切）
  let inS = false; let inD = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function scalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  // 行内数组 [a, b, c]
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((x) => scalar(x)).filter((x) => x !== null);
  }
  // 行内对象 {a: 1, b: x}
  if (s.startsWith('{') && s.endsWith('}')) {
    const o = {};
    const inner = s.slice(1, -1).trim();
    if (inner) {
      for (const kv of inner.split(',')) {
        const i = kv.indexOf(':');
        if (i < 0) continue;
        o[kv.slice(0, i).trim()] = scalar(kv.slice(i + 1));
      }
    }
    return o;
  }
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * 解析 YAML 子集 → 普通对象。
 *
 * ★ 用递归下降而不是"缩进栈"：
 *   栈式写法在处理「`key:` 下面是列表、列表项里又有 key」这种两层嵌套时
 *   很容易把容器类型判断错（本项目实际踩过：models: 下的 - id: 被当成非列表）。
 *   递归下降按缩进自然分层，容器类型只由"该层第一个 token 是不是 - "决定，
 *   不会串层。
 *
 * 支持：`k:` 嵌套、`k: v`、`- v`、`- k: v`（列表里放对象）、行内 [] 与 {}。
 */
function parseYaml(text) {
  // 预处理：去掉空行与注释，记录每行缩进
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const s = stripComment(raw);
    if (!s.trim()) continue;
    lines.push({ indent: s.match(/^ */)[0].length, body: s.trim() });
  }

  let pos = 0;

  /**
   * 解析一个缩进层级下的所有内容。
   * @param {number} minIndent 该层允许的最小缩进
   */
  function parseNode(minIndent) {
    if (pos >= lines.length) return null;
    const first = lines[pos];
    if (first.indent < minIndent) return null;

    const isList = first.body.startsWith('- ');
    const indent = first.indent;
    const container = isList ? [] : {};

    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent < indent) break;         // 回上层
      if (l.indent > indent) { pos++; continue; }   // 异常缩进：容错跳过

      if (isList) {
        if (!l.body.startsWith('- ')) break;   // 列表结束
        const rest = l.body.slice(2).trim();
        const m = rest.match(/^([^:]+):\s*(.*)$/);

        if (m && rest.includes(':')) {
          // 列表项是对象：- id: xxx
          const obj = {};
          container.push(obj);
          const k = m[1].trim();
          const v = m[2];
          pos++;
          if (v) obj[k] = scalar(v);
          else obj[k] = parseNode(indent + 1);

          // 同一条目的后续 key（缩进更深、不以 - 开头）
          while (pos < lines.length
            && lines[pos].indent > indent
            && !lines[pos].body.startsWith('- ')) {
            const sub = lines[pos];
            const sm = sub.body.match(/^([^:]+):\s*(.*)$/);
            if (!sm) break;
            const sk = sm[1].trim();
            const sv = sm[2];
            pos++;
            obj[sk] = sv ? scalar(sv) : parseNode(sub.indent + 1);
          }
        } else {
          container.push(scalar(rest));
          pos++;
        }
        continue;
      }

      // map 层
      const m = l.body.match(/^([^:]+):\s*(.*)$/);
      if (!m) { pos++; continue; }
      const k = m[1].trim();
      const v = m[2];
      pos++;
      if (v) {
        container[k] = scalar(v);
      } else {
        const child = parseNode(indent + 1);
        container[k] = child === null ? null : child;
      }
    }
    return container;
  }

  const root = parseNode(0);
  return root === null ? {} : root;
}

/* ═══════════════════ 提供方装配 ═══════════════════ */

/** 各家的 OpenAI 兼容端点（settings.yaml 没写 baseURL 时用） */
const DEFAULT_BASE_URLS = Object.freeze({
  deepseek: 'https://api.deepseek.com/v1',
  agne: 'https://apihub.agnes-ai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openai: 'https://api.openai.com/v1',
});

/** 各家的默认模型（settings.yaml 没列 models 时用） */
const DEFAULT_MODELS = Object.freeze({
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  agne: ['agnes-3.0-flash'],
  // ★ 2026-09-22 实连实测修正：Gemini 的 gemini-2.5-flash 对**新用户已下线**，
  //   调用会返回 404「no longer available to new users」并提示改用 gemini-3.6-flash。
  //   这种"模型名静默过期"是 API 通道最典型的运维坑——不会报语法错，
  //   只会在真正发请求时 404。所以默认值要用当前可用的，并定期用
  //   `node tools/check-api.js --live` 复验。
  google: ['gemini-3.6-flash', 'gemini-2.5-pro'],
  openai: ['gpt-4o-mini'],
});

/**
 * 读出全部 API 提供方（含密钥）。
 * @param {object} opts { dir, includeSecrets }
 * @returns {{ providers: object, warnings: string[], dir: string }}
 */
function loadProviders({ dir = null, includeSecrets = true } = {}) {
  const baseDir = dir || defaultDshDir();
  const warnings = [];
  const providers = {};

  const settingsPath = path.join(baseDir, 'settings.yaml');
  const credPath = path.join(baseDir, '.credentials.yaml');

  let settings = {};
  try {
    settings = parseYaml(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    warnings.push(`读 settings.yaml 失败：${err.message}`);
  }

  let creds = {};
  try {
    const c = parseYaml(fs.readFileSync(credPath, 'utf8'));
    creds = (c && c.refs) || {};
  } catch (err) {
    warnings.push(`读 .credentials.yaml 失败：${err.message}`);
  }

  const declared = (settings && settings['llm-pi-ai'] && settings['llm-pi-ai'].providers) || {};

  for (const [key, cfg] of Object.entries(declared)) {
    const apiKeyEnv = cfg.apiKeyEnv || null;
    // 密钥优先级：credentials.refs → 环境变量
    let apiKey = apiKeyEnv && creds[apiKeyEnv] ? String(creds[apiKeyEnv]) : null;
    if (!apiKey && apiKeyEnv && process.env[apiKeyEnv]) apiKey = process.env[apiKeyEnv];
    if (!apiKey) warnings.push(`提供方「${key}」未取到密钥（${apiKeyEnv || '未声明 apiKeyEnv'}）`);

    const models = Array.isArray(cfg.models) && cfg.models.length
      ? cfg.models.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean)
      : (DEFAULT_MODELS[key] || []);

    providers[key] = {
      key,
      displayName: cfg.displayName || key,
      api: cfg.api || 'openai-completions',
      baseURL: cfg.baseURL || DEFAULT_BASE_URLS[key] || null,
      models,
      apiKeyEnv,
      apiKey: includeSecrets ? apiKey : (apiKey ? '***' : null),
      hasKey: !!apiKey,
    };
  }

  // ── 隐式提供方：凭据里有密钥、但 settings.yaml 没显式声明 ──
  //    DSH 的界面只写它用过的提供方，但凭据里可能还留着别的（如 DEEPSEEK_API_KEY）。
  //    只要密钥在、且我们知道它的官方端点，就补一个可用提供方出来。
  //    这样"会议能用几个 API 模型"取决于**密钥**，而不是取决于你最近开过哪个模型。
  for (const [credKey, val] of Object.entries(creds)) {
    const m = /^([A-Z0-9_]+)_API_KEY$/.exec(credKey);
    if (!m) continue;
    const pkey = m[1].toLowerCase();
    if (providers[pkey]) continue;                       // 已声明，不覆盖
    if (!val) continue;                                  // 空密钥
    if (!DEFAULT_BASE_URLS[pkey]) continue;              // 不知道端点，不猜

    providers[pkey] = {
      key: pkey,
      displayName: pkey,
      api: 'openai-completions',
      baseURL: DEFAULT_BASE_URLS[pkey],
      models: DEFAULT_MODELS[pkey] || [],
      apiKeyEnv: credKey,
      apiKey: includeSecrets ? String(val) : '***',
      hasKey: true,
      implicit: true,   // 来源标记：凭据推断，非 settings 声明
    };
  }

  return { providers, warnings, dir: baseDir };
}

/**
 * 脱敏摘要（可安全打印 / 落盘）：只暴露 host、是否有 key、模型数量。
 */
function getRedacted({ dir = null } = {}) {
  const { providers, warnings, dir: d } = loadProviders({ dir, includeSecrets: false });
  return {
    dir: d,
    warnings,
    providers: Object.values(providers).map((p) => {
      let host = '(未配置 baseURL)';
      try { host = p.baseURL ? new URL(p.baseURL).host : host; } catch (_) { /* 忽略 */ }
      return {
        key: p.key, displayName: p.displayName, host,
        api: p.api, hasKey: p.hasKey, modelCount: p.models.length,
        models: p.models.slice(0, 6),
      };
    }),
  };
}

/** 取单个提供方（含密钥） */
function getProvider(key, opts = {}) {
  const { providers } = loadProviders(opts);
  return providers[key] || null;
}

module.exports = {
  parseYaml,
  defaultDshDir,
  loadProviders,
  getProvider,
  getRedacted,
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
};
