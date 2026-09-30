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

const { app, BrowserWindow, dialog, shell, ipcMain, webContents, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');

// [dsh-desktop 嵌入] 智能体大脑（网页版 AI × 本地 Harness）
const { createAgentRuntime } = require('../agent/main.js');
// [网页版智能体] 唯一配置源（命名/URL/partition/登录检测），三处界面共用
const { AGENT_CATALOG } = require('./agentCatalog.js');

let agentRuntime = null;

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

/* ---------- 窗口图标：鲸鱼，颜色跟随皮肤（蓝 / 黑） ---------- */
// 背景（2026-09-22）：旧版 main.js 建窗口时**没有传 icon**，dev 模式下窗口/任务栏
// 落到 Electron 默认图标（深色圆标），只有打包版才靠 build/icon.ico 显示鲸鱼 —— 这就是
// 「左上角图标变成默认的了」的原因。这里显式设置，dev 与打包一致。
// 两个 PNG 由 official-ref/make-icons.js 从 build/whale-mark.svg（官方鲸鱼矢量图）光栅化生成。
const WINDOW_ICON_FILES = { blue: 'win-icon-blue.png', black: 'win-icon-dark.png' };
function resolveWindowIcon(skin) {
  const name = WINDOW_ICON_FILES[skin] || WINDOW_ICON_FILES.blue;
  const candidates = [
    path.join(__dirname, '..', 'build', name),        // 开发模式 & 打包进 asar
    path.join(__dirname, '..', 'resources', name),    // 兜底
    path.join(process.resourcesPath || '', name),     // 打包后 resources 目录
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) { /* 忽略 */ }
  }
  return null;
}
let windowIconPath = resolveWindowIcon('blue');

