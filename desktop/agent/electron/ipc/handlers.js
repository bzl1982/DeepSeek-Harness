'use strict';
/**
 * electron/ipc/handlers.js —— IPC handler 白名单。
 * 只登记下列通道，其余一律不响应。通道分两类：
 *   来自 AI 页面 preload（webview）：agent:detected
 *   来自外壳 renderer（index.html）：shell.*
 *
 * deps: { harnessClient, pageController, getShellWindow, audit }
 *   audit 由调用方提供一个 push(entry) 回调，并把事件广播到外壳。
 */

const { ipcMain, dialog } = require('electron');
const { AgentParser } = require('../../agent/parser');
const navigation = require('../../browser/navigation');

const parser = new AgentParser();

function registerIpc(deps) {
  const { harnessClient, pageController, getShellWindow, recordAudit, getProvider } = deps;

  const shell = () => (typeof getShellWindow === 'function' ? getShellWindow() : null);

  // ---- 外壳 renderer → 主进程：查询 provider 元数据 ----
  if (typeof getProvider === 'function') {
    ipcMain.handle('shell:getProvider', (_event, id) => getProvider(id));
  }

  // ---- 外壳 renderer → 主进程：主动查询当前 Harness 连接状态 ----
  ipcMain.handle('shell:getStatus', () => ({
    connected: harnessClient.connected,
    sessionId: harnessClient.sessionId,
    dryRun: harnessClient.dryRun,
    availableTools: harnessClient.availableTools,
  }));
  const broadcast = (channel, payload) => {
    const win = shell();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // ---- AI 页面 → 主进程：检测到 <agent> 块 ----
  ipcMain.on('agent:detected', (_event, payload) => {
    if (!payload || typeof payload.tool !== 'string') return;

    // 主进程侧再做一次去重（双保险）
    if (parser.has(payload.hash)) return;
    parser.mark(payload.hash);

    // 白名单前置校验
    if (!harnessClient.isToolAvailable(payload.tool)) {
      recordAudit({
        ts: new Date().toISOString(),
        requestId: null,
        tool: payload.tool,
        arguments: payload.arguments,
        permission: '?',
        confirmation: 'auto',
        dryRun: harnessClient.dryRun,
        resultStatus: 'error',
        errorCode: 'UNKNOWN_TOOL',
        durationMs: 0,
        note: '不在 availableTools 白名单',
      });
      return;
    }

    const startedAt = Date.now();
    const { requestId, sent } = harnessClient.sendToolCall(payload.tool, payload.arguments || {});

    if (sent) {
      pageController.notifyDispatched(requestId, payload.tool);
    }
    recordAudit({
      ts: new Date().toISOString(),
      requestId,
      tool: payload.tool,
      arguments: payload.arguments,
      permission: '?',
      confirmation: 'auto',
      dryRun: harnessClient.dryRun,
      resultStatus: 'pending',
      errorCode: null,
      durationMs: Date.now() - startedAt,
      note: sent ? '已发送 tool.call' : 'Harness 未连接，未发送',
    });
  });

  // ---- 外壳 renderer → 主进程：上报 webview 的 webContentsId ----
  ipcMain.on('shell:attachView', (_event, wcId) => {
    if (typeof wcId === 'number') {
      pageController.attach(wcId);
      // webview 就绪后，如果有待发的系统提示（session.ready 时存的），现在发
      if (pageController._pendingSystemPrompt) {
        // 等 1s 让网页 DOM 稳定后再注入
        setTimeout(() => {
          pageController.sendSystemPrompt(pageController._pendingSystemPrompt);
          pageController._pendingSystemPrompt = null;
        }, 1000);
      }
    }
  });

  // ---- 外壳 renderer → 主进程：Dry Run 开关 ----
  ipcMain.on('shell:setDryRun', (_event, dryRun) => {
    harnessClient.setDryRun(!!dryRun);
    // 重新握手让 Harness 落定 dryRun
    harnessClient.hello();
    broadcast('harness:status', {
      connected: harnessClient.connected,
      sessionId: harnessClient.sessionId,
      dryRun: harnessClient.dryRun,
      availableTools: harnessClient.availableTools,
    });
  });

  // ---- 外壳 renderer → 主进程：DevTools 开关（AI 页面）----
  ipcMain.on('shell:toggleDevTools', () => {
    const wc = pageController.getWebContents();
    if (wc) {
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: 'detach' });
    }
  });

  // ---- 外壳 renderer → 主进程：导航（兜底，通常 renderer 直接操作 webview）----
  ipcMain.handle('shell:navBack', () => navigation.goBack(pageController.getWebContents()));
  ipcMain.handle('shell:navForward', () => navigation.goForward(pageController.getWebContents()));
  ipcMain.handle('shell:navReload', () => navigation.reload(pageController.getWebContents()));
  ipcMain.handle('shell:navStop', () => navigation.stop(pageController.getWebContents()));

  return { broadcast };
}

/**
 * 处理 Harness 推来的 confirmation.request：弹原生 dialog（绝不是网页 confirm）。
 * 超时按 deny。
 */
async function handleConfirmationRequest(env, harnessClient) {
  const p = env.payload || {};
  const ttlMs = Number(p.ttlMs) || 60000;

  const buttonsPromise = dialog.showMessageBox({
    type: 'warning',
    title: 'Agent 工具确认',
    message: `工具需要 ${p.requiredPermission || ''} 权限`,
    detail:
      `工具：${p.tool}\n` +
      `原因：${p.reason || '(无)'}\n` +
      `参数：${JSON.stringify(p.arguments || {}, null, 2)}\n\n` +
      `是否允许执行？`,
    buttons: ['允许', '拒绝'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });

  // 超时：视为 deny
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), ttlMs);
  });

  const result = await Promise.race([buttonsPromise, timeoutPromise]);
  clearTimeout(timer);

  let decision = 'deny';
  if (result && !result.timeout && result.response === 0) decision = 'approve';

  harnessClient.respondConfirmation(env.requestId, p.confirmationId, decision, false);
  return decision;
}

module.exports = { registerIpc, handleConfirmationRequest };
