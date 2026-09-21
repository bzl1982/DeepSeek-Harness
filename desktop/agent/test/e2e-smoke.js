'use strict';
/**
 * test/e2e-smoke.js —— 编排者做的端到端契约冒烟（不依赖 Electron GUI）。
 * 模拟 Browser：spawn harness/server.js（带 AGENT_TOKEN）→ WS 带 ?token= 连接
 * → session.hello → filesystem.list(READ) → filesystem.write(dryRun) → 校验审计。
 * 运行：node test/e2e-smoke.js   （需 npm install 已装 ws）
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const Protocol = require('../shared/protocol');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = 'e2e-smoke-token-0001';
const PORT = 17455;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  // 1) 起 Harness
  const child = spawn(process.execPath, [path.join(ROOT, 'harness', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { AGENT_TOKEN: TOKEN, HARNESS_PORT: String(PORT), HARNESS_HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => process.stderr.write('[harness stderr] ' + b));

  // 等 AGENT_READY
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('harness timeout booting')), 8000);
    child.stdout.on('data', (b) => {
      if (String(b).includes('AGENT_READY')) { clearTimeout(to); resolve(); }
    });
  });
  console.log('[ok] harness booted on', PORT);

  // 2) WS 带 ?token= 连接（与 Browser 修复后一致）
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent?token=${encodeURIComponent(TOKEN)}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 5000);
  });
  console.log('[ok] ws connected with ?token= (wrong token would 401)');

  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    const r = pending.get(msg.requestId);
    if (r) { pending.delete(msg.requestId); r(msg); }
  });
  function sendExpect(envelope, expectType, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      pending.set(envelope.requestId, resolve);
      setTimeout(() => { if (pending.delete(envelope.requestId)) reject(new Error('timeout waiting ' + expectType)); }, timeoutMs);
      ws.send(JSON.stringify(envelope));
    });
  }

  // 3) session.hello
  const hello = Protocol.sessionHello({ provider: 'deepseek-web', dryRun: true, taskContext: 'project' });
  const ready = await sendExpect(hello, 'session.ready');
  const sessionId = ready.payload.sessionId;
  console.log('[ok] session.ready sessionId=%s tools=%d dryRun=%s', sessionId, ready.payload.availableTools.length, ready.payload.dryRun);
  if (!sessionId) throw new Error('no sessionId');
  if (!ready.payload.availableTools.includes('filesystem.list')) throw new Error('filesystem.list not in whitelist');

  // 4) filesystem.list (READ, auto)
  const listCall = Protocol.toolCall('filesystem.list', { path: ROOT }, Protocol.nextRequestId(), sessionId);
  const listResult = await sendExpect(listCall, 'tool.result');
  const entries = listResult.payload.result.entries || [];
  console.log('[ok] filesystem.list -> %d entries (has package.json=%s)', entries.length, entries.some(e => e.name === 'package.json'));
  if (listResult.payload.status !== 'success') throw new Error('list failed: ' + JSON.stringify(listResult.payload.error));
  if (!entries.some(e => e.name === 'package.json')) throw new Error('package.json not listed');

  // 5) filesystem.write (WRITE, dryRun 应 true，不真正落盘)
  const writeCall = Protocol.toolCall('filesystem.write', { path: path.join(ROOT, 'should-not-exist.txt'), content: 'x' }, Protocol.nextRequestId(), sessionId);
  const writeResult = await sendExpect(writeCall, 'tool.result');
  console.log('[ok] filesystem.write dryRun=%s -> %s', writeResult.payload.dryRun, writeResult.payload.result.content);
  if (writeResult.payload.dryRun !== true) throw new Error('expected dryRun true');
  if (fs.existsSync(path.join(ROOT, 'should-not-exist.txt'))) throw new Error('dryRun actually wrote file!');

  // 6) ping -> pong（type 必须是 pong，不是 tool.result）
  const ping = { protocol: Protocol.VERSION, type: 'ping', requestId: Protocol.nextRequestId(), sessionId, timestamp: Date.now(), payload: {} };
  const pingResp = await sendExpect(ping, 'pong');
  console.log('[ok] ping -> pong type=%s', pingResp.type);
  if (pingResp.type !== 'pong') throw new Error('expected pong type, got ' + pingResp.type);

  // 7) 审计日志校验
  await sleep(200);
  const auditFiles = fs.readdirSync(path.join(ROOT, 'harness', 'data')).filter(f => f.startsWith('audit-'));
  const lastAudit = auditFiles.sort().pop();
  const lines = fs.readFileSync(path.join(ROOT, 'harness', 'data', lastAudit), 'utf8').trim().split('\n').filter(Boolean);
  const tools = lines.map(l => JSON.parse(l).tool);
  console.log('[ok] audit %s has %d entries, tools=%s', lastAudit, lines.length, tools.join(','));

  ws.close();
  child.kill();
  console.log('\n=== E2E SMOKE PASSED ===');
  process.exit(0);
})().catch((e) => {
  console.error('E2E SMOKE FAILED:', e.message);
  try { child.kill(); } catch (_) {}
  process.exit(1);
});
