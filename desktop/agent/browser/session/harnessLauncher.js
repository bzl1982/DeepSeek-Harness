'use strict';
/**
 * browser/session/harnessLauncher.js —— 启动本地 Harness 子进程。
 * 见 PROTOCOL.md §1：Browser 用 child_process 拉起 node harness/server.js，
 * 通过环境变量把随机 token / 端口交给 Harness。
 *
 * 即使 Harness 尚未就绪（比如还在另一个 Agent 手里实现），这里也不能把整个
 * Browser 拖崩：spawn 失败/退出只记录日志，后续由 HarnessClient 自动重连。
 */

const { spawn } = require('child_process');
const path = require('path');

function launchHarness({ token, port, projectRoot }) {
  const cwd = projectRoot || process.cwd();
  const entry = path.join(cwd, 'harness', 'server.js');

  let child = null;
  try {
    child = spawn(process.execPath, [entry], {
      cwd,
      env: Object.assign({}, process.env, {
        AGENT_TOKEN: token,
        HARNESS_PORT: String(port),
        // 强制只监听回环
        HARNESS_HOST: '127.0.0.1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { child: null, error: e };
  }

  child.stdout.on('data', (b) => {
    // 调试用；不解析，连接端口固定 17321
    process.stdout.write('[harness] ' + b.toString());
  });
  child.stderr.on('data', (b) => {
    process.stderr.write('[harness] ' + b.toString());
  });
  child.on('error', (err) => {
    process.stderr.write('[harness] failed to start: ' + err.message + '\n');
  });
  child.on('exit', (code) => {
    process.stderr.write(`[harness] exited code=${code}\n`);
  });

  return { child, error: null };
}

module.exports = { launchHarness };
