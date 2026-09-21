'use strict';
/**
 * electron/main/window.js —— 创建智能体窗口（承载网页版 AI）。
 * 安全红线（PROTOCOL.md §0）：contextIsolation:true、nodeIntegration:false、
 * 不暴露 node；preload 只经 contextBridge 暴露白名单。
 *
 * 外壳里用 <webview> 承载真正的 AI 页面（所选 provider 的网页），
 * 因此外壳窗口需要 webviewTag:true；AI 页面本身用独立 preload + partition。
 */

const path = require('path');
const { BrowserWindow } = require('electron');

/**
 * @param {object} opts
 *   - provider: {id,name,url,loginUrl,loginMode,adapter,builtin}
 *   - dataDir:  数据目录（透传给外壳，用于显示/审计定位）
 */
function createAgentWindow(opts = {}) {
  const provider = opts.provider || {};
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: `智能体 · ${provider.name || '网页版 AI'}`,
    backgroundColor: '#0e1116',
    icon: path.join(__dirname, '..', '..', '..', 'build', 'icon.png'),
    webPreferences: {
      // 安全配置
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      // <webview> 自定义元素在 sandbox 渲染进程中不被注册（Electron 限制），
      // 必须关 sandbox，外壳自己仍靠 contextIsolation + 白名单 preload 守住安全红线。
      sandbox: false,
      // 外壳需要用 <webview> 承载 AI 页面
      webviewTag: true,
      // 外壳自己的 preload（暴露 window.shell 白名单）
      preload: path.join(__dirname, '..', '..', 'preload.js'),
    },
  });

  // 外链一律交给系统浏览器（智能体窗口只承载所选 provider 网页）
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) {
      const { shell } = require('electron');
      shell.openExternal(target);
    }
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, '..', '..', 'index.html'), {
    query: { provider: provider.id || 'deepseek-web' },
  });
  return win;
}

module.exports = { createAgentWindow };
