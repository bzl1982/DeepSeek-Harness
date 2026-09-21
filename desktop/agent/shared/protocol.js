'use strict';
/**
 * shared/protocol.js —— AI Agent Browser 冻结协议 v1.0 的纯 JS 实现。
 * 无任何外部依赖，Browser（Electron）与 Harness（Node）双方 require 同一份。
 * 唯一契约见 docs/PROTOCOL.md；本文件不得随意改字段，改前先改 PROTOCOL.md。
 */

const PROTOCOL_VERSION = 'agent-tool-v1';

const PERMISSION = Object.freeze({
  READ: 'READ',
  WRITE: 'WRITE',
  EXECUTE: 'EXECUTE',
  NETWORK: 'NETWORK',
  ADMIN: 'ADMIN',
});

const ERROR_CODES = Object.freeze([
  'BAD_ENVELOPE',
  'UNKNOWN_TOOL',
  'INVALID_ARGUMENTS',
  'PERMISSION_DENIED',
  'CONFIRMATION_REQUIRED',
  'CONFIRMATION_TIMEOUT',
  'TOOL_TIMEOUT',
  'TOOL_CRASHED',
  'TOOL_NOT_FOUND',
  'FILE_NOT_FOUND',
  'DRY_RUN',
  'INTERNAL_ERROR',
]);

const MESSAGE_TYPES = Object.freeze([
  'session.hello',
  'session.ready',
  'tool.call',
  'tool.result',
  'tool.progress',
  'confirmation.request',
  'confirmation.respond',
  'ping',
  'pong',
  'error',
]);

let _counter = 0;
function nextRequestId() {
  _counter = (_counter + 1) % 100000;
  return `req-${Date.now().toString(36)}-${_counter}-${Math.floor(Math.random() * 1e4).toString(36)}`;
}
function nextSessionId() {
  return `sess-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
function nextConfirmationId() {
  return `cf-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function baseEnvelope(type, requestId, sessionId, payload) {
  return {
    protocol: PROTOCOL_VERSION,
    type,
    requestId: requestId || nextRequestId(),
    sessionId: sessionId || '',
    timestamp: Date.now(),
    payload: payload || {},
  };
}

const Protocol = {
  VERSION: PROTOCOL_VERSION,
  PERMISSION,
  ERROR_CODES,
  MESSAGE_TYPES,
  nextRequestId,
  nextSessionId,
  nextConfirmationId,

  // ---- 构造 ----
  sessionHello(opts = {}) {
    return baseEnvelope('session.hello', opts.requestId, '', {
      provider: opts.provider || 'deepseek-web',
      userAgent: opts.userAgent || 'ai-agent-browser/0.1.0',
      dryRun: opts.dryRun !== false,
      taskContext: opts.taskContext || 'project',
    });
  },
  sessionReady(sessionId, payload = {}) {
    return baseEnvelope('session.ready', payload.requestId || nextRequestId(), sessionId, {
      sessionId,
      dryRun: payload.dryRun !== false,
      availableTools: payload.availableTools || [],
    });
  },
  toolCall(tool, args, requestId, sessionId) {
    return baseEnvelope('tool.call', requestId, sessionId, {
      tool,
      arguments: args || {},
    });
  },
  toolResult(requestId, sessionId, result, extra = {}) {
    return baseEnvelope('tool.result', requestId, sessionId, Object.assign({
      status: 'success',
      dryRun: false,
      durationMs: 0,
      result: result == null ? {} : result,
    }, extra));
  },
  toolError(requestId, sessionId, code, message, extra = {}) {
    if (!ERROR_CODES.includes(code)) code = 'INTERNAL_ERROR';
    return baseEnvelope('tool.result', requestId, sessionId, Object.assign({
      status: 'error',
      dryRun: false,
      durationMs: 0,
      error: { code, message: message || code },
    }, extra));
  },
  confirmationRequest(requestId, sessionId, info) {
    return baseEnvelope('confirmation.request', requestId, sessionId, {
      confirmationId: info.confirmationId || nextConfirmationId(),
      tool: info.tool,
      arguments: info.arguments || {},
      requiredPermission: info.requiredPermission || PERMISSION.WRITE,
      reason: info.reason || '',
      ttlMs: info.ttlMs || 60000,
    });
  },
  confirmationRespond(requestId, sessionId, confirmationId, decision, remember) {
    return baseEnvelope('confirmation.respond', requestId, sessionId, {
      confirmationId,
      decision: decision === 'approve' ? 'approve' : 'deny',
      remember: !!remember,
    });
  },
  progress(requestId, sessionId, stream, data, seq) {
    return baseEnvelope('tool.progress', requestId, sessionId, {
      stream: stream || 'stdout',
      data,
      seq: seq || 0,
    });
  },

  // ---- 校验：返回 {ok:true} 或 {ok:false, error} ----
  validateEnvelope(msg) {
    if (!msg || typeof msg !== 'object') return { ok: false, error: 'BAD_ENVELOPE: not an object' };
    if (msg.protocol !== PROTOCOL_VERSION) return { ok: false, error: `BAD_ENVELOPE: protocol != ${PROTOCOL_VERSION}` };
    if (!MESSAGE_TYPES.includes(msg.type)) return { ok: false, error: `BAD_ENVELOPE: unknown type ${msg.type}` };
    if (typeof msg.requestId !== 'string' || !msg.requestId) return { ok: false, error: 'BAD_ENVELOPE: missing requestId' };
    if (typeof msg.payload !== 'object' || msg.payload === null) return { ok: false, error: 'BAD_ENVELOPE: missing payload' };
    return { ok: true };
  },

  validateToolCall(payload) {
    if (!payload || typeof payload.tool !== 'string' || !payload.tool) {
      return { ok: false, error: 'INVALID_ARGUMENTS: payload.tool required' };
    }
    if (typeof payload.arguments !== 'object' || payload.arguments === null) {
      return { ok: false, error: 'INVALID_ARGUMENTS: payload.arguments must be object' };
    }
    return { ok: true };
  },

  // 解析 <agent>{...}</agent> 块；输入文本，返回 [{tool, arguments, raw, hash}]
  extractAgentBlocks(text) {
    if (typeof text !== 'string') return [];
    const re = /<agent>\s*([\s\S]*?)\s*<\/agent>/gi;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].trim();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (parsed && typeof parsed.tool === 'string' && typeof parsed.arguments === 'object') {
        let hash = 0;
        for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0;
        out.push({ tool: parsed.tool, arguments: parsed.arguments || {}, raw, hash: `h${hash}` });
      }
    }
    return out;
  },
};

module.exports = Protocol;
