'use strict';
/**
 * agent/main.js —— 智能体大脑运行时（被 desktop/src/main.js 集成）。
 *
 * 职责：
 *  1. 启动本地 Harness（内嵌于 Electron 主进程，监听 127.0.0.1:17321）；
 *  2. 维护 Provider 目录（内置 + 自定义，持久化到 userData/agent/providers.json）；
 *  3. 打开/切换智能体窗口（承载所选网页版 AI）；
 *  4. 串联：AI 页面检测 <agent> → IPC → tool.call → 执行 → 回注；
 *  5. 审计侧栏广播 + 原生确认框。
 *
 * 协议遵守 docs/PROTOCOL.md（agent-tool-v1）。
 */

const path = require('path');
const { app } = require('electron');

const { createHarnessServer, DEFAULT_PORT } = require('./harness/server/index.js');
const { HarnessClient } = require('./browser/session/harnessClient');
const { generateToken } = require('./browser/session/token');
const { registerIpc, handleConfirmationRequest } = require('./electron/ipc/handlers');
const { configureAgentSession } = require('./electron/main/session');
const { createAgentWindow } = require('./electron/main/window');
const { ProviderDirectory, safeProviderMeta } = require('./adapters/registry');
const { PageController } = require('./browser/page/controller');

/**
 * @param {object} opts
 *   - dataDir: 数据目录（userData/agent）——审计日志、token、providers.json
 *   - port:    Harness 端口（默认 17321）
 *   - token:   复用已有 token（可选）
 *   - onLog:   主进程侧日志回调（可选）
 * @returns {Promise<object>} runtime API
 */
