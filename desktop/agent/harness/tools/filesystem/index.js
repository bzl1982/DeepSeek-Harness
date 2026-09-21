'use strict';
/**
 * harness/tools/filesystem/index.js
 * filesystem 工具实现（PROTOCOL §10.1）。
 * 第一阶段只实现 list / read / search / write / mkdir；不实现 delete / move。
 *
 * 所有 handler 签名：handler(args, ctx) -> Promise<resultObject>
 *   args 来自 tool.call.payload.arguments
 *   ctx 目前未直接使用（dryRun 由上层 server 统一拦截，handler 只做真实执行）
 *
 * 错误约定：文件不存在抛 FILE_NOT_FOUND；参数错抛 INVALID_ARGUMENTS；
 *           其他统一包成 INTERNAL_ERROR（上层转译）。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function throwToolError(code, message) {
  const e = new Error(message);
  e.toolError = code;
  throw e;
}

// ---------- filesystem.list ----------
async function list(args) {
  if (!args || typeof args.path !== 'string' || !args.path) {
    throwToolError('INVALID_ARGUMENTS', 'filesystem.list: args.path is required');
  }
  const target = path.resolve(args.path);
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch (e) {
    if (e.code === 'ENOENT') throwToolError('FILE_NOT_FOUND', `path not found: ${target}`);
    throwToolError('INTERNAL_ERROR', `stat failed: ${e.message}`);
  }
  if (!stat.isDirectory()) {
    // 单个文件也返回一条 entry，方便 AI 判断
    return {
      entries: [{ name: path.basename(target), type: 'file', size: stat.size, mtime: stat.mtimeMs }],
    };
  }
  const names = await fsp.readdir(target);
  const entries = [];
  for (const name of names) {
    const full = path.join(target, name);
    try {
      const s = await fsp.stat(full);
      entries.push({
        name,
        type: s.isDirectory() ? 'dir' : 'file',
        size: s.size,
        mtime: s.mtimeMs,
      });
    } catch (e) {
      // 权限不足等情况跳过，不让单条失败拖垮整个 list
      entries.push({ name, type: 'unknown', size: 0, mtime: 0 });
    }
  }
  return { entries };
}

// ---------- filesystem.read ----------
async function read(args) {
  if (!args || typeof args.path !== 'string' || !args.path) {
    throwToolError('INVALID_ARGUMENTS', 'filesystem.read: args.path is required');
  }
  const target = path.resolve(args.path);
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch (e) {
    if (e.code === 'ENOENT') throwToolError('FILE_NOT_FOUND', `file not found: ${target}`);
    throwToolError('INTERNAL_ERROR', `stat failed: ${e.message}`);
  }
  if (!stat.isFile()) throwToolError('INVALID_ARGUMENTS', `not a file: ${target}`);

  const maxBytes = Number.isInteger(args.maxBytes) && args.maxBytes > 0 ? args.maxBytes : 1024 * 1024; // 默认 1MB
  const fd = await fsp.open(target, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fd.read(buf, 0, maxBytes, 0);
    const content = buf.slice(0, bytesRead).toString('utf8');
    return {
      content,
      meta: { size: stat.size, mtime: stat.mtimeMs, truncated: bytesRead < stat.size },
    };
  } finally {
    await fd.close();
  }
}

// ---------- filesystem.search ----------
// 第一阶段：递归按文件名子串/glob 匹配，深度有限，避免全盘扫描卡死。
// glob 暂用极简 * 通配（其他通配符按字面处理）；query 为子串匹配。
function globToRegex(glob) {
  if (typeof glob !== 'string') return null;
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

async function search(args) {
  if (!args || typeof args.root !== 'string' || !args.root) {
    throwToolError('INVALID_ARGUMENTS', 'filesystem.search: args.root is required');
  }
  if (typeof args.query !== 'string' || !args.query) {
    throwToolError('INVALID_ARGUMENTS', 'filesystem.search: args.query is required');
  }
  const root = path.resolve(args.root);
  let rootStat;
  try {
    rootStat = await fsp.stat(root);
  } catch (e) {
    if (e.code === 'ENOENT') throwToolError('FILE_NOT_FOUND', `root not found: ${root}`);
    throwToolError('INTERNAL_ERROR', `stat failed: ${e.message}`);
  }
  if (!rootStat.isDirectory()) throwToolError('INVALID_ARGUMENTS', `root is not a directory: ${root}`);

  const re = globToRegex(args.glob);
  const q = args.query.toLowerCase();
  const matches = [];
  const MAX_MATCHES = 200;
  const MAX_DEPTH = 6;

  async function walk(dir, depth) {
    if (matches.length >= MAX_MATCHES || depth > MAX_DEPTH) return;
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (e) {
      return; // 无权限/被占用，跳过
    }
    for (const name of names) {
      if (matches.length >= MAX_MATCHES) return;
      if (name === 'node_modules' || name === '.git' || name === 'AppData') continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = await fsp.stat(full);
      } catch (e) {
        continue;
      }
      const nameMatches = name.toLowerCase().includes(q);
      const globMatches = re ? re.test(name) : false;
      if (st.isFile() && (nameMatches || globMatches)) {
        matches.push(full);
      }
      if (st.isDirectory()) {
        if (nameMatches || globMatches) matches.push(full);
        await walk(full, depth + 1);
      }
    }
  }
  await walk(root, 0);
  return { matches, truncated: matches.length >= MAX_MATCHES };
}

// ---------- filesystem.write ----------
async function write(args) {
  if (!args || typeof args.path !== 'string' || !args.path) {
    throwToolError('INVALID_ARGUMENTS', 'filesystem.write: args.path is required');
  }
  if (typeof args.content !== 'string') {
    throwToolError('INVALID_ARGUMENTS', 'filesystem.write: args.content must be string');
  }
  const target = path.resolve(args.path);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const flag = args.append ? 'a' : 'w';
  await fsp.writeFile(target, args.content, { encoding: 'utf8', flag });
  return { written: Buffer.byteLength(args.content, 'utf8'), path: target };
}

// ---------- filesystem.mkdir ----------
async function mkdir(args) {
  if (!args || typeof args.path !== 'string' || !args.path) {
    throwToolError('INVALID_ARGUMENTS', 'filesystem.mkdir: args.path is required');
  }
  const target = path.resolve(args.path);
  await fsp.mkdir(target, { recursive: true });
  return { created: true, path: target };
}

module.exports = {
  list,
  read,
  search,
  write,
  mkdir,
};
