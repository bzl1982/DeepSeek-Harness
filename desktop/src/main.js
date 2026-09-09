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

const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const DSH_START_TIMEOUT_MS = 120000; // 首次启动需加载 200+ 插件，放宽到 2 分钟

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

    const child = spawn(nodeExe, [binPath, 'web', '--no-open', '--port', '0'], {
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

  win.loadURL(url);
  win.on('closed', () => {
    win = null;
  });
}

/* ---------- 应用生命周期 ---------- */

app.whenReady().then(async () => {
  try {
    const url = await startDshService();
    if (app.isQuitting) return;
    createWindow(url);
  } catch (err) {
    dialog.showErrorBox('DeepSeek Harness 启动失败', String((err && err.message) || err));
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
