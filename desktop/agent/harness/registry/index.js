'use strict';
/**
 * harness/registry/index.js
 * 工具注册表（PROTOCOL §9 / §10）。
 *
 *  - 每个工具声明完整 Tool Manifest：
 *      name / permission / description / handler(args, ctx)
 *      parameters (JSON Schema) / risk / side_effect / fs_scope /
 *      timeout_ms / confirmation / category
 *  - taskContext 决定暴露哪些工具域（read-only / project / full）
 *  - 不在白名单里的 tool.call → UNKNOWN_TOOL
 *  - 元工具 _meta.search_tools 在任意 taskContext 下都可用，供模型检索工具。
 *
 * 注意：handler 只做"真实执行"，不处理 dryRun / 权限；这些由 server 层统一拦截。
 */

const os = require('os');
const Protocol = require('../../shared/protocol');
const fsTools = require('../tools/filesystem');
const shellExec = require('../tools/shell/exec').exec;
const gitTools = require('../tools/git');

const { PERMISSION } = Protocol;

// taskContext → 工具白名单（PROTOCOL §9）。_meta.search_tools 永远 prepend，不写在这里。
const TASK_CONTEXT_TOOLS = Object.freeze({
  'read-only': [
    'filesystem.list',
    'filesystem.read',
    'filesystem.search',
    'git.status',
    'git.diff',
    'git.log',
  ],
  project: [
    'filesystem.list',
    'filesystem.read',
    'filesystem.search',
    'filesystem.write',
    'filesystem.mkdir',
    'shell.exec',
    'git.status',
    'git.diff',
    'git.log',
    'git.commit',
  ],
  // 第一阶段不真正开放 docker/adb；full 暂与 project 等价，预留扩展位
  full: [
    'filesystem.list',
    'filesystem.read',
    'filesystem.search',
    'filesystem.write',
    'filesystem.mkdir',
    'shell.exec',
    'git.status',
    'git.diff',
    'git.log',
    'git.commit',
  ],
});

// filesystem 工具统一的路径白名单（空数组/undefined 表示不限制）。
// 包含工程根、用户目录、系统临时目录——既约束范围，又保证现有测试写到 os.tmpdir() 不被拦。
const FS_SCOPE = Object.freeze([
  'D:\\DeepSeek Harness',
  'C:\\Users\\Admin',
  os.tmpdir(),
]);

const META_TOOL_NAME = '_meta.search_tools';

const RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);
const CONFIRM_MODES = Object.freeze(['never', 'once', 'always']);
const DEFAULT_TIMEOUT_MS = 30000;
const SHELL_DEFAULT_TIMEOUT_MS = 60000;
const SEARCH_TOOL_TIMEOUT_MS = 5000;

const TOOLS = new Map();

function register(def) {
  if (!def || typeof def.name !== 'string' || !def.name) {
    throw new Error('registry.register: def.name required');
  }
  if (typeof def.handler !== 'function') {
    throw new Error(`registry.register: ${def.name} handler must be a function`);
  }
  if (!Object.values(PERMISSION).includes(def.permission)) {
    throw new Error(`registry.register: ${def.name} invalid permission ${def.permission}`);
  }
  const risk = RISK_LEVELS.includes(def.risk) ? def.risk : 'medium';
  const confirmation = CONFIRM_MODES.includes(def.confirmation) ? def.confirmation : 'always';
  const timeoutMs = Number.isInteger(def.timeout_ms) && def.timeout_ms > 0
    ? def.timeout_ms
    : (def.name === 'shell.exec' ? SHELL_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const fsScope = Array.isArray(def.fs_scope) ? def.fs_scope.slice() : [];
  const parameters = def.parameters && typeof def.parameters === 'object'
    ? def.parameters
    : { type: 'object', properties: {} };

  TOOLS.set(def.name, {
    name: def.name,
    permission: def.permission,
    description: def.description || '',
    handler: def.handler,
    parameters,
    risk,
    side_effect: !!def.side_effect,
    fs_scope: fsScope,
    timeout_ms: timeoutMs,
    confirmation,
    category: def.category || '',
  });
}

// 把 TOOLS 里的完整 manifest 投影成对外暴露的形状（不含 handler）。
function toManifest(t) {
  return {
    name: t.name,
    permission: t.permission,
    description: t.description,
    parameters: t.parameters,
    risk: t.risk,
    side_effect: t.side_effect,
    fs_scope: t.fs_scope,
    timeout_ms: t.timeout_ms,
    confirmation: t.confirmation,
    category: t.category,
  };
}

// ---------- 元工具 _meta.search_tools 的 handler ----------
async function searchToolsHandler(args, ctx = {}) {
  if (!args || typeof args.query !== 'string' || !args.query) {
    const e = new Error('_meta.search_tools: args.query is required');
    e.toolError = 'INVALID_ARGUMENTS';
    throw e;
  }
  const taskContext = (ctx && ctx.taskContext) || 'project';
  const opts = {};
  if (typeof args.category === 'string' && args.category) opts.category = args.category;
  if (Number.isInteger(args.limit) && args.limit > 0) opts.limit = args.limit;
  return searchTools(args.query, taskContext, opts);
}

// ---------- 注册第一阶段工具集（完整 manifest） ----------
register({
  name: 'filesystem.list',
  permission: PERMISSION.READ,
  description: '列出目录内容或单个文件信息',
  handler: fsTools.list,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '要列出的目录或文件路径' } },
    required: ['path'],
  },
  risk: 'low',
  side_effect: false,
  fs_scope: FS_SCOPE.slice(),
  timeout_ms: DEFAULT_TIMEOUT_MS,
  confirmation: 'never',
  category: 'filesystem',
});