// 启动自检日志：确认图标资源真的能加载（排查「左上角还是默认图标」时一眼可见）
try {
  const probe = windowIconPath ? nativeImage.createFromPath(windowIconPath) : null;
  console.log('[icon] window icon = ' + windowIconPath + ' / ' +
    (probe && !probe.isEmpty() ? JSON.stringify(probe.getSize()) : 'INVALID'));
} catch (e) {
  console.log('[icon] probe failed: ' + (e && e.message));
}
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
    icon: windowIconPath || undefined, // 鲸鱼图标（随皮肤切换，见 ipcMain.on('skin:changed')）
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    center: true,
    show: false, // 启动动画播完后再 show
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: false,
      // [dsh-desktop 嵌入] 主窗口 preload：暴露 window.dshAgent（智能体桥），
      // 供 dsh 前端「模型选择器 / 设置-模型」打开智能体窗口、管理网页模型
      preload: path.join(__dirname, 'preload.js'),
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

  // [会议功能] 主窗口左下角「通辽会议」按钮（复制设置按钮样式，插在旁边）
  win.webContents.on('dom-ready', () => {
    const MEET_BTN_JS = `
      (function() {
        var injected = false;
        function inject() {
          try {
            if (document.getElementById('dsh-meet-btn')) { injected = true; return; }
            // [Bug6 修复] 严格锁定侧边栏底部「设置」按钮，过滤掉右上角头部齿轮
            // 旧逻辑 fallback 到 button[aria-label*="设置"] 会误命中头部右上角齿轮，导致按钮跑到右上角。
            function findSidebarSettingsBtn() {
              // 1) 优先：侧边栏/导航容器内直接找设置按钮（class 或 aria-label 命中）
              var containers = document.querySelectorAll('[class*="sidebar"], nav, aside');
              for (var c = 0; c < containers.length; c++) {
                var btns = containers[c].querySelectorAll('button');
                for (var i = 0; i < btns.length; i++) {
                  var b = btns[i];
                  var cls = (b.className || '').toString();
                  var aria = b.getAttribute ? (b.getAttribute('aria-label') || '') : '';
                  if (/setting/i.test(cls) || /设置|settings/i.test(aria)) return b;
                }
              }
              // 2) 兜底：所有「设置」按钮里，排除位于顶部 header/topbar 的，取最靠下（y 最大）的一个
              var cands = document.querySelectorAll('button[aria-label*="设置"], button[aria-label*="Settings"]');
              var best = null, bestY = -1;
              for (var j = 0; j < cands.length; j++) {
                var el = cands[j];
                var inHeader = false, p = el;
                while (p) {
                  var pc = (p.className || '').toString();
                  if (/header|topbar|top-bar|navbar|titlebar/i.test(pc)) { inHeader = true; break; }
                  p = p.parentElement;
                }
                if (inHeader) continue;
                var r = el.getBoundingClientRect();
                if (r.height > 0 && r.top > bestY) { bestY = r.top; best = el; }
              }
              return best;
            }
            var settingsBtn = findSidebarSettingsBtn();
            if (!settingsBtn) return;
            // 深度克隆设置按钮：继承全部 class / CSS 变量 / flex 布局 / hover 样式，颜色字体与设置完全一致
            var btn = settingsBtn.cloneNode(true);
            btn.id = 'dsh-meet-btn';
            btn.removeAttribute('data-reactid');
            btn.setAttribute('aria-label', '通辽会议');
            btn.title = '通辽会议';
            // 清理克隆节点可能携带的内联背景（防历史方案残留导致自带底色）
            btn.style.removeProperty('background');
            btn.style.removeProperty('background-color');
            btn.style.removeProperty('color');
            // 只替换第一个非空文本节点为「通辽会议」
            var walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              var t = walker.currentNode;
              if (t.textContent && t.textContent.trim()) { t.textContent = '通辽会议'; break; }
            }
            // 替换图标为会议图标：整只换掉 SVG 并显式指定 viewBox=24，
            // 避免沿用设置按钮原 viewBox（如 16×16）导致图形被裁切只剩圆点；
            // width/height 跟随设置按钮图标的实际渲染尺寸，保证两个图标一样大
            var svg = btn.querySelector('svg');
            if (svg) {
              var cls = svg.getAttribute('class') || '';
              var w = svg.getAttribute('width') || '';
              var h = svg.getAttribute('height') || '';
              if (!w || !h) {
                var sr = svg.getBoundingClientRect();
                if (sr.width > 0) w = Math.round(sr.width) + 'px';
                if (sr.height > 0) h = Math.round(sr.height) + 'px';
              }
              if (!w) w = '16px';
              if (!h) h = '16px';
              var ns = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
              if (cls) ns.setAttribute('class', cls);
              ns.setAttribute('viewBox', '0 0 24 24');
              ns.setAttribute('width', w);
              ns.setAttribute('height', h);
              ns.setAttribute('fill', 'none');
              ns.setAttribute('stroke', 'currentColor');
              ns.setAttribute('stroke-width', '1.8');
              ns.setAttribute('stroke-linecap', 'round');
              ns.setAttribute('stroke-linejoin', 'round');
              ns.setAttribute('style', 'flex-shrink:0;display:block;');
              ns.innerHTML = '<rect x="2" y="4" width="14" height="10" rx="2"/><path d="M6 18h6"/><path d="M9 14v4"/><rect x="16" y="8" width="6" height="8" rx="1.5" opacity="0.7"/><circle cx="7" cy="9" r="1.2" fill="currentColor"/><circle cx="11" cy="9" r="1.2" fill="currentColor"/>';
              svg.replaceWith(ns);
            }
            btn.onclick = function() { if (window.dshAgent && window.dshAgent.openMeeting) window.dshAgent.openMeeting(); };
            // 布局：父容器纵向则直接插在设置下方；横向则用无样式 wrapper 包成上下两行（保证上下罗列）
            var parent = settingsBtn.parentNode;
            var ps = window.getComputedStyle(parent);
            if (ps.display === 'flex' && ps.flexDirection.indexOf('column') >= 0) {
              parent.insertBefore(btn, settingsBtn.nextSibling);
            } else {
              var wrapper = document.createElement('div');
              wrapper.style.cssText = 'display:flex;flex-direction:column;gap:4px;width:100%;';
              parent.insertBefore(wrapper, settingsBtn);
              wrapper.appendChild(settingsBtn);
              wrapper.appendChild(btn);
            }
            injected = true;
          } catch (e) {}
        }
        // 立即试一次 + MutationObserver 持久监听（React 重渲染删掉克隆按钮后自动补回，防再次消失）
        inject();
        var mo = new MutationObserver(function() {
          inject();
        });
        mo.observe(document.body, { childList: true, subtree: true });
        // 30 秒兜底：从未注入成功则断开观察，避免无限空转
        setTimeout(function() { if (!document.getElementById('dsh-meet-btn')) mo.disconnect(); }, 30000);
      })();
    `;
    win.webContents.executeJavaScript(MEET_BTN_JS).catch(() => {});
  });

  // [已删除 · 2026-09-22] 原「模型 UI 注入」整段（读取 inject/model-ui.js 并 executeJavaScript）
  // 该注入会在页面上挂一个全局 hover 浮层 .dsh-mui-flyout（position:fixed / z-index 2147483600 /
  // background #161922 / box-shadow 10px 34px rgba(0,0,0,.5)）+ 全局 MutationObserver + 宽泛关键词命中，
  // 症状就是"鼠标移到哪、哪就冒出一块黑色阴影弹窗"，并在网页智能体区叠加重复的「打开并登录」按钮。
  // 现已整段删除（不是注释掉、不是改名），注入源文件也已移出仓库（official-ref/quarantine/），黑阴影不可能再出现。
  // 若日后要做模型弹窗增强，必须改在官方包 @deepseek-ai/dsh-client-ui-model-selection 内部做局部增强，
  // 严禁再使用全局注入 / 全局 MutationObserver / 全屏 fixed 浮层。


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

