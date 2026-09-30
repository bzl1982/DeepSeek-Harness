'use strict';
// 会议窗口 preload：暴露 window.meetingBridge
// 注意：meeting 窗口为 sandbox:true，preload 只能用 contextBridge/ipcRenderer，
// 不能 require('fs') 等 Node 模块——文件写入统一交给主进程（ipcMain.handle）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetingBridge', {
  // renderer → main：打开独立浏览器窗口（完整浏览器功能）
  openBrowser: (providerId, url) => ipcRenderer.send('meeting:openBrowser', { providerId, url }),
  // main → renderer：关闭独立浏览器窗口后，刷新会议里对应的 webview
  onRefreshWebview: (cb) => {
    ipcRenderer.on('meeting:refreshWebview', (_e, providerId) => cb(providerId));
  },
  // renderer → main：拖拽期间让本窗口内所有 webview guest 鼠标事件穿透（setIgnoreMouseEvents）
  setGuestIgnore: (ignore) => ipcRenderer.send('meeting:set-ignore-mouse', !!ignore),
  // renderer → main：读取网页版智能体唯一配置源（命名/URL/partition/登录检测选择器）
  getAgents: () => ipcRenderer.invoke('catalog:get'),
  // renderer → main：上报某 webview 的登录状态与登录名；main → renderer：登录状态变化推送
  reportAuth: (payload) => ipcRenderer.send('auth:report', payload),
  getAuthState: () => ipcRenderer.invoke('auth:getState'),
  onAuthChanged: (cb) => {
    ipcRenderer.on('auth:changed', (_e, state) => cb(state));
  },
  // 把文本写成临时 .md 文件（主进程代写，返回绝对路径）
  writeTempMd: async (filename, content) => {
    return ipcRenderer.invoke('meeting:writeTempMd', filename, content);
  },
  // [P0] 把拖拽进来的真实文件落盘（主进程代写，带安全校验），返回 {ok, localPath, sha256}
  // bytes 用 ArrayBuffer（contextBridge 不允许传 Buffer，ArrayBuffer 是安全的结构化克隆类型）
  saveAttachment: async (sessionKey, name, bytes, size, mime) => {
    return ipcRenderer.invoke('meeting:saveAttachment', sessionKey, name, bytes, size, mime);
  },
});
