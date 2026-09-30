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

  // renderer → main：设置页「打开并登录」按钮触发，按 providerId 打开同分区登录窗口（补 Bug3）
  openLogin: (providerId) => ipcRenderer.send('meeting:openLogin', providerId),

  // renderer → main：读取全部 provider（内置 + 自定义）
  listProviders: () => ipcRenderer.invoke('agent:listProviders'),

  // renderer → main：读取网页版智能体唯一配置源（命名/URL/partition，三处界面共用）
  getCatalog: () => ipcRenderer.invoke('catalog:get'),

  // renderer → main：读取登录状态快照；main → renderer：登录状态变化推送
  getAuthState: () => ipcRenderer.invoke('auth:getState'),
  onAuthChanged: (cb) => {
    ipcRenderer.on('auth:changed', (_e, state) => cb(state));
  },
  // renderer → main：dump 模型面板真实 DOM 结构（调试用，主进程写日志文件）
  dumpDom: (data) => ipcRenderer.send('model-ui:dump', data),

  // renderer → main：上报某网页版智能体的登录状态（设置页面按钮文本判定）
  reportAuth: (payload) => ipcRenderer.send('auth:report', payload),

  // renderer → main：新增自定义网页模型 {name,url}
  addProvider: (input) => ipcRenderer.invoke('agent:addProvider', input),

  // renderer → main：删除自定义网页模型
  removeProvider: (id) => ipcRenderer.invoke('agent:removeProvider', id),

  // main → renderer：智能体状态事件（如窗口已打开）
  onEvent: (cb) => {
    ipcRenderer.on('agent:event', (_e, data) => cb(data));
  },
});

// [窗口图标] 皮肤跟随：dsh 的「字体颜色」选择（蓝/黑）存在 localStorage('dsh-desktop-skin')，
// 主进程要知道它才能切换窗口图标（蓝鲸/黑鲸）。这里只做**低频轮询 + 变化上报**：
// 不碰 DOM、不加 MutationObserver、不改任何样式，避免历史上前端全局注入带来的副作用。
// 仅对主界面（http + 38123）生效，防止 splash 页（file://）误报默认值引起图标抖动。
(function watchDesktopSkin() {
  try {
    if (location.protocol !== 'http:' || location.port !== '38123') return;
  } catch (e) { return; }
  let last = null;
  function tick() {
    let skin = 'blue';
    try { skin = localStorage.getItem('dsh-desktop-skin') || 'blue'; } catch (e) { /* 忽略 */ }
    if (skin !== last) {
      last = skin;
      try { ipcRenderer.send('skin:changed', skin); } catch (e) { /* 忽略 */ }
    }
  }
  tick();
  setInterval(tick, 1000);
})();
