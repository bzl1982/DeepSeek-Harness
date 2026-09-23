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
const { app, BrowserWindow, ipcMain, webContents } = require('electron');

const REUSE_LOGIN = process.argv.includes('--reuse-login');

// 9 个 webview 同时渲染时 GPU 进程极易崩溃，会把整个程序带走（表现为"闪退"）。
// 关闭硬件加速规避；网页 AI 用软件渲染照样正常显示对话页，功能不受影响。
//
// ★ 2026-09-23 修复「拖拽复制卡死」：绝不能加 disable-software-rasterizer！
//   disable-gpu 之后 Chromium 用 SwiftShader（软件光栅）兜底出帧；
//   disable-software-rasterizer 把这条兜底路径也砍掉 → 等于没有任何光栅器。
//   文本选区拖拽 / 滚动 / 拖拽影像生成都需要连续出帧 → 直接挂死整个窗口。
//   日志里的 "Message rejected by interface blink.mojom.WidgetHost" 就是合成器
//   死掉的指纹（实测：去掉该开关后 12 个 target 全部正常渲染）。
app.commandLine.appendSwitch('disable-gpu');

/* ★ 2026-09-23 修复「Gemini 复制按钮点了没反应」：
 *   网页 AI 的复制按钮走 navigator.clipboard.writeText()，而 Electron 默认
 *   拒绝 webview 的 clipboard-sanitized-write 权限 → promise 静默失败，
 *   按钮看起来"点了没反应"。这里对所有 session 统一放行剪贴板读写
 *   （顺带放行媒体/通知等网页 AI 常用权限），其余权限维持默认拒绝。
 *   app.on('session-created') 在 Electron 12+ 可用（本机 33.2.0 实测支持）。 */
const COMMON_PERMS = new Set([
  'clipboard-sanitized-write',
  'clipboard-read',
  'media',
  'audioCapture',
  'videoCapture',
  'notifications',
  'fullscreen',
  'pointerLock',
  'mediaKeySystem',
]);
app.on('session-created', (session) => {
  session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(COMMON_PERMS.has(permission));
  });
  session.setPermissionCheckHandler((wc, permission) => COMMON_PERMS.has(permission));
});

// 客户端 userData 目录 = appData + 应用名（客户端 productName 是 "DeepSeek Harness"）。
// ★ 不写死盘符与用户名：
//   Electron 的 appData —— Windows 是 %APPDATA%（本机已迁到 D:\Users\Admin\AppData\Roaming，
//   与原先硬编码的路径恰好一致，所以本机行为零变化），macOS 是 ~/Library/Application Support。
//   写死 'D:\Users\Admin\...' 的话，测试台拿到 Mac 上跑 --reuse-login 会指向一个不存在的目录，
//   表现为"所有网页模型都是未登录"——而且不会报错，只能靠人猜。
const CLIENT_USER_DATA = path.join(app.getPath('appData'), 'DeepSeek Harness');

if (REUSE_LOGIN) {
  app.setPath('userData', CLIENT_USER_DATA);
}

/* ★ 席位弹出窗口：
 *   网页席位 → 同一个 partition = 直接复用登录态（无需重登）。
 *   API 席位 → 无网页，弹出的是「对话记录」窗口（可全屏 / 自由调大小），
 *              渲染进程开会时通过 seat-popup-update 把最新文本同步进来。
 *   窗口关闭时通知渲染进程恢复格子。 */
const apiPopupWins = new Map();

ipcMain.handle('seat-popup-open', (e, { id, name, url, partition, api }) => {
  if (api) {
    const win = new BrowserWindow({
      width: 1200,
      height: 860,
      title: `${name || id} · 通辽会议`,
      backgroundColor: '#0b0e14',
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    win.loadURL('data:text/html,' + encodeURIComponent(
      '<!doctype html><html><head><meta charset="utf-8">'
      + '<style>body{background:#0b0e14;color:#bcd;font-family:Consolas,monospace;padding:14px;'
      + 'font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;overflow:auto}</style>'
      + '</head><body id="b">（等待会议下发第一条消息…）</body></html>'
    ));
    win.on('closed', () => {
      apiPopupWins.delete(id);
      if (!e.sender.isDestroyed()) e.sender.send('seat-popup-closed', id);
    });
    apiPopupWins.set(id, win);
    return true;
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    title: `${name || id} · 通辽会议`,
    backgroundColor: '#0b0e14',
    webPreferences: { partition, sandbox: true, contextIsolation: true },
  });
  win.loadURL(url);
  win.on('closed', () => {
    if (!e.sender.isDestroyed()) e.sender.send('seat-popup-closed', id);
  });
  return true;
});

/* API 弹出窗口的对话内容实时同步 */
ipcMain.on('seat-popup-update', (e, { id, text }) => {
  const win = apiPopupWins.get(id);
  if (!win || win.isDestroyed()) return;
  const safe = JSON.stringify(text || '');
  win.webContents.executeJavaScript(`(function(){var b=document.getElementById('b');if(b)b.textContent=${safe};})()`).catch(() => {});
});

/* ★ CDP 塞文件（renderer 无法访问 webContents 模块——那是主进程专属，
 *   所以 setFiles 必须经 IPC 让主进程代持 webContents.debugger）。
 *   输入 { webContentsId, files: [绝对路径] }，输出 { ok, error? } */
ipcMain.handle('cdp-set-files', async (e, { webContentsId, files }) => {
  const wc = webContents.fromId(webContentsId);
  if (!wc) return { ok: false, error: 'webContents 不存在（webview 可能还没 dom-ready）' };
  const dbg = wc.debugger;
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      await new Promise((r) => setTimeout(r, 250));
    }
    // 没有 file input 就造一个（部分站点懒加载/自定义上传）
    await wc.executeJavaScript(`(function(){
      var inp = document.querySelector('input[type="file"]');
      if (!inp) {
        inp = document.createElement('input');
        inp.type = 'file'; inp.style.display = 'none';
        document.body.appendChild(inp);
      }
      return true;
    })();`);
    const root = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
    const found = await dbg.sendCommand('DOM.querySelector', {
      nodeId: root.root.nodeId, selector: 'input[type="file"]',
    });
    if (!found || !found.nodeId) return { ok: false, error: '页面上找不到 <input type=file>（造的兜底也没生效）' };
    await dbg.sendCommand('DOM.setFileInputFiles', { files, nodeId: found.nodeId });
    // ★ 一个合成事件都不要派！DOM.setFileInputFiles 本身就会触发浏览器原生的
    //   input+change 事件（实测：再手动派发 = Kimi/豆包收到两份重复文件）。
    //   附言/发送由用户在对话框里自己填自己做（用户裁决：不许自动发出去）。
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

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
