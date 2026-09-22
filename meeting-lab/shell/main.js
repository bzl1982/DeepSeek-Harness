'use strict';
/**
 * shell/main.js —— Phase 0 测试台最小 Electron 壳
 *
 * ⚠️ 本目录【完全不接入客户端】：不 require desktop/ 下任何文件，不改任何客户端代码。
 *
 * 登录态复用：
 *   默认 -> 使用本测试台独立的 userData（干净，需要自己登录）
 *   --reuse-login -> 指向客户端同一个 userData 目录，
 *                    从而复用 Partitions/agent-* 里已登录的 9 个账号
 *                    （需先关闭 DSH 客户端，避免 userData 被占用）
 */

const path = require('path');
const { app, BrowserWindow } = require('electron');

const REUSE_LOGIN = process.argv.includes('--reuse-login');
const CLIENT_USER_DATA = 'D:\\Users\\Admin\\AppData\\Roaming\\DeepSeek Harness';

if (REUSE_LOGIN) {
  app.setPath('userData', CLIENT_USER_DATA);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1680,
    height: 1020,
    title: '通辽会议 · Phase 0 测试台（独立，不接客户端）',
    backgroundColor: '#0b0e14',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

app.whenReady().then(() => {
  console.log('[meeting-lab] userData =', app.getPath('userData'));
  console.log('[meeting-lab] 登录态复用 =', REUSE_LOGIN ? '是（复用客户端 partition）' : '否（独立）');
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
