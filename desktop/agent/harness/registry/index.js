'use strict';
/**
 * harness/registry/index.js
 * 工具注册表（PROTOCOL §9 / §10）。
 *
 *  - 每个工具声明：name / permission / description / handler(args, ctx)
 *  - taskContext 决定暴露哪些工具域（read-only / project / full）
 *  - 不在白名单里的 tool.call → UNKNOWN_TOOL
 *
 * 注意：handler 只做"真实执行"，不处理 dryRun / 权限；这些由 server 层统一拦截。
 */

const Protocol = require('../../shared/protocol');
const fsTools = require('../tools/filesystem');
const shellExec = require('../tools/shell/exec').exec;
const gitTools = require('../tools/git');

const { PERMISSION } = Protocol;

// taskContext → 工具白名单（PROTOCOL §9）
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
  TOOLS.set(def.name, {
    name: def.name,
    permission: def.permission,
    description: def.description || '',
    handler: def.handler,
  });
}

// ---- 注册第一阶段工具集 ----
register({ name: 'filesystem.list', permission: PERMISSION.READ, description: '列出目录内容或单个文件信息', handler: fsTools.list });
register({ name: 'filesystem.read', permission: PERMISSION.READ, description: '读取文本文件内容（默认上限 1MB）', handler: fsTools.read });
register({ name: 'filesystem.search', permission: PERMISSION.READ, description: '在 root 下按文件名子串/glob 递归搜索', handler: fsTools.search });
register({ name: 'filesystem.write', permission: PERMISSION.WRITE, description: '写入/追加文本文件', handler: fsTools.write });
register({ name: 'filesystem.mkdir', permission: PERMISSION.WRITE, description: '递归创建目录', handler: fsTools.mkdir });

register({ name: 'shell.exec', permission: PERMISSION.EXECUTE, description: '执行 shell 命令（Windows=PowerShell），结构化返回', handler: shellExec });

register({ name: 'git.status', permission: PERMISSION.READ, description: 'git status', handler: gitTools.status });
register({ name: 'git.diff', permission: PERMISSION.READ, description: 'git diff（可 staged）', handler: gitTools.diff });
register({ name: 'git.log', permission: PERMISSION.READ, description: 'git log（最近 max 条）', handler: gitTools.log });
register({ name: 'git.commit', permission: PERMISSION.WRITE, description: 'git commit（可选 addAll）', handler: gitTools.commit });

function normalizeTaskContext(ctx) {
  if (ctx === 'read-only' || ctx === 'project' || ctx === 'full') return ctx;
  return 'project';
}

function listForContext(taskContext) {
  const ctx = normalizeTaskContext(taskContext);
  const allowed = TASK_CONTEXT_TOOLS[ctx];
  return allowed
    .filter((name) => TOOLS.has(name))
    .map((name) => {
      const t = TOOLS.get(name);
      return { name: t.name, permission: t.permission, description: t.description };
    });
}

function isAvailable(name, taskContext) {
  const ctx = normalizeTaskContext(taskContext);
  return TASK_CONTEXT_TOOLS[ctx].includes(name) && TOOLS.has(name);
}

function get(name) {
  return TOOLS.get(name) || null;
}

module.exports = {
  register,
  get,
  listForContext,
  isAvailable,
  normalizeTaskContext,
  TASK_CONTEXT_TOOLS,
  allNames: () => Array.from(TOOLS.keys()),
};
