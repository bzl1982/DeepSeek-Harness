'use strict';
/**
 * harness/tools/git/index.js
 * git 工具实现（PROTOCOL §10.3）。
 *  - status / diff / log 为 READ；commit 为 WRITE。
 *  - git 未安装 → 统一 reject 一个带 toolError:'TOOL_NOT_FOUND' 的错误，上层转译。
 *  - 非零退出码（如不在 git 仓库里）不算协议错误，按工具返回结果（错误信息放到 result 里）。
 */

const { spawn } = require('child_process');
const platform = require('../../adapters/platform');

function throwToolError(code, message) {
  const e = new Error(message);
  e.toolError = code;
  throw e;
}

/**
 * 通用 git 调用。
 * @param {string[]} gitArgs
 * @param {{cwd?:string}} args
 * @returns {Promise<{code:number, stdout:string, stderr:string, notFound:boolean}>}
 */
function runGit(gitArgs, args = {}) {
  return new Promise((resolve, reject) => {
    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
    const { file, args: spawnArgs } = platform.buildGitCommand(gitArgs);
    let child;
    try {
      child = spawn(file, spawnArgs, { cwd, windowsHide: true });
    } catch (e) {
      if (platform.isExecutableNotFound(e)) {
        return reject(Object.assign(new Error('git executable not found'), { toolError: 'TOOL_NOT_FOUND' }));
      }
      return reject(Object.assign(new Error(`spawn failed: ${e.message}`), { toolError: 'INTERNAL_ERROR' }));
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (platform.isExecutableNotFound(e)) {
        return reject(Object.assign(new Error('git executable not found'), { toolError: 'TOOL_NOT_FOUND' }));
      }
      reject(Object.assign(new Error(`git error: ${e.message}`), { toolError: 'INTERNAL_ERROR' }));
    });
    child.on('close', (code) => {
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

// ---------- git.status ----------
async function status(args) {
  if (!args || typeof args.cwd !== 'string' || !args.cwd) {
    throwToolError('INVALID_ARGUMENTS', 'git.status: args.cwd is required');
  }
  const r = await runGit(['status', '--porcelain=v1', '--branch'], args);
  if (r.code !== 0) {
    return { branch: null, clean: false, changes: [], error: r.stderr.trim() || r.stdout.trim() };
  }
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  let branch = null;
  const changes = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      branch = line.slice(3).split('...')[0].trim();
    } else {
      changes.push(line);
    }
  }
  return { branch, clean: changes.length === 0, changes };
}

// ---------- git.diff ----------
async function diff(args) {
  if (!args || typeof args.cwd !== 'string' || !args.cwd) {
    throwToolError('INVALID_ARGUMENTS', 'git.diff: args.cwd is required');
  }
  const gitArgs = ['diff'];
  if (args.staged) gitArgs.push('--cached');
  const r = await runGit(gitArgs, args);
  if (r.code !== 0) {
    return { patch: '', error: r.stderr.trim() || r.stdout.trim() };
  }
  return { patch: r.stdout };
}

// ---------- git.log ----------
async function log(args) {
  if (!args || typeof args.cwd !== 'string' || !args.cwd) {
    throwToolError('INVALID_ARGUMENTS', 'git.log: args.cwd is required');
  }
  const max = Number.isInteger(args.max) && args.max > 0 ? Math.min(args.max, 50) : 10;
  // 用 NUL 分隔字段，避免 commit message 里的换行干扰解析
  const fmt = ['%H', '%s', '%an', '%at'].join('%x00');
  const r = await runGit(['log', `-n${max}`, `--pretty=format:${fmt}`], args);
  if (r.code !== 0) {
    return { commits: [], error: r.stderr.trim() || r.stdout.trim() };
  }
  const commits = r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, msg, author, at] = line.split('\x00');
    return { hash: (hash || '').slice(0, 12), msg: msg || '', author: author || '', time: Number(at) || 0 };
  });
  return { commits };
}

// ---------- git.commit ----------
async function commit(args) {
  if (!args || typeof args.cwd !== 'string' || !args.cwd) {
    throwToolError('INVALID_ARGUMENTS', 'git.commit: args.cwd is required');
  }
  if (typeof args.message !== 'string' || !args.message.trim()) {
    throwToolError('INVALID_ARGUMENTS', 'git.commit: args.message is required');
  }
  if (args.addAll) {
    const add = await runGit(['add', '-A'], args);
    if (add.code !== 0) {
      return { committed: false, error: add.stderr.trim() || add.stdout.trim() };
    }
  }
  const r = await runGit(['commit', '-m', args.message], args);
  if (r.code !== 0) {
    return { committed: false, error: r.stderr.trim() || r.stdout.trim() };
  }
  // 取短 hash
  const h = await runGit(['rev-parse', '--short', 'HEAD'], args);
  return { committed: true, hash: h.stdout.trim() || null };
}

module.exports = {
  status,
  diff,
  log,
  commit,
  runGit,
};
