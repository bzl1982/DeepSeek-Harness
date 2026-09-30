'use strict';
/**
 * tools/watchdog.js —— 测试台守护进程（用户要求"保证它一直在运行"）
 *
 * 机制：每 5 秒探测 127.0.0.1:9224；发现测试台不在 → 自动拉起（脱离父进程）。
 * 用途：窗口被误关 / 进程意外退出时，3~5 秒内自动恢复，用户不用再找启动器。
 *
 * 启动（脱离会话，断开也不影响）：
 *   cd meeting-lab
 *   nohup node tools/watchdog.js > _watchdog.log 2>&1 & disown
 * 停止：删除本脚本进程即可（taskkill /IM node.exe 会波及别的，建议按 _watchdog.log 里的 PID 停）。
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = 9224;
const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, '..', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
const LOCK = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'node_modules.lock');
const INTERVAL = 5000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(ROOT, '_watchdog.log'), line + '\n'); } catch (e) { /* 日志失败不阻断 */ }
}

/* ★ 尸检钩子：watchdog 自己崩了也要留下死因（2026-09-25：曾静默死亡导致 BAT"闪一下没影"无从排查） */
process.on('uncaughtException', (err) => {
  log('看门狗崩溃(uncaughtException)：' + (err && err.stack || err));
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log('看门狗异常(unhandledRejection)：' + (err && err.stack || err));
});
/* ★ 心跳：每 60s 写一条，日志里能看出 watchdog 是活着还是死了 */
setInterval(() => log('心跳：watchdog 存活，9224 探测中'), 60000);

function isUp() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT });
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(1500, () => done(false));
  });
}

async function launch() {
  try { fs.unlinkSync(LOCK); } catch (e) { /* 没有残锁也正常 */ }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // 宿主注入会让 electron 变纯 node → 必崩
  delete env.NODE_OPTIONS;
  env.CODEBUDDY_SAFE_DELETE_ENABLED = '0';
  const child = spawn(ELECTRON, ['.', '--no-sandbox', '--reuse-login', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  log(`测试台不在 → 已拉起（pid ${child.pid}）`);
}

(async () => {
  log('看门狗启动（每 5 秒探测一次）');
  let wasUp = true;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const up = await isUp();
    if (!up) {
      if (wasUp) log('检测到测试台已退出，正在自动恢复…');
      await launch();
      wasUp = true;
      await new Promise((r) => setTimeout(r, 12000)); // 给它启动时间
    } else {
      wasUp = true;
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
})();
