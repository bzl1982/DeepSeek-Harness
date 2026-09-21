'use strict';
/**
 * harness/server/index.js
 * Harness HTTP + WebSocket 服务器（PROTOCOL §1）。
 *
 *  - 只监听 127.0.0.1；端口默认 17321，可用 HARNESS_PORT 覆盖。
 *  - 鉴权：HTTP 头 X-Agent-Token；WS 查询参数 ?token=...（浏览器 WebSocket 不能自定义头）。
 *  - token 由启动方生成并打印到 stdout，同时落 harness/data/token。
 *  - 共用 dispatchToolCall：HTTP 与 WS 都走同一套权限/确认/dryRun/审计逻辑。
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const Protocol = require('../../shared/protocol');
const registry = require('../registry');
const { PermissionEngine, ConfirmationQueue } = require('../permissions');
const { AuditLog, DATA_DIR, tsIso } = require('../audit');

const DEFAULT_PORT = 17321;
const HOST = '127.0.0.1';
const CONFIRMATION_TTL_MS = 60000;

// ---------- SessionManager ----------
class SessionManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.sessions = new Map();
  }
  create({ provider, dryRun, taskContext }) {
    const sessionId = Protocol.nextSessionId();
    const normalized = registry.normalizeTaskContext(taskContext);
    const sess = {
      sessionId,
      provider: provider || 'deepseek-web',
      dryRun: dryRun !== false, // 默认 true
      taskContext: normalized,
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, sess);
    return sess;
  }
  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }
  list() {
    return Array.from(this.sessions.values());
  }
}

// ---------- 工具错误归一化 ----------
function normalizeToolError(e) {
  if (!e) return { code: 'INTERNAL_ERROR', message: 'unknown error' };
  if (e.toolError && Protocol.ERROR_CODES.includes(e.toolError)) {
    return { code: e.toolError, message: e.message || e.toolError };
  }
  // 常见 Node 错误映射
  if (e.code === 'ENOENT') return { code: 'FILE_NOT_FOUND', message: e.message };
  if (e.code === 'EACCES' || e.code === 'EPERM') return { code: 'PERMISSION_DENIED', message: e.message };
  return { code: 'INTERNAL_ERROR', message: e.message || 'internal error' };
}

// ---------- 构造服务器 ----------
function createHarnessServer(opts = {}) {
  const port = Number(opts.port) || Number(process.env.HARNESS_PORT) || DEFAULT_PORT;
  const token = opts.token || process.env.AGENT_TOKEN || crypto.randomBytes(16).toString('hex');
  const sessionMgr = new SessionManager();
  const permEngine = new PermissionEngine();
  const confirmationQueue = new ConfirmationQueue();
    // [dsh-desktop 嵌入] dataDir 可覆盖（桌面版写用户数据目录）；start()/token 文件也走同一目录
  const dataDir = opts.dataDir || DATA_DIR;
  const auditLog = new AuditLog(dataDir);

  // ---- dispatch：核心工具执行流程 ----
  // channel: 'http' | 'ws'；wsSink: 当 channel='ws' 时用于发 confirmation.request 的函数(ws, envelope)
  async function dispatchToolCall(envelope, session, channel, wsSink) {
    const startedAt = Date.now();
    const requestId = envelope.requestId;
    const sessionId = session.sessionId;
    const provider = session.provider;

    // 1) 校验 tool.call payload
    const v = Protocol.validateToolCall(envelope.payload);
    if (!v.ok) {
      return Protocol.toolError(requestId, sessionId, 'INVALID_ARGUMENTS', v.error);
    }
    const toolName = envelope.payload.tool;
    const args = envelope.payload.arguments || {};

    // 2) 白名单
    if (!registry.isAvailable(toolName, session.taskContext)) {
      return Protocol.toolError(requestId, sessionId, 'UNKNOWN_TOOL', `tool not available in taskContext=${session.taskContext}: ${toolName}`);
    }
    const toolDef = registry.get(toolName);

    // 3) 权限决策
    const decision = permEngine.decide(toolName, toolDef, args);

    // 4) Dry Run：WRITE/EXECUTE/ADMIN 不真正执行；READ 正常跑
    if (session.dryRun && decision.requiredPermission !== 'READ') {
      const durationMs = Date.now() - startedAt;
      const result = {
        content: `[DRY RUN] 未实际执行 ${toolName} -> ${JSON.stringify(args)}`,
      };
      await auditLog.append({
        sessionId, provider, requestId, tool: toolName, arguments: args,
        requiredPermission: decision.requiredPermission, confirmation: 'auto',
        dryRun: true, resultStatus: 'success', errorCode: null, durationMs,
      });
      return Protocol.toolResult(requestId, sessionId, result, { dryRun: true, durationMs });
    }

    // 5) 无需确认（READ）→ 直接执行
    if (decision.decision === 'auto') {
      return executeAndAudit(toolName, args, { requestId, sessionId, provider, requiredPermission: decision.requiredPermission, startedAt, confirmation: 'auto' });
    }

    // 6) 需要确认
    if (decision.decision === 'confirm') {
      // HTTP 同步通道无法弹原生 UI → 直接回 CONFIRMATION_REQUIRED，让 Browser 走 WS
      if (channel === 'http') {
        const durationMs = Date.now() - startedAt;
        await auditLog.append({
          sessionId, provider, requestId, tool: toolName, arguments: args,
          requiredPermission: decision.requiredPermission, confirmation: 'denied',
          dryRun: false, resultStatus: 'error', errorCode: 'CONFIRMATION_REQUIRED', durationMs,
        });
        return Protocol.toolError(requestId, sessionId, 'CONFIRMATION_REQUIRED', `tool ${toolName} 需要用户确认，请通过 WebSocket 通道发起`, { durationMs });
      }

      // WS：发 confirmation.request，等待用户决策
      const cf = confirmationQueue.create({
        tool: toolName,
        arguments: args,
        requiredPermission: decision.requiredPermission,
        reason: decision.reason,
        ttlMs: CONFIRMATION_TTL_MS,
      });
      const cfRequest = Protocol.confirmationRequest(requestId, sessionId, {
        confirmationId: cf.confirmationId,
        tool: toolName,
        arguments: args,
        requiredPermission: decision.requiredPermission,
        reason: decision.reason,
        ttlMs: CONFIRMATION_TTL_MS,
      });
      wsSink(cfRequest);

      let decision2;
      try {
        decision2 = await cf.promise;
      } catch (e) {
        const durationMs = Date.now() - startedAt;
        await auditLog.append({
          sessionId, provider, requestId, tool: toolName, arguments: args,
          requiredPermission: decision.requiredPermission, confirmation: 'timeout',
          dryRun: false, resultStatus: 'error', errorCode: 'CONFIRMATION_TIMEOUT', durationMs,
        });
        return Protocol.toolError(requestId, sessionId, 'CONFIRMATION_TIMEOUT', `确认超时（TTL=${CONFIRMATION_TTL_MS}ms）`, { durationMs });
      }

      if (decision2 !== 'approve') {
        const durationMs = Date.now() - startedAt;
        await auditLog.append({
          sessionId, provider, requestId, tool: toolName, arguments: args,
          requiredPermission: decision.requiredPermission, confirmation: 'denied',
          dryRun: false, resultStatus: 'error', errorCode: 'PERMISSION_DENIED', durationMs,
        });
        return Protocol.toolError(requestId, sessionId, 'PERMISSION_DENIED', `用户拒绝了 ${toolName} 的执行确认`, { durationMs });
      }

      return executeAndAudit(toolName, args, {
        requestId, sessionId, provider, requiredPermission: decision.requiredPermission,
        startedAt, confirmation: 'approved',
      });
    }

    // decision === 'deny'
    const durationMs = Date.now() - startedAt;
    await auditLog.append({
      sessionId, provider, requestId, tool: toolName, arguments: args,
      requiredPermission: decision.requiredPermission, confirmation: 'denied',
      dryRun: false, resultStatus: 'error', errorCode: 'PERMISSION_DENIED', durationMs,
    });
    return Protocol.toolError(requestId, sessionId, 'PERMISSION_DENIED', decision.reason || '权限不足', { durationMs });
  }

  async function executeAndAudit(toolName, args, meta) {
    const startedAt = meta.startedAt;
    try {
      const toolDef = registry.get(toolName);
      const result = await toolDef.handler(args, {
        sessionId: meta.sessionId,
        provider: meta.provider,
      });
      const durationMs = Date.now() - startedAt;
      await auditLog.append({
        sessionId: meta.sessionId, provider: meta.provider, requestId: meta.requestId,
        tool: toolName, arguments: args, requiredPermission: meta.requiredPermission,
        confirmation: meta.confirmation, dryRun: false, resultStatus: 'success',
        errorCode: null, durationMs,
      });
      return Protocol.toolResult(meta.requestId, meta.sessionId, result, { durationMs });
    } catch (e) {
      const durationMs = Date.now() - startedAt;
      const ne = normalizeToolError(e);
      await auditLog.append({
        sessionId: meta.sessionId, provider: meta.provider, requestId: meta.requestId,
        tool: toolName, arguments: args, requiredPermission: meta.requiredPermission,
        confirmation: meta.confirmation, dryRun: false, resultStatus: 'error',
        errorCode: ne.code, durationMs,
      });
      return Protocol.toolError(meta.requestId, meta.sessionId, ne.code, ne.message, { durationMs });
    }
  }

  // ---- HTTP 工具 ----
  function requireAuth(req) {
    const got = req.headers['x-agent-token'];
    return got === token;
  }

  function sendJson(res, statusCode, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (d) => {
        size += d.length;
        if (size > 1024 * 1024) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(d);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('invalid json'));
        }
      });
      req.on('error', reject);
    });
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = u.pathname;

      // 健康检查不要求 token（方便排障），但只在回环
      if (req.method === 'GET' && pathname === '/agent/health') {
        return sendJson(res, 200, {
          ok: true,
          version: Protocol.VERSION,
          dryRun: true, // 第一阶段默认 dryRun
          time: tsIso(),
        });
      }

      if (!requireAuth(req)) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized', message: 'X-Agent-Token mismatch' });
      }

      if (req.method === 'GET' && pathname === '/agent/tools') {
        const sessionId = u.searchParams.get('sessionId') || '';
        const sess = sessionMgr.get(sessionId);
        const taskContext = sess ? sess.taskContext : 'project';
        return sendJson(res, 200, {
          ok: true,
          taskContext,
          tools: registry.listForContext(taskContext),
        });
      }

      if (req.method === 'POST' && pathname === '/agent/session') {
        const body = await readBody(req);
        const sess = sessionMgr.create({
          provider: body.provider,
          dryRun: body.dryRun,
          taskContext: body.taskContext,
        });
        return sendJson(res, 200, {
          ok: true,
          type: 'session.ready',
          sessionId: sess.sessionId,
          dryRun: sess.dryRun,
          taskContext: sess.taskContext,
          provider: sess.provider,
          availableTools: registry.listForContext(sess.taskContext).map((t) => t.name),
        });
      }

      if (req.method === 'POST' && pathname === '/agent/tool') {
        const envelope = await readBody(req);
        const v = Protocol.validateEnvelope(envelope);
        if (!v.ok) return sendJson(res, 400, Protocol.toolError(envelope.requestId || '', envelope.sessionId || '', 'BAD_ENVELOPE', v.error));
        if (envelope.type !== 'tool.call') {
          return sendJson(res, 400, Protocol.toolError(envelope.requestId, envelope.sessionId || '', 'BAD_ENVELOPE', `expected tool.call, got ${envelope.type}`));
        }
        const sess = sessionMgr.get(envelope.sessionId);
        if (!sess) {
          return sendJson(res, 400, Protocol.toolError(envelope.requestId, envelope.sessionId || '', 'BAD_ENVELOPE', 'unknown sessionId, POST /agent/session first'));
        }
        const result = await dispatchToolCall(envelope, sess, 'http', null);
        return sendJson(res, 200, result);
      }

      if (req.method === 'GET' && pathname === '/agent/audit') {
        const sessionId = u.searchParams.get('sessionId') || '';
        const entries = await auditLog.readBySession(sessionId);
        return sendJson(res, 200, { ok: true, count: entries.length, entries });
      }

      return sendJson(res, 404, { ok: false, error: 'not_found', path: pathname });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: 'internal_error', message: e.message });
    }
  });

  // ---- WebSocket ----
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (u.pathname !== '/agent') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const got = u.searchParams.get('token');
    if (got !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.sendJson = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    ws.on('message', async (raw) => {
      let envelope;
      try {
        envelope = JSON.parse(raw.toString('utf8'));
      } catch (e) {
        return ws.sendJson(Protocol.toolError('', '', 'BAD_ENVELOPE', 'message must be JSON'));
      }
      const v = Protocol.validateEnvelope(envelope);
      if (!v.ok) {
        return ws.sendJson(Protocol.toolError(envelope.requestId || '', envelope.sessionId || '', 'BAD_ENVELOPE', v.error));
      }

      try {
        switch (envelope.type) {
          case 'session.hello': {
            const p = envelope.payload || {};
            const sess = sessionMgr.create({
              provider: p.provider,
              dryRun: p.dryRun,
              taskContext: p.taskContext,
            });
            const ready = Protocol.sessionReady(sess.sessionId, {
              requestId: envelope.requestId,
              dryRun: sess.dryRun,
              availableTools: registry.listForContext(sess.taskContext).map((t) => t.name),
            });
            return ws.sendJson(ready);
          }

          case 'tool.call': {
            const sess = sessionMgr.get(envelope.sessionId);
            if (!sess) {
              return ws.sendJson(Protocol.toolError(envelope.requestId, envelope.sessionId || '', 'BAD_ENVELOPE', 'unknown sessionId'));
            }
            const result = await dispatchToolCall(envelope, sess, 'ws', (cfEnvelope) => ws.sendJson(cfEnvelope));
            return ws.sendJson(result);
          }

          case 'confirmation.respond': {
            const p = envelope.payload || {};
            const ok = confirmationQueue.respond(p.confirmationId, p.decision);
            return ws.sendJson(Protocol.toolResult(envelope.requestId, envelope.sessionId, {
              received: true,
              matched: ok,
            }));
          }

          case 'ping': {
            return ws.sendJson({
              protocol: Protocol.VERSION,
              type: 'pong',
              requestId: envelope.requestId,
              sessionId: envelope.sessionId,
              timestamp: Date.now(),
              payload: { pong: true },
            });
          }

          default:
            return ws.sendJson(Protocol.toolError(envelope.requestId, envelope.sessionId || '', 'BAD_ENVELOPE', `unhandled type ${envelope.type}`));
        }
      } catch (e) {
        return ws.sendJson(Protocol.toolError(envelope.requestId || '', envelope.sessionId || '', 'INTERNAL_ERROR', e.message));
      }
    });
  });

  async function start() {
    await fsp.mkdir(dataDir, { recursive: true });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, HOST, () => resolve());
    });
    // 写 token 文件
    const tokenFile = path.join(dataDir, 'token');
    await fsp.writeFile(tokenFile, token + '\n', 'utf8');
    return { port, host: HOST, token };
  }

  async function stop() {
    await new Promise((resolve) => {
      wss.close(() => {
        httpServer.close(() => resolve());
      });
    });
  }

  return {
    start,
    stop,
    httpServer,
    wss,
    token,
    sessionMgr,
    auditLog,
    dispatchToolCall,
  };
}

module.exports = {
  createHarnessServer,
  DEFAULT_PORT,
  HOST,
  CONFIRMATION_TTL_MS,
};