register({
  name: 'filesystem.read',
  permission: PERMISSION.READ,
  description: '读取文本文件内容（默认上限 1MB）',
  handler: fsTools.read,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '要读取的文件路径' } },
    required: ['path'],
  },
  risk: 'low',
  side_effect: false,
  fs_scope: FS_SCOPE.slice(),
  timeout_ms: DEFAULT_TIMEOUT_MS,
  confirmation: 'never',
  category: 'filesystem',
});

register({
  name: 'filesystem.search',
  permission: PERMISSION.READ,
  description: '在 root 下按文件名子串/glob 递归搜索',
  handler: fsTools.search,
  parameters: {
    type: 'object',
    properties: {
      root: { type: 'string', description: '搜索根目录' },
      query: { type: 'string', description: '文件名子串关键词' },
      glob: { type: 'string', description: '可选，极简 * 通配的文件名 glob' },
    },
    required: ['root', 'query'],
  },
  risk: 'low',
  side_effect: false,
  fs_scope: FS_SCOPE.slice(),
  timeout_ms: DEFAULT_TIMEOUT_MS,
  confirmation: 'never',
  category: 'filesystem',
});

register({
  name: 'filesystem.write',
  permission: PERMISSION.WRITE,
  description: '写入/追加文本文件',
  handler: fsTools.write,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      content: { type: 'string', description: '要写入的文本内容' },
      append: { type: 'boolean', description: '可选，true 表示追加而非覆盖' },
    },
    required: ['path', 'content'],
  },
  risk: 'medium',
  side_effect: true,
  fs_scope: FS_SCOPE.slice(),
  timeout_ms: DEFAULT_TIMEOUT_MS,
  confirmation: 'always',
  category: 'filesystem',
});

register({
  name: 'filesystem.mkdir',
  permission: PERMISSION.WRITE,
  description: '递归创建目录',
  handler: fsTools.mkdir,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '要创建的目录路径' } },
    required: ['path'],
  },
  risk: 'medium',
  side_effect: true,
  fs_scope: FS_SCOPE.slice(),
  timeout_ms: DEFAULT_TIMEOUT_MS,
  confirmation: 'always',
  category: 'filesystem',
});

register({
  name: 'shell.exec',
  permission: PERMISSION.EXECUTE,
  description: '执行 shell 命令（Windows=PowerShell），结构化返回',
  handler: shellExec,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      timeoutMs: { type: 'number', description: '可选，单次命令超时毫秒数' },
      cwd: { type: 'string', description: '可选，工作目录' },
    },
    required: ['command'],
  },
  risk: 'high',
  side_effect: true,
  fs_scope: [],
  timeout_ms: SHELL_DEFAULT_TIMEOUT_MS,
  confirmation: 'always',
  category: 'shell',
});

register({
  name: 'git.status',
  permission: PERMISSION.READ,
  description: 'git status',
  handler: gitTools.status,
  parameters: {
    type: 'object',
    properties: { cwd: { type: 'string', description: 'git 仓库目录' } },
    required: ['cwd'],
  },
  risk: 'low',
  side_effect: false,
  fs_scope: [],
  timeout_ms: DEFAULT_TIMEOUT_MS,
  confirmation: 'never',
  category: 'git',
});

register({
  name: 'git.diff',
  permission: PERMISSION.READ,
  description: 'git diff（可 staged）',
  handler: gitTools.diff,
  parameters: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'git 仓库目录' },
      staged: { type: 'boolean', description: '可选，true 表示 diff 暂存区' },
    },
    required: ['cwd'],
  },
  risk: 'low',
  side_effect: false,
  fs_scope: [],
  timeout_ms: DEFAULT_TIMEOUT_MS,
  confirmation: 'never',
  category: 'git',
});

