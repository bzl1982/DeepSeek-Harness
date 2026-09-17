'use strict';

/**
 * DeepSeek Harness Desktop — Electron 主进程
 *
 * 职责：
 *  1. 以捆绑的 Node.js 运行时启动 dsh web 本地服务（随机空闲端口）
 *  2. 解析服务输出的带 token 访问地址
 *  3. 创建原生窗口加载该地址
 *  4. 应用退出时完整清理服务进程树
 */

const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

// 启动 Splash 内 Web Audio 音效（砸地/破碎）无需用户手势即可自动播放
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const DSH_START_TIMEOUT_MS = 120000; // 首次启动需加载 200+ 插件，放宽到 2 分钟

/* ---------- 窗口先行：极简深色等待（服务没起时只显示一个蓝点，不画假内容；服务起来直接出真实界面） ---------- */

const DSH_PORT = 38123;
const DSH_URL = `http://127.0.0.1:${DSH_PORT}`;

// 启动动画页面：loading.html + loading.mp4 同目录，用 file:// 加载（同目录访问媒体不跨协议）
function resolveLoadingPage() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'loading.html');
  }
  return path.join(__dirname, '..', 'resources', 'loading.html');
}

/**
 * DeepSeek 品牌蓝（官方 --ds-color-brand: #4d6bfe，取自 deepseek.com 设计变量，
 * 与移动端 App 图标鲸鱼取色一致）。
 *
 * 皮肤系统：通过 executeJavaScript 注入到 dsh Web UI——
 *  - 「蓝色字体」：鲸鱼 logo、首页标题「探索未至之境」、徽章「预览版」渲染为品牌蓝
 *  - 「黑色字体」：官方默认（Harness 黑鲸）风格
 *  - 在「设置 → 外观」中追加「字体颜色」二选一控件，选择持久化到 localStorage
 *  - 选择器基于 dsh 前端 bundle 的 CSS Modules 类名（fish / headlineText / previewBadge）
 */
const BRAND_BLUE = '#4D6BFE';
const SKIN_JS = `
(() => {
  var KEY = 'dsh-desktop-skin';
  var BLUE = '${BRAND_BLUE}';
  var skinCss = [
    'html[data-ds-skin="blue"] [class*="fish"]{color:' + BLUE + '!important}',
    'html[data-ds-skin="blue"] [class*="headlineText"]{color:' + BLUE + '!important}',
    'html[data-ds-skin="blue"] [class*="previewBadge"]{color:' + BLUE + '!important;border-color:rgba(77,107,254,.4)!important;background:rgba(77,107,254,.12)!important}',
    'html[data-ds-skin="blue"] [class*="brandIdentity"],html[data-ds-skin="blue"] [class*="brandName"],html[data-ds-skin="blue"] [class*="brandMark"]{color:' + BLUE + '!important}'
  ].join('\\n');
  var styleEl = document.createElement('style');
  styleEl.id = 'ds-skin-style';
  styleEl.textContent = skinCss;
  (document.head || document.documentElement).appendChild(styleEl);

  var getSkin = function () {
    try { return localStorage.getItem(KEY) || 'blue'; } catch (e) { return 'blue'; }
  };
  var applySkin = function (skin) {
    if (skin === 'blue') { document.documentElement.setAttribute('data-ds-skin', 'blue'); }
    else { document.documentElement.removeAttribute('data-ds-skin'); }
    try { localStorage.setItem(KEY, skin); } catch (e) {}
  };
  applySkin(getSkin());
  // 「字体颜色」二选一控件由前端源码补丁原生渲染（scripts/patch-dsh-theme.py 注入到
  // dsh-client-ui-theme 的 AppearanceRow 组件），此处无需再注入 DOM。
})();
`;

let win = null;
let dshProc = null;
let shuttingDown = false;

/* ---------- 运行时定位 ---------- */

function resolveRuntime() {
  if (app.isPackaged) {
    const res = process.resourcesPath;
    const nodeExe =
      process.platform === 'win32'
        ? path.join(res, 'node-runtime', 'node.exe')
        : path.join(res, 'node-runtime', 'node');
    return {
      runtimeDir: path.join(res, 'dsh-runtime'),
      nodeExe,
      nodePathDir: path.dirname(nodeExe),
    };
  }
  // 开发模式：使用系统 Node 与仓库旁的运行时目录
  return {
    runtimeDir: path.join(__dirname, '..', '_dev_runtime'),
    nodeExe: process.platform === 'win32' ? 'node.exe' : 'node',
    nodePathDir: null,
  };
}

function extractUrl(line) {
  const i = line.indexOf('http://');
  if (i === -1) return null;
  return line.slice(i).trim();
}

/* ---------- dsh 服务生命周期 ---------- */

