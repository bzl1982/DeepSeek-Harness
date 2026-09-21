'use strict';
/**
 * harness/adapters/platform.js
 * 平台适配器：把 AI 看到的统一工具签名（shell.exec / git.*）映射到本机实际命令。
 * AI 永远只看到 shell.exec，不知道底层是 PowerShell 还是 zsh/bash（PROTOCOL §0.4 / §10）。
 *
 * 纯同步、无外部依赖；仅用于构造 spawn 参数。
 */

const os = require('os');

const PLATFORM = (function detect() {
  const p = process.platform;
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'darwin';
  return 'linux';
})();

/**
 * 把一段 shell 命令行包装成 { file, args } 以便 child_process.spawn 使用。
 * 注意：Windows 下用 powershell.exe -NoProfile -Command "<cmd>"；
 *       类 Unix 下用 <shell> -lc "<cmd>"。
 * @param {string} command 用户/AI 给出的命令文本
 * @returns {{file:string, args:string[]}}
 */
function buildShellCommand(command) {
  if (typeof command !== 'string' || !command.trim()) {
    const err = new Error('command must be a non-empty string');
    err.code = 'INVALID_ARGUMENTS';
    throw err;
  }
  if (PLATFORM === 'windows') {
    // PowerShell -Command 接受单个字符串参数；用 -NoProfile 避免加载用户 profile 拖慢启动。
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] };
  }
  const shellBin = PLATFORM === 'darwin' ? 'zsh' : 'bash';
  return { file: shellBin, args: ['-lc', command] };
}

/**
 * 构造 git 子进程参数。git 可执行名在三平台都是 `git`（Windows 下通常是 git.exe，spawn 会自动找 PATHEXT）。
 * @param {string[]} gitArgs 传给 git 的参数（不含 git 本体）
 * @returns {{file:string, args:string[]}}
 */
function buildGitCommand(gitArgs) {
  if (!Array.isArray(gitArgs) || gitArgs.some((a) => typeof a !== 'string')) {
    const err = new Error('git args must be string[]');
    err.code = 'INVALID_ARGUMENTS';
    throw err;
  }
  return { file: 'git', args: gitArgs.slice() };
}

/**
 * 判断一个 spawn 错误是否为"可执行文件不存在"（ENOENT）。
 * 用于把 git 未安装映射为 TOOL_NOT_FOUND，而不是 INTERNAL_ERROR。
 */
function isExecutableNotFound(err) {
  if (!err) return false;
  if (err.code === 'ENOENT' || err.errno === -2 || err.errno === -4058) return true;
  // Windows 下有时 errno 是 ENOENT 的字符串
  if (typeof err.errno === 'string' && err.errno.toUpperCase() === 'ENOENT') return true;
  return false;
}

module.exports = {
  PLATFORM,
  homedir: os.homedir,
  tmpdir: os.tmpdir,
  buildShellCommand,
  buildGitCommand,
  isExecutableNotFound,
};
