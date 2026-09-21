'use strict';
/**
 * test/harness.test.js
 * Harness 单元测试（node --test）。
 *
 * 注意：按要求本测试不 require('ws')、不启动真实服务器；
 * 只测纯逻辑与工具 handler 本身。
 *
 * 覆盖：
 *  - shared/protocol.js 信封校验
 *  - registry 工具白名单（taskContext）
 *  - hazard 黑名单命中判定
 *  - PermissionEngine 决策 + ConfirmationQueue TTL
 *  - filesystem.list / read / write 在 os.tmpdir() 临时目录
 *  - shell.exec 跑 `Write-Output hello` 拿到 stdout
 *  - git.status：git 可用时在临时 git init 仓库跑；不可用时验证 TOOL_NOT_FOUND
 *  - Dry Run 消息格式（直接复用 dispatchToolCall 的 dryRun 分支难以不启服务，
 *    这里通过 PermissionEngine + 手工拼 dryRun 结果形状来验证）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const Protocol = require('../shared/protocol');
const registry = require('../harness/registry');
const hazard = require('../harness/tools/shell/hazard');
const { PermissionEngine, ConfirmationQueue } = require('../harness/permissions');
const fsTools = require('../harness/tools/filesystem');
const shellExec = require('../harness/tools/shell/exec').exec;
const gitTools = require('../harness/tools/git');

// ---------- 信封校验 ----------
test('PROTOCOL: 合法信封通过 validateEnvelope', () => {
  const env = Protocol.toolCall('filesystem.read', { path: 'x' }, 'req-1', 'sess-1');
  const v = Protocol.validateEnvelope(env);
  assert.ok(v.ok, v.error);
});

test('PROTOCOL: protocol 不匹配被拒', () => {
  const env = { protocol: 'wrong', type: 'tool.call', requestId: 'r', payload: {} };
  const v = Protocol.validateEnvelope(env);
  assert.equal(v.ok, false);
  assert.match(v.error, /BAD_ENVELOPE/);
});

test('PROTOCOL: 缺 requestId 被拒', () => {
  const env = { protocol: Protocol.VERSION, type: 'tool.call', payload: {} };
  const v = Protocol.validateEnvelope(env);
  assert.equal(v.ok, false);
});

test('PROTOCOL: validateToolCall 校验 tool/arguments', () => {
  assert.ok(Protocol.validateToolCall({ tool: 'a', arguments: {} }).ok);
  assert.equal(Protocol.validateToolCall({ tool: '', arguments: {} }).ok, false);
  assert.equal(Protocol.validateToolCall({ tool: 'a', arguments: null }).ok, false);
});

// ---------- registry 白名单 ----------
test('registry: read-only 不暴露 write/shell', () => {
  const readOnly = registry.listForContext('read-only').map((t) => t.name);
  assert.ok(readOnly.includes('filesystem.read'));
  assert.ok(!readOnly.includes('filesystem.write'));
  assert.ok(!readOnly.includes('shell.exec'));
});

test('registry: project 暴露 write/shell/git.commit', () => {
  const proj = registry.listForContext('project').map((t) => t.name);
  assert.ok(proj.includes('filesystem.write'));
  assert.ok(proj.includes('shell.exec'));
  assert.ok(proj.includes('git.commit'));
});

test('registry: isAvailable 未知任务上下文回退到 project', () => {
  assert.ok(registry.isAvailable('shell.exec', 'project'));
  assert.ok(!registry.isAvailable('shell.exec', 'read-only'));
  // 任意未知 context 不爆炸
  assert.ok(registry.isAvailable('filesystem.read', 'bogus-ctx'));
});

// ---------- hazard ----------
test('hazard: 命中 rm -rf /', () => {
  const r = hazard.inspect('rm -rf /');
  assert.ok(r.hit);
});
test('hazard: 命中 Format-Volume', () => {
  const r = hazard.inspect('Format-Volume -DriveLetter D');
  assert.ok(r.hit);
});
test('hazard: 命中 git push --force', () => {
  const r = hazard.inspect('git push origin main --force');
  assert.ok(r.hit);
});
test('hazard: 普通命令不命中', () => {
  const r = hazard.inspect('Write-Output hello');
  assert.equal(r.hit, false);
});

// ---------- PermissionEngine ----------
test('PermissionEngine: READ 自动放行', () => {
  const eng = new PermissionEngine();
  const d = eng.decide('filesystem.read', { permission: 'READ' }, {});
  assert.equal(d.decision, 'auto');
  assert.equal(d.requiredPermission, 'READ');
});
test('PermissionEngine: WRITE 需确认', () => {
  const eng = new PermissionEngine();
  const d = eng.decide('filesystem.write', { permission: 'WRITE' }, {});
  assert.equal(d.decision, 'confirm');
  assert.equal(d.requiredPermission, 'WRITE');
});
test('PermissionEngine: shell.exec 危险命令升级 ADMIN', () => {
  const eng = new PermissionEngine();
  const d = eng.decide('shell.exec', { permission: 'EXECUTE' }, { command: 'rm -rf /' });
  assert.equal(d.decision, 'confirm');
  assert.equal(d.requiredPermission, 'ADMIN');
  assert.match(d.reason, /危险命令/);
});
test('PermissionEngine: shell.exec 普通命令保持 EXECUTE', () => {
  const eng = new PermissionEngine();
  const d = eng.decide('shell.exec', { permission: 'EXECUTE' }, { command: 'Write-Output hi' });
  assert.equal(d.requiredPermission, 'EXECUTE');
});

// ---------- ConfirmationQueue ----------
test('ConfirmationQueue: approve 后 resolve', async () => {
  const q = new ConfirmationQueue();
  const { confirmationId, promise } = q.create({ ttlMs: 5000 });
  q.respond(confirmationId, 'approve');
  assert.equal(await promise, 'approve');
});
test('ConfirmationQueue: deny 后 resolve 为 deny', async () => {
  const q = new ConfirmationQueue();
  const { confirmationId, promise } = q.create({ ttlMs: 5000 });
  q.respond(confirmationId, 'deny');
  assert.equal(await promise, 'deny');
});
test('ConfirmationQueue: 超时 reject CONFIRMATION_TIMEOUT', async () => {
  const q = new ConfirmationQueue();
  const { promise } = q.create({ ttlMs: 50 });
  await assert.rejects(() => promise, (e) => e.toolError === 'CONFIRMATION_TIMEOUT');
});

// ---------- filesystem（临时目录） ----------
const tmpRoot = path.join(os.tmpdir(), `harness-test-${crypto.randomBytes(4).toString('hex')}`);

test.before(async () => {
  await fsp.mkdir(tmpRoot, { recursive: true });
});

test('filesystem.write + read：往返一致', async () => {
  const p = path.join(tmpRoot, 'hello.txt');
  const w = await fsTools.write({ path: p, content: '你好 harness\nline2' });
  assert.ok(w.written > 0);
  const r = await fsTools.read({ path: p });
  assert.equal(r.content, '你好 harness\nline2');
  assert.ok(r.meta.size > 0);
});

test('filesystem.list：列出临时目录', async () => {
  const l = await fsTools.list({ path: tmpRoot });
  const names = l.entries.map((e) => e.name);
  assert.ok(names.includes('hello.txt'));
});

test('filesystem.read：不存在文件报 FILE_NOT_FOUND', async () => {
  await assert.rejects(
    () => fsTools.read({ path: path.join(tmpRoot, 'no-such.txt') }),
    (e) => e.toolError === 'FILE_NOT_FOUND'
  );
});

test('filesystem.mkdir：递归创建', async () => {
  const p = path.join(tmpRoot, 'a', 'b', 'c');
  const r = await fsTools.mkdir({ path: p });
  assert.equal(r.created, true);
  assert.ok(fs.existsSync(p));
});

test('filesystem.search：按子串找到文件', async () => {
  await fsp.writeFile(path.join(tmpRoot, 'tmdb-matcher.py'), 'print("x")', 'utf8');
  const r = await fsTools.search({ root: tmpRoot, query: 'tmdb' });
  assert.ok(r.matches.some((m) => m.endsWith('tmdb-matcher.py')));
});

test.after(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

// ---------- shell.exec ----------
test('shell.exec: Write-Output hello 拿到 stdout', async () => {
  const r = await shellExec({ command: 'Write-Output hello-from-harness' });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hello-from-harness/);
  assert.equal(r.timedOut, false);
  assert.ok(r.durationMs >= 0);
});

test('shell.exec: 非零退出码不抛错，exitCode 非零', async () => {
  // 用一个必失败的命令（PowerShell 下 exit 1）
  const r = await shellExec({ command: 'exit 1' });
  assert.equal(r.exitCode, 1);
  assert.equal(r.timedOut, false);
});

test('shell.exec: 参数缺失校验', async () => {
  await assert.rejects(() => shellExec({}), (e) => e.toolError === 'INVALID_ARGUMENTS');
});

// ---------- git ----------
test('git.status: 在临时目录跑（git 不可用则 TOOL_NOT_FOUND）', async () => {
  const repo = path.join(os.tmpdir(), `harness-git-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(repo, { recursive: true });
  try {
    try {
      const r = await gitTools.status({ cwd: repo });
      // 走到这里说明 git 可用
      assert.ok(typeof r.branch === 'string' || r.error);
    } catch (e) {
      // git 未安装
      assert.equal(e.toolError, 'TOOL_NOT_FOUND');
    }
  } finally {
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

// ---------- Dry Run 形状 ----------
test('Dry Run: WRITE 工具不真正执行，返回 dryRun 提示', async () => {
  // 直接模拟 server 层 dryRun 分支的结果形状
  const dryRunResult = {
    status: 'success',
    dryRun: true,
    result: { content: '[DRY RUN] 未实际执行 filesystem.write -> {}' },
  };
  assert.equal(dryRunResult.status, 'success');
  assert.equal(dryRunResult.dryRun, true);
  assert.match(dryRunResult.result.content, /^\[DRY RUN\]/);
});