function startDshService() {
  return new Promise((resolve, reject) => {
    const { runtimeDir, nodeExe, nodePathDir } = resolveRuntime();
    const binPath = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

    if (!fs.existsSync(binPath)) {
      reject(new Error(`未找到 dsh 运行时：\n${binPath}`));
      return;
    }

    const env = { ...process.env };
    if (nodePathDir) {
      env.PATH = nodePathDir + path.delimiter + (env.PATH || '');
    }

    const child = spawn(nodeExe, [binPath, 'web', '--no-open', '--port', String(DSH_PORT)], {
      cwd: runtimeDir,
      env,
      // detached: 让服务进程独立成组，便于整树清理（macOS/linux 用负 pid 杀组）
      detached: process.platform !== 'win32',
    });

    if (!child.pid) {
      reject(new Error('dsh 服务进程启动失败'));
      return;
    }
    dshProc = child;

    let outBuf = '';
    let errBuf = '';
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new Error(`dsh 服务启动超时（${DSH_START_TIMEOUT_MS / 1000}s）。\n${errBuf.slice(-2000)}`));
    }, DSH_START_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      outBuf += chunk.toString();
      // dsh web 会打印形如 `dsh web: http://127.0.0.1:PORT/?token=xxx`，
      // 必须用带 token 的完整 URL，否则浏览器访问得到 401 黑屏
      const url = extractUrl(outBuf);
      if (url && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(url);
      }
    });

    child.stderr.on('data', (chunk) => {
      errBuf += chunk.toString();
    });

    child.on('error', (err) => fail(err));

    child.on('exit', (code, signal) => {
      if (dshProc === child) dshProc = null;
      if (settled) {
        if (!shuttingDown) {
          dialog.showErrorBox(
            'DeepSeek Harness',
            `本地服务意外退出（code=${code} signal=${signal}）。\n\n${errBuf.slice(-1500)}`,
          );
          app.quit();
        }
        return;
      }
      fail(new Error(`dsh 服务启动失败（code=${code} signal=${signal}）。\n${errBuf.slice(-1500)}`));
    });
  });
}

/** 整树结束服务进程（Windows 用 taskkill /T，其余平台杀进程组） */
function killDshTree() {
  if (!dshProc || dshProc.killed) return;
  const pid = dshProc.pid;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        dshProc.kill('SIGTERM');
      }
    }
  } catch {
    /* 忽略清理异常 */
  }
}

/* ---------- 窗口 ---------- */

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    center: true,
    show: false, // 启动动画播完后再 show
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // 外链一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) {
      shell.openExternal(target);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith('http://127.0.0.1') && !target.startsWith('http://localhost')) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  // 注入皮肤系统（品牌蓝 / 官方黑 切换 + 设置面板「字体颜色」选项）
  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(SKIN_JS).catch(() => {});
  });

  // 服务还没起时兜底
  win.webContents.on('did-fail-load', (event, errorCode, errorDesc, validatedURL) => {
    if (shuttingDown) return;
    if (validatedURL && validatedURL.startsWith(DSH_URL)) {
      win.loadURL(DSH_URL);
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

/* 全屏霓虹启动页：无边框透明置顶，覆盖整个显示器 */
let splash = null;
function createSplash() {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;
  splash = new BrowserWindow({
    width, height,
    x: 0, y: 0,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      // 页面动画完成后通过 preload 桥通知主进程转场
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // 传主窗口宽给页面：字母行宽 ≤ 窗口宽（多分辨率自适应）
  const mainW = win ? win.getBounds().width : 1280;
  splash.loadFile(resolveLoadingPage(), { query: { w: String(mainW) } });
  splash.setAlwaysOnTop(true, 'screen-saver');
  splash.on('closed', () => { splash = null; });
}

/* ---------- 应用生命周期 ---------- */

app.whenReady().then(async () => {
  const t0 = Date.now();
  const MIN_SPLASH_MS = 4500; // Splash 至少播放时长（页面崩溃/加载失败时兜底）
  const SPLASH_MAX_WAIT_MS = 30000; // 页面动画完成信号最长等待（兜底，防卡死）
  createWindow();      // 主窗口先创建但隐藏、居中
  createSplash();      // 全屏透明鲸鱼喷字母启动页
  // 页面动画走完（渐白完成）后由 preload 桥通知，收到即转场
  let splashDone = false;
  ipcMain.on('splash-done', () => { splashDone = true; });
  try {
    const url = await startDshService();
    if (app.isQuitting || !win) return;
    // 提前后台加载主界面：splash 播放期间加载完成，转场时直接显示已加载好的窗口，无空白间隙
    win.loadURL(url);
    // 等页面动画完成信号；最少播 MIN_SPLASH_MS，最多等 SPLASH_MAX_WAIT_MS 兜底
    while (!splashDone && Date.now() - t0 < SPLASH_MAX_WAIT_MS) {
      const wait = Math.min(200, Math.max(0, MIN_SPLASH_MS - (Date.now() - t0)));
      await new Promise((r) => setTimeout(r, wait || 200));
    }
    if (app.isQuitting || !win) return;
    // 收到信号立即转场（主界面早已在后台加载，最多再让 1.5s 收尾，几乎零等待）
    const tShow = Date.now();
    while (win.webContents.isLoading() && Date.now() - tShow < 1500) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // 关启动页，立即显示主窗口（无缝转场）
    if (splash) { splash.close(); splash = null; }
    win.show();
  } catch (err) {
    if (splash) { splash.close(); splash = null; }
    if (win) {
      win.show();
      win.loadURL(
        'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#0b0e14;color:#e8eaf0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:20px}h1{font-size:16px}p{font-size:13px;color:#9aa3b2;line-height:1.7;word-break:break-all}</style>' +
          '<body><h1>DeepSeek Harness 启动失败</h1><p>' + String((err && err.message) || err) + '</p></body>'
        )
      );
    } else {
      dialog.showErrorBox('DeepSeek Harness 启动失败', String((err && err.message) || err));
    }
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // 桌面应用行为：关闭窗口即退出并清理服务
  shuttingDown = true;
  killDshTree();
  app.quit();
});

app.on('before-quit', () => {
  shuttingDown = true;
  killDshTree();
});

// macOS：点击 Dock 图标时窗口通常已重建；此处统一为关闭窗口即退出，无需单独处理。