// [方案A] 给所有 webview 伪装成真实 Chrome 环境
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    contents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    contents.on('dom-ready', () => {
      contents.executeJavaScript(`
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
        window.chrome = { runtime: {} };
      `).catch(() => {});
    });
  }
});

app.whenReady().then(async () => {
  const t0 = Date.now();
  const MIN_SPLASH_MS = 4500; // Splash 至少播放时长（页面崩溃/加载失败时兜底）
  const SPLASH_MAX_WAIT_MS = 30000; // 页面动画完成信号最长等待（兜底，防卡死）
  createWindow();      // 主窗口先创建但隐藏、居中
  createSplash();      // 全屏透明鲸鱼喷字母启动页

  // [dsh-desktop 嵌入] 智能体大脑随客户端一起拉起（Harness 常驻 127.0.0.1:17321）。
  // 与 dsh 服务并行启动，不阻塞 splash；数据/审计写 userData/agent。
  const startAgentRuntime = (async () => {
    try {
      agentRuntime = await createAgentRuntime({
        dataDir: path.join(app.getPath('userData'), 'agent'),
        onLog: (msg) => console.log(msg),
      });
    } catch (e) {
      console.error('[agent] 启动失败:', e);
      agentRuntime = null;
    }
  })();

  // 页面动画走完（渐白完成）后由 preload 桥通知，收到即转场
  let splashDone = false;
  ipcMain.on('splash-done', () => { splashDone = true; });

  // [dsh-desktop 嵌入] 主窗口（dsh Web UI）→ 智能体 IPC
  ipcMain.on('agent:open', (_event, providerId) => {
    if (!agentRuntime) return;
    agentRuntime.openAgentWindow(typeof providerId === 'string' ? providerId : 'deepseek-web');
  });
  ipcMain.handle('agent:listProviders', () => {
    if (!agentRuntime) return [];
    return agentRuntime.listProviderMeta();
  });
  ipcMain.handle('agent:addProvider', async (_event, input) => {
    if (!agentRuntime) return { ok: false, error: '智能体未就绪' };
    return agentRuntime.addProvider(input || {});
  });
  ipcMain.handle('agent:removeProvider', async (_event, id) => {
    if (!agentRuntime) return { ok: false, error: '智能体未就绪' };
    return agentRuntime.removeProvider(id);
  });

  // [会议功能] 拖拽排序期间：让会议窗口内所有 webview guest 的鼠标事件穿透到宿主 DOM。
  // guest 也是 WebContents，setIgnoreMouseEvents 是进程级穿透，比 CSS pointer-events 更底层，
  // 与宿主侧「data-dragging → webview pointer-events:none」双保险。
  ipcMain.on('meeting:set-ignore-mouse', (event, ignore) => {
    const host = event.sender;
    for (const wc of webContents.getAllWebContents()) {
      if (wc.getType() === 'webview' && wc.hostWebContents === host) {
        try { wc.setIgnoreMouseEvents(!!ignore); } catch (err) { /* 忽略个别 guest 未就绪 */ }
      }
    }
  });

  // [网页版智能体] 唯一配置源：命名/URL/partition/登录检测选择器（三处界面共用）
  ipcMain.handle('catalog:get', () => AGENT_CATALOG);

  // [网页版智能体] 登录状态中心：会议窗口 webview 检测上报 → 主进程缓存 → 广播给主窗口/会议窗口
  const authState = new Map(); // id -> { status: 'in'|'out'|'unknown', name, updatedAt }
  AGENT_CATALOG.forEach((m) => authState.set(m.id, { status: 'unknown', name: '', updatedAt: 0 }));

  ipcMain.on('auth:report', (event, payload) => {
    if (!payload || typeof payload.id !== 'string') return;
    const id = payload.id;
    if (!authState.has(id)) return;
    const prev = authState.get(id);
    const status = payload.status === 'in' || payload.status === 'out' ? payload.status : 'unknown';
    const name = typeof payload.name === 'string' ? payload.name : '';
    if (prev.status === status && prev.name === name) return; // 未变化不广播，防 UI 闪烁
    authState.set(id, { status, name, updatedAt: Date.now() });
    const snapshot = Object.fromEntries(authState);
    // 广播给所有窗口（主窗口 dsh UI + 会议窗口名牌）
    for (const wc of webContents.getAllWebContents()) {
      if (wc.getType() === 'window' && !wc.isDestroyed()) {
        wc.send('auth:changed', snapshot);
      }
    }
  });
  ipcMain.handle('auth:getState', () => Object.fromEntries(authState));

  // [模型 UI 调试] 接收 renderer dump 的 DOM 结构，写日志文件供排查
  ipcMain.on('model-ui:dump', (_e, data) => {
    try {
      const dumpPath = require('path').join(app.getPath('temp'), 'dsh-model-ui-dump.json');
      require('fs').writeFileSync(dumpPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) { /* 忽略写文件失败 */ }
  });

  // [窗口图标] 皮肤变化 → 同步窗口/任务栏图标（蓝鲸 / 黑鲸）
  // 皮肤值存在 renderer 的 localStorage('dsh-desktop-skin')，preload 里轮询上报，此处只做 setIcon。
  ipcMain.on('skin:changed', (_e, skin) => {
    const p = resolveWindowIcon(skin);
    if (!p) return;
    windowIconPath = p;
    try { if (win && !win.isDestroyed()) win.setIcon(p); } catch (err) { /* 忽略 */ }
    try { if (splash && !splash.isDestroyed()) splash.setIcon(p); } catch (err) { /* 忽略 */ }
  });

  // [会议功能] 打开 AI 会议窗口
  let meetingWin = null;
  ipcMain.on('meeting:open', () => {
    if (meetingWin && !meetingWin.isDestroyed()) { meetingWin.focus(); return; }
    meetingWin = new BrowserWindow({
      width: 1600, height: 900, minWidth: 1200, minHeight: 700,
      title: 'AI 会议', backgroundColor: '#0b0e14',
      icon: windowIconPath || undefined,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true,
        preload: path.join(__dirname, '..', 'agent', 'meeting-preload.js'),
      },
    });
    meetingWin.loadFile(path.join(__dirname, '..', 'agent', 'meeting.html'));
    meetingWin.on('closed', () => { meetingWin = null; });
  });

  // [会议功能] 把长文本写成临时 .md 文件（meeting 窗口 sandbox:true，renderer 无 fs 权限，由主进程代写）
  ipcMain.handle('meeting:writeTempMd', async (_e, filename, content) => {
    const dir = path.join(os.tmpdir(), 'dsh-meeting-files');
    await fs.promises.mkdir(dir, { recursive: true });
    const p = path.join(dir, filename);
    await fs.promises.writeFile(p, content, 'utf-8');
    return p;
  });

  // [P0 会议功能] 把拖拽进来的真实文件落盘到会话目录，返回绝对路径 + sha256。
  // 这是附件握手的【地基】：没有 localPath，AttachmentBus 就没有落点。
  // ★ 安全校验（缺一不可，否则 renderer 就能借主进程写任意位置）：
  //   ① 只写进 <sessionDir>/ 下
  //   ② 文件名做 basename + 白名单字符过滤（拦掉 ../ 与绝对路径）
  //   ③ 单个文件 200MB 上限，单会话目录总量 2GB 上限（超了报 TOO_LARGE）
  // 同一 sessionKey 的文件都落在同一个会话目录，散会后可整个删除。
  const MEETING_MAX_FILE_BYTES = 200 * 1024 * 1024;
  const MEETING_MAX_SESSION_BYTES = 2 * 1024 * 1024 * 1024;
  const safeFileName = (name) => {
    const base = path.basename(String(name || '').replace(/\\/g, '/'));
    const cleaned = base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    return cleaned || `file_${Date.now().toString(36)}`;
  };
  const sha256OfFile = async (p) => {
    const crypto = require('crypto');
    const h = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const s = fs.createReadStream(p);
      s.on('data', (d) => h.update(d));
      s.on('end', resolve);
      s.on('error', reject);
    });
    return h.digest('hex');
  };
  // [P0 会议功能] 陈旧会议附件清理：os.tmpdir()/dsh-meeting-files 下的会话目录。
  // 惰性执行一次（首次真正用到附件功能时才跑），删掉 24h 前的会话目录——
  // 否则"散会后可整个删除"只是注释，临时目录会无限累积。
  let meetingTmpSwept = false;
  const sweepStaleMeetingFiles = async () => {
    if (meetingTmpSwept) return;
    meetingTmpSwept = true;
    const root = path.join(os.tmpdir(), 'dsh-meeting-files');
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const full = path.join(root, ent.name);
        try {
          const st = await fs.promises.stat(full);
          if (st.mtimeMs < cutoff) await fs.promises.rm(full, { recursive: true, force: true });
        } catch (e) { /* 单个目录清理失败不影响其它 */ }
      }
    } catch (e) { /* 根目录不存在 = 从未用过附件功能 */ }
  };

  ipcMain.handle('meeting:saveAttachment', async (_e, sessionKey, name, bytes, size, mime) => {
    const key = String(sessionKey || '').replace(/[^A-Za-z0-9_-]/g, '') || 's';
    sweepStaleMeetingFiles(); // 惰性清理陈旧附件目录（不阻塞本次落盘）
    // ★ 校验对象必须与写入对象一致：size 是 renderer 自报的独立参数、可伪造，
    //   只校验它的话「谎报 size=1 + 塞超大数据」即可绕过 200MB 上限。
    //   真实长度一律以 bytes 自身为准（ArrayBuffer/TypedArray 用 byteLength）。
    const realSize = bytes && typeof bytes.byteLength === 'number'
      ? bytes.byteLength
      : (bytes && typeof bytes.length === 'number' ? bytes.length : -1);
    if (!Number.isInteger(realSize) || realSize <= 0 || realSize > MEETING_MAX_FILE_BYTES) {
      return { ok: false, error: 'TOO_LARGE' };
    }
    const dir = path.join(os.tmpdir(), 'dsh-meeting-files', `session_${key}`);
    await fs.promises.mkdir(dir, { recursive: true });
    // 总量上限：先估算已用字节（数目录下文件）
    let used = 0;
    try {
      const entries = await fs.promises.readdir(dir);
      for (const f of entries) {
        /* eslint-disable-next-line no-await-in-loop */
        const st = await fs.promises.stat(path.join(dir, f));
        used += st.size;
      }
    } catch (e) { /* 目录不存在 */ }
    if (used + realSize > MEETING_MAX_SESSION_BYTES) {
      return { ok: false, error: 'TOO_LARGE' };
    }
    const safe = safeFileName(name);
    const p = path.join(dir, `${Date.now().toString(36)}-${safe}`);
    // 防御：basename 已过滤，再检查一次最终路径确实落在 sessionDir 内
    if (!p.startsWith(dir + path.sep)) {
      return { ok: false, error: 'BAD_NAME' };
    }
    try {
      await fs.promises.writeFile(p, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
      const sha256 = await sha256OfFile(p);
      return { ok: true, localPath: p, size: realSize, mime: mime || 'application/octet-stream', sha256 };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // [会议功能] 独立浏览器窗口（完整浏览器功能，登录用）
  const browserWins = new Map();
  function openBrowserWindow(providerId, url) {
    if (!providerId || !url) return;
    if (browserWins.has(providerId)) { browserWins.get(providerId).focus(); return; }
    const bw = new BrowserWindow({
      width: 1280, height: 800, minWidth: 800, minHeight: 600,
      title: providerId, backgroundColor: '#0b0e14',
      icon: windowIconPath || undefined,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false,
        partition: 'persist:agent-' + providerId,
      },
    });
    bw.loadURL(url);
    bw.on('closed', () => { browserWins.delete(providerId); if (meetingWin && !meetingWin.isDestroyed()) { meetingWin.webContents.send('meeting:refreshWebview', providerId); } });
  }
  ipcMain.on('meeting:openBrowser', (_e, { providerId, url }) => openBrowserWindow(providerId, url));
  // [Bug3 补齐] 设置页「打开并登录」入口：按 providerId 复用 persist:agent-{id} 同分区，与会议窗口 cookie 互通
  ipcMain.on('meeting:openLogin', (_e, providerId) => {
    const m = AGENT_CATALOG.find((x) => x.id === providerId);
    if (!m) return;
    openBrowserWindow(m.id, m.url);
  });
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
    await startAgentRuntime; // 智能体运行时就绪（不阻塞转场，此处只确保已初始化）
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
  if (agentRuntime) { agentRuntime.stop().catch(() => {}); agentRuntime = null; }
  app.quit();
});

app.on('before-quit', () => {
  shuttingDown = true;
  killDshTree();
  if (agentRuntime) { agentRuntime.stop().catch(() => {}); agentRuntime = null; }
});

// macOS：点击 Dock 图标时窗口通常已重建；此处统一为关闭窗口即退出，无需单独处理。
