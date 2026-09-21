'use strict';
/**
 * browser/session/harnessClient.js —— Browser 侧与本地 Harness 的 WebSocket 客户端。
 * 见 PROTOCOL.md §1/§2/§3。只连 127.0.0.1，带 X-Agent-Token。
 *
 * 事件（通过 .on(type, cb)）：
 *   'status'              -> {connected, sessionId, dryRun, availableTools}
 *   'tool.result'         -> envelope
 *   'tool.progress'        -> envelope
 *   'confirmation.request'-> envelope
 *   'session.ready'       -> payload
 *   'error'               -> Error
 */

const WebSocket = require('ws');
const Protocol = require('../../shared/protocol');

const DEFAULT_PORT = Number(process.env.HARNESS_PORT || 17321);

class HarnessClient {
  constructor(opts = {}) {
    this.port = opts.port || DEFAULT_PORT;
    this.token = opts.token || '';
    this.ws = null;
    this.sessionId = '';
    this.availableTools = [];
    this.dryRun = opts.dryRun !== false;
    this.provider = opts.provider || 'deepseek-web';
    this.taskContext = opts.taskContext || 'project';
    this.handlers = Object.create(null);
    this.connected = false;
    this._reconnectTimer = null;
    this._closing = false;
    this._pingTimer = null;
  }

  on(event, cb) {
    (this.handlers[event] = this.handlers[event] || []).push(cb);
    return this;
  }

  _emit(event, data) {
    const list = this.handlers[event];
    if (!list) return;
    for (const cb of list) {
      try { cb(data); } catch (e) { /* 不崩主流程 */ }
    }
  }

  connect() {
    this._closing = false;
    const url = `ws://127.0.0.1:${this.port}/agent?token=${encodeURIComponent(this.token)}`;
    let ws;
    try {
      ws = new WebSocket(url, {
        headers: { 'X-Agent-Token': this.token },
      });
    } catch (e) {
      this._emit('error', e);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this._broadcastStatus();
      // 连接成功立即握手
      this.hello();
      this._startPing();
    });

    ws.on('message', (raw) => this._onMessage(String(raw)));

    ws.on('close', () => {
      this.connected = false;
      this._stopPing();
      this._broadcastStatus();
      if (!this._closing) this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      this._emit('error', err);
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return; // 非法帧直接丢
    }
    const check = Protocol.validateEnvelope(msg);
    if (!check.ok) return; // BAD_ENVELOPE 静默丢弃

    switch (msg.type) {
      case 'session.ready': {
        this.sessionId = (msg.payload && msg.payload.sessionId) || this.sessionId;
        this.dryRun = !!(msg.payload && msg.payload.dryRun);
        this.availableTools = (msg.payload && msg.payload.availableTools) || [];
        this._emit('session.ready', msg.payload);
        this._broadcastStatus();
        break;
      }
      case 'tool.result':
        this._emit('tool.result', msg);
        break;
      case 'tool.progress':
        this._emit('tool.progress', msg);
        break;
      case 'confirmation.request':
        this._emit('confirmation.request', msg);
        break;
      case 'pong':
        break;
      case 'error':
        this._emit('error', new Error((msg.payload && msg.payload.message) || 'harness error'));
        break;
      default:
        break;
    }
  }

  _send(envelope) {
    if (!this.ws || this.connected !== true || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(envelope));
      return true;
    } catch (e) {
      return false;
    }
  }

  hello() {
    const env = Protocol.sessionHello({
      provider: this.provider,
      dryRun: this.dryRun,
      taskContext: this.taskContext,
    });
    env.sessionId = this.sessionId || '';
    return this._send(env);
  }

  /** 校验工具是否在白名单，不在则不发（Harness 会回 UNKNOWN_TOOL，这里做前置） */
  isToolAvailable(tool) {
    if (!this.availableTools || this.availableTools.length === 0) return true; // 未拉到清单时放行
    return this.availableTools.includes(tool);
  }

  sendToolCall(tool, args) {
    const env = Protocol.toolCall(tool, args, Protocol.nextRequestId(), this.sessionId);
    return { requestId: env.requestId, sent: this._send(env) };
  }

  respondConfirmation(requestId, confirmationId, decision, remember) {
    const env = Protocol.confirmationRespond(requestId, this.sessionId, confirmationId, decision, !!remember);
    return this._send(env);
  }

  setDryRun(dryRun) {
    this.dryRun = !!dryRun;
    this._broadcastStatus();
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this._send(Protocol.progress ? {
        protocol: Protocol.VERSION,
        type: 'ping',
        requestId: Protocol.nextRequestId(),
        sessionId: this.sessionId,
        timestamp: Date.now(),
        payload: {},
      } : null);
    }, 25000);
  }

  _stopPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closing) this.connect();
    }, 1500);
  }

  _broadcastStatus() {
    this._emit('status', {
      connected: this.connected,
      sessionId: this.sessionId,
      dryRun: this.dryRun,
      availableTools: this.availableTools,
    });
  }

  close() {
    this._closing = true;
    this._stopPing();
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
    }
    this.connected = false;
  }
}

module.exports = { HarnessClient, DEFAULT_PORT };
