'use strict';
// 会议窗口 preload：暴露 window.meetingBridge
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetingBridge', {
  // renderer → main：打开独立浏览器窗口（完整浏览器功能）
  openBrowser: (providerId, url) => ipcRenderer.send('meeting:openBrowser', { providerId, url }),
  // main → renderer：关闭独立浏览器窗口后，刷新会议里对应的 webview
  onRefreshWebview: (cb) => {
    ipcRenderer.on('meeting:refreshWebview', (_e, providerId) => cb(providerId));
  },
});
