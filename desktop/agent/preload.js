'use strict';
/**
 * preload.js —— 智能体窗口外壳（index.html）的预加载脚本。
 * 通过 contextBridge 只暴露白名单 window.shell（PROTOCOL.md §0/§11 安全红线）：
 * 绝不暴露 require / process / child_process / fs / 原始 ipcRenderer.send。
 *
 * AI 页面（webview）的 window.agent 由 browser/page/agentPreload.js 单独注入。
 * [dsh-desktop 嵌入] 新增：当前 provider 查询 / 主进程切模型事件 / 打开登录页。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  // renderer → main：上报 webview 的 webContentsId
  attachView: (wcId) => ipcRenderer.send('shell:attachView', wcId),

  // renderer → main：Dry Run 开关
  setDryRun: (dryRun) => ipcRenderer.send('shell:setDryRun', !!dryRun),

  // renderer → main：DevTools 开关
  toggleDevTools: () => ipcRenderer.send('shell:toggleDevTools'),

  // renderer → main：导航（renderer 通常直接操作 webview，这里是兜底通道）
  navBack: () => ipcRenderer.invoke('shell:navBack'),
  navForward: () => ipcRenderer.invoke('shell:navForward'),
  navReload: () => ipcRenderer.invoke('shell:navReload'),
  navStop: () => ipcRenderer.invoke('shell:navStop'),

  // renderer → main：查询当前/指定 provider 元数据
  getProvider: (id) => ipcRenderer.invoke('shell:getProvider', id),

  // renderer → main：主动查询当前 Harness 连接状态（窗口打开时拉一次，避免错过早期广播）
  getStatus: () => ipcRenderer.invoke('shell:getStatus'),

  // main → renderer：Harness 连接/会话状态
  onStatus: (cb) => {
    ipcRenderer.on('harness:status', (_e, data) => cb(data));
  },

  // main → renderer：审计侧栏条目
  onAudit: (cb) => {
    ipcRenderer.on('audit:entry', (_e, entry) => cb(entry));
  },

  // main → renderer：主进程要求切换模型（重新加载 webview）
  onSwitchProvider: (cb) => {
    ipcRenderer.on('agent:switch-provider', (_e, provider) => cb(provider));
  },
});
