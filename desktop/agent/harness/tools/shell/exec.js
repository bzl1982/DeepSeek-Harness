'use strict';
/**
 * harness/tools/shell/exec.js
 * shell.exec 结构化执行（PROTOCOL §10.2）。
 *
 * 硬要求：
 *  - timeoutMs 默认 30000，最大 120000；超时杀子进程，timedOut:true、exitCode:null。
 *  - 非零退出码 ≠ 协议错误：handler 正常 resolve，由 AI 自己看 exitCode/stderr 判断。
 *  - 进程起不来（ENOENT 等）才 reject，由上层转成 tool.result status:error。
 *  - Windows 走 powershell.exe -NoProfile -Command；其他走 zsh/bash（platform adapter）。
 *
 * 返回（resolve 值）：{ exitCode, stdout, stderr, durationMs, timedOut }
 */

const { spawn } = require('child_process');
const platform = require('../../adapters/platform');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const MAX_BUFFER = 2 * 1024 * 1024; // 2MB 输出上限，避免吞爆内存

function throwToolError(code, message) {
  const e = new Error(message);
  e.toolError = code;
  throw e;
}

/**
 * @param {{command:string, timeoutMs?:number, cwd?:string}} args
 */
async function exec(args) {
  if (!args || typeof args.command !== 'string' || !args.command.trim()) {
    throwToolError('INVALID_ARGUMENTS', 'shell.exec: args.command is required and must be non-empty');
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (Number.isInteger(args.timeoutMs) && args.timeoutMs > 0) {
    timeoutMs = Math.min(args.timeoutMs, MAX_TIMEOUT_MS);
  }

  const { file, args: spawnArgs } = platform.buildShellCommand(args.command);
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(file, spawnArgs, { cwd, windowsHide: true });
    } catch (e) {
      if (platform.isExecutableNotFound(e)) {
        return reject(Object.assign(new Error(`shell executable not found: ${file}`), { toolError: 'TOOL_NOT_FOUND' }));
      }
      return reject(Object.assign(new Error(`spawn failed: ${e.message}`), { toolError: 'INTERNAL_ERROR' }));
    }

    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Windows 下 shell 可能是 powershell.exe，杀整棵进程树更稳妥
        child.kill();
        if (platform.PLATFORM === 'windows') {
          try { child.kill('SIGKILL'); } catch (_) {}
        }
      } catch (_) {}
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (stdoutLen < MAX_BUFFER) {
        stdoutChunks.push(d);
        stdoutLen += d.length;
      }
    });
    child.stderr.on('data', (d) => {
      if (stderrLen < MAX_BUFFER) {
        stderrChunks.push(d);
        stderrLen += d.length;
      }
    });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (platform.isExecutableNotFound(e)) {
        return reject(Object.assign(new Error(`shell executable not found: ${file}`), { toolError: 'TOOL_NOT_FOUND' }));
      }
      reject(Object.assign(new Error(`child error: ${e.message}`), { toolError: 'INTERNAL_ERROR' }));
    });

    child.on('close', (code /*, signal */) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      resolve({
        exitCode: timedOut ? null : code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        durationMs,
        timedOut,
      });
    });
  });
}

module.exports = {
  exec,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
};
