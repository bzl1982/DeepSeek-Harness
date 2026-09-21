'use strict';
// Splash 页面桥：动画完成后通知主进程关闭启动页、显示主窗口
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('splashBridge', {
  done: function () { ipcRenderer.send('splash-done'); }
});

// [dsh-desktop 嵌入] 主窗口（dsh Web UI）的智能体桥：
// 模型选择器 / 设置-模型 里的「网页版智能体」通过 window.dshAgent 与主进程通信。
// 只暴露白名单：打开智能体窗口 / 读取 provider 列表 / 增删自定义模型 / 订阅事件。
contextBridge.exposeInMainWorld('dshAgent', {
  // renderer → main：打开/切换智能体窗口（指定 provider id）
  openAgent: (providerId) => ipcRenderer.send('agent:open', providerId),

  // renderer → main：打开 AI 会议窗口
  openMeeting: () => ipcRenderer.send('meeting:open'),

  // renderer → main：读取全部 provider（内置 + 自定义）
  listProviders: () => ipcRenderer.invoke('agent:listProviders'),

  // renderer → main：新增自定义网页模型 {name,url}
  addProvider: (input) => ipcRenderer.invoke('agent:addProvider', input),

  // renderer → main：删除自定义网页模型
  removeProvider: (id) => ipcRenderer.invoke('agent:removeProvider', id),

  // main → renderer：智能体状态事件（如窗口已打开）
  onEvent: (cb) => {
    ipcRenderer.on('agent:event', (_e, data) => cb(data));
  },
});