async function createAgentRuntime(opts = {}) {
  const dataDir = opts.dataDir || path.join(app.getPath('userData'), 'agent');
  const port = Number(opts.port) || DEFAULT_PORT;
  const token = opts.token || generateToken();
  const log = opts.onLog || ((...a) => { /* noop */ });

  const providers = new ProviderDirectory(dataDir);
  await providers.load();

  // ---- Harness 内嵌启动（随客户端一起拉起）----
  const harnessServer = createHarnessServer({ port, token, dataDir });
  await harnessServer.start();
  log(`[agent] Harness 已启动 ws://127.0.0.1:${port}/agent`);

  // ---- Browser 侧客户端 ----
  const harnessClient = new HarnessClient({ port, token, dryRun: true });
  const pageController = new PageController();

  let agentWin = null;
  let currentProviderId = null;

  const broadcast = (channel, payload) => {
    if (agentWin && !agentWin.isDestroyed()) {
      agentWin.webContents.send(channel, payload);
    }
  };

  const recordAudit = (entry) => broadcast('audit:entry', entry);

  // Harness 事件 → 外壳 / 回注（沿用原独立程序逻辑）
  harnessClient.on('status', (s) => broadcast('harness:status', s));
  harnessClient.on('session.ready', (p) => {
    recordAudit({
      ts: new Date().toISOString(),
      requestId: null,
      tool: '(session)',
      arguments: p,
      permission: '-',
      confirmation: 'auto',
      dryRun: !!p.dryRun,
      resultStatus: 'success',
      errorCode: null,
      durationMs: 0,
      note: `会话就绪 sessionId=${p.sessionId}，可用工具 ${(p.availableTools || []).length} 个`,
    });

    // 会话就绪后，把工具清单+调用格式作为系统提示注入网页，让 AI 知道要输出 <agent> 块
    try {
      const tools = p.availableTools || [];
      const toolDesc = {
        'filesystem.list': '列出目录内容或单个文件信息',
        'filesystem.read': '读取文本文件内容',
        'filesystem.search': '按文件名子串搜索文件',
        'filesystem.write': '写入/追加文本文件',
        'filesystem.mkdir': '递归创建目录',
        'shell.exec': '执行 shell 命令（Windows=PowerShell）',
        'git.status': '查看 git 状态',
        'git.diff': '查看 git diff',
        'git.log': '查看 git 提交历史',
        'git.commit': '执行 git commit',
      };
      const toolLines = tools.map((t) => `- ${t}: ${toolDesc[t] || ''}`).join('\n');
      const sysPrompt = [
        '你现在是一个可以操作电脑的智能体助手。你可以调用以下工具来完成用户的任务：',
        '',
        '【可用工具】',
        toolLines,
        '',
        '【调用格式——必须严格遵守】',
        '当你需要调用工具时，在你的回复末尾输出一个完整的工具调用块，格式如下：',
        '',
        '<agent>',
        '{"tool":"filesystem.list","arguments":{"path":"C:\\\\Users"}}',
        '</agent>',
        '',
        '注意：',
        '1. 必须有 <agent> 和 </agent> 两个标签，缺一不可',
        '2. 两个标签之间是纯 JSON，不要有 markdown 代码块包裹',
        '3. 不要在 <agent> 块外面解释工具调用，直接在末尾输出块即可',
        '',
        '【工作方式】',
        '1. 用户给你任务，你分析需要哪些工具',
        '2. 在回复末尾输出 <agent>...</agent> 块调用工具',
        '3. 工具执行结果会作为下一条消息发回给你',
        '4. 根据结果继续工作，直到任务完成',
        '5. 最终用自然语言告诉用户结果',
        '',
        '现在请等待用户的指令。',
      ].join('\n');
      // 不立即发——等 webview attach 后（handlers.js shell:attachView）再发
      pageController._pendingSystemPrompt = sysPrompt;
    } catch (e) { /* ignore */ }
  });
  harnessClient.on('tool.result', (env) => {
    const payload = env.payload || {};
    recordAudit({
      ts: new Date().toISOString(),
      requestId: env.requestId,
      tool: payload.tool || '(result)',
      arguments: {},
      permission: '?',
      confirmation: 'auto',
      dryRun: !!payload.dryRun,
      resultStatus: payload.status === 'error' ? 'error' : 'success',
      errorCode: (payload.error && payload.error.code) || null,
      durationMs: payload.durationMs || 0,
      note: payload.status === 'error'
        ? `${(payload.error && payload.error.code) || ''} ${(payload.error && payload.error.message) || ''}`
        : (payload.dryRun ? 'Dry Run 完成' : '工具执行完成，结果已回注'),
    });
    // 闭环：Runtime → AI
    pageController.injectResult(env.requestId, { tool: '(result)' }, env);
  });
  harnessClient.on('tool.progress', (env) => {
    recordAudit({
      ts: new Date().toISOString(),
      requestId: env.requestId,
      tool: '(progress)',
      arguments: {},
      permission: '?',
      confirmation: 'auto',
      dryRun: false,
      resultStatus: 'pending',
      errorCode: null,
      durationMs: 0,
      note: (env.payload && env.payload.data) || '',
    });
  });
  harnessClient.on('confirmation.request', (env) => {
    handleConfirmationRequest(env, harnessClient).then((decision) => {
      recordAudit({
        ts: new Date().toISOString(),
        requestId: env.requestId,
        tool: (env.payload && env.payload.tool) || '(confirm)',
        arguments: (env.payload && env.payload.arguments) || {},
        permission: (env.payload && env.payload.requiredPermission) || '?',
        confirmation: decision === 'approve' ? 'approved' : 'denied',
        dryRun: false,
        resultStatus: 'pending',
        errorCode: null,
        durationMs: 0,
        note: `用户${decision === 'approve' ? '批准' : '拒绝'}了确认`,
      });
    });
  });
  harnessClient.on('error', (err) => {
    recordAudit({
      ts: new Date().toISOString(),
      requestId: null,
      tool: '(harness)',
      arguments: {},
      permission: '-',
      confirmation: 'auto',
      dryRun: false,
      resultStatus: 'error',
      errorCode: 'INTERNAL_ERROR',
      durationMs: 0,
      note: String(err && err.message),
    });
  });

  // ---- IPC（外壳 renderer 白名单；注册一次即可）----
  registerIpc({
    harnessClient,
    pageController,
    getShellWindow: () => agentWin,
    recordAudit,
    getProvider: (id) => {
      const p = providers.get(id);
      return p ? safeProviderMeta(p) : null;
    },
  });

  harnessClient.connect();

  // ---- 智能体窗口 ----
  function openAgentWindow(providerId) {
    const provider = providers.get(providerId) || providers.get('deepseek-web');
    if (!provider) return null;
    currentProviderId = provider.id;

    if (agentWin && !agentWin.isDestroyed()) {
      agentWin.show();
      agentWin.focus();
      // 切模型：让 renderer 重新加载对应 URL
      agentWin.webContents.send('agent:switch-provider', safeProviderMeta(provider));
      return agentWin;
    }

    agentWin = createAgentWindow({
      provider: safeProviderMeta(provider),
      dataDir,
    });
    agentWin.on('closed', () => {
      agentWin = null;
      currentProviderId = null;
    });
    return agentWin;
  }

  function closeAgentWindow() {
    if (agentWin && !agentWin.isDestroyed()) agentWin.close();
  }

  async function stop() {
    try { harnessClient.close(); } catch (e) { /* ignore */ }
    try { await harnessServer.stop(); } catch (e) { /* ignore */ }
  }

  return {
    providers,
    harnessServer,
    harnessClient,
    openAgentWindow,
    closeAgentWindow,
    stop,
    getProviderMeta: (id) => {
      const p = providers.get(id);
      return p ? safeProviderMeta(p) : null;
    },
    listProviderMeta: () => providers.list().map(safeProviderMeta),
    addProvider: (input) => providers.add(input),
    removeProvider: (id) => providers.remove(id),
    get token() { return token; },
    get port() { return port; },
    get currentProviderId() { return currentProviderId; },
  };
}

module.exports = { createAgentRuntime, DEFAULT_PORT };
