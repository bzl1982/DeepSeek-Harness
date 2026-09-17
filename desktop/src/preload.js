'use strict';
// Splash 页面桥：动画完成后通知主进程关闭启动页、显示主窗口
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('splashBridge', {
  done: function () { ipcRenderer.send('splash-done'); }
});