register({
  name: 'git.log',
  permission: PERMISSION.READ,
  description: 'git log（最近 max 条）',
  handler: gitTools.log,
  parameters: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'git 仓库目录' },
      max: { type: 'number', description: '可选，返回条数，默认按工具内部默认' },
    },
    required: ['cwd'],
  },
  risk: 'low',
  side_effect: false,
  fs_scope: [],
  timeout_ms: DEFAULT_TIMEOUT_MS,
  confirmation: 'never',
  category: 'git',
});

register({
  name: 'git.commit',
  permission: PERMISSION.WRITE,
  description: 'git commit（可选 addAll）',
  handler: gitTools.commit,
  parameters: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'git 仓库目录' },
      message: { type: 'string', description: 'commit 信息' },
      addAll: { type: 'boolean', description: '可选，true 表示 git add -A 后再 commit' },
    },
    required: ['cwd', 'message'],
  },
  risk: 'medium',
  side_effect: true,
  fs_scope: [],
  timeout_ms: DEFAULT_TIMEOUT_MS,
  confirmation: 'always',
  category: 'git',
});

// ---------- 元工具：_meta.search_tools ----------
// permission=READ → 权限引擎 auto 放行；isAvailable 在任意 ctx 下都返回 true。
register({
  name: META_TOOL_NAME,
  permission: PERMISSION.READ,
  description: '按关键词检索当前可用工具，返回匹配工具的名称、描述和参数 schema。你不知道有哪些工具时，先用这个工具搜索。',
  handler: searchToolsHandler,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词，匹配工具名、描述、类别' },
      category: { type: 'string', description: '可选，按类别过滤' },
    },
    required: ['query'],
  },
  risk: 'low',
  side_effect: false,
  fs_scope: [],
  timeout_ms: SEARCH_TOOL_TIMEOUT_MS,
  confirmation: 'never',
  category: 'meta',
});

// ---------- taskContext 解析与可见性 ----------
function normalizeTaskContext(ctx) {
  if (ctx === 'read-only' || ctx === 'project' || ctx === 'full') return ctx;
  return 'project';
}

// listForContext 返回该 taskContext 下可用工具的完整 manifest（不含 handler）。
// _meta.search_tools 永远 prepend 到结果首位。
function listForContext(taskContext) {
  const ctx = normalizeTaskContext(taskContext);
  const allowed = TASK_CONTEXT_TOOLS[ctx];
  const list = allowed
    .filter((name) => TOOLS.has(name))
    .map((name) => toManifest(TOOLS.get(name)));
  const meta = TOOLS.get(META_TOOL_NAME);
  if (meta) list.unshift(toManifest(meta));
  return list;
}

function isAvailable(name, taskContext) {
  // 元工具在任意 taskContext 下都可用
  if (name === META_TOOL_NAME) return TOOLS.has(META_TOOL_NAME);
  const ctx = normalizeTaskContext(taskContext);
  return TASK_CONTEXT_TOOLS[ctx].includes(name) && TOOLS.has(name);
}

function get(name) {
  return TOOLS.get(name) || null;
}

/**
 * 在指定 taskContext 可用的工具里按关键词检索（不含元工具自身）。
 * @param {string} query 关键词
 * @param {string} taskContext 'read-only'|'project'|'full'
 * @param {{limit?:number, category?:string}} opts
 * @returns {{tools: Array<{name:string, description:string, parameters:object}>, total:number}}
 */
function searchTools(query, taskContext, opts = {}) {
  const ctx = normalizeTaskContext(taskContext);
  const rawLimit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 5;
  const limit = Math.min(rawLimit, 20);
  const category = opts.category;
  const queryStr = String(query || '').toLowerCase();
  const words = queryStr.split(/\s+/).filter(Boolean);

  // 可用工具集合（listForContext 已包含 _meta.search_tools，这里把它排除出结果）
  const candidates = listForContext(ctx).filter((t) => t.name !== META_TOOL_NAME);

  const scored = [];
  for (const t of candidates) {
    if (category && t.category !== category) continue;
    const haystack = `${t.name} ${t.description || ''} ${t.category || ''}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (w && haystack.includes(w)) score++;
    }
    // 整串命中额外加权
    if (queryStr && haystack.includes(queryStr)) score += 2;
    if (score > 0) scored.push({ t, score });
  }
  scored.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
  const top = scored.slice(0, limit);
  return {
    tools: top.map(({ t }) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    total: scored.length,
  };
}

module.exports = {
  register,
  get,
  listForContext,
  isAvailable,
  normalizeTaskContext,
  searchTools,
  TASK_CONTEXT_TOOLS,
  FS_SCOPE,
  META_TOOL_NAME,
  allNames: () => Array.from(TOOLS.keys()),
};
