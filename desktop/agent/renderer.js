'use strict';
/**
 * renderer.js —— 智能体窗口外壳 UI 逻辑（index.html）。
 * 只能用 window.shell（preload 白名单）与主进程通信，不碰 Node。
 *
 * [dsh-desktop 嵌入] 多 provider：从 query 读 provider id → 主进程取元数据 →
 * 设置 webview src / 名称徽标 / 登录按钮；主进程切模型事件触发重载。
 * 底部权限开关栏：Dry Run / Harness 状态 / 审计计数。
 */

const view = document.getElementById('view');
const urlInput = document.getElementById('url');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const dryRunEl = document.getElementById('dryrun');
const auditList = document.getElementById('audit-list');
const providerNameEl = document.getElementById('provider-name');
const loginBtn = document.getElementById('login');
const auditCountEl = document.getElementById('audit-count');
const sidebar = document.getElementById('sidebar');

let provider = null;
let auditCount = 0;

function setStatus(connected, text) {
  statusEl.className = connected ? 'on' : 'off';
  statusText.textContent = text;
}

function applyProvider(p) {
  if (!p) return;
  provider = p;
  providerNameEl.textContent = p.name || '网页版 AI';
  const target = p.url || 'https://chat.deepseek.com/';
  // 首次加载用 HTML src 属性触发（webContents attach 前 loadURL() 会被拒：
  // "The WebView must be attached to the DOM and the dom-ready event emitted..."）；
  // 已有 src 后才用 loadURL() 做导航切换。
  const currentSrc = view.getAttribute('src') || '';
  if (currentSrc !== target) {
    if (!currentSrc) {
      view.setAttribute('src', target);
    } else {
      view.loadURL(target);
    }
  }
  if (p.loginUrl && loginBtn) {
    loginBtn.style.display = '';
  }
}

// ---- 初始化：从 query 拿 provider id，向主进程要元数据 ----
// <webview> 标签在 HTML 解析后由 Blink 异步升级为 WebViewElement（带 loadURL）。
// renderer 脚本可能跑在升级之前，因此轮询等待它真正就绪（5s 超时兜底）。
function waitViewReady(timeoutMs) {
  return new Promise((resolve) => {
    if (view && typeof view.loadURL === 'function') return resolve();
    const timer = setInterval(() => {
      if (view && typeof view.loadURL === 'function') {
        clearInterval(timer);
        resolve();
      }
    }, 50);
    setTimeout(() => { clearInterval(timer); resolve(); }, timeoutMs || 5000);
  });
}

(async function init() {
  try {
    await waitViewReady(5000);
    if (!view || typeof view.loadURL !== 'function') {
      showFatal('webview 组件未注册（webviewTag 未生效）');
      return;
    }
    // 主动拉一次当前 Harness 状态（避免错过早期广播）
    if (typeof window.shell !== 'undefined' && window.shell.getStatus) {
      try {
        const s = await window.shell.getStatus();
        if (s) setStatus(!!s.connected, s.connected ? `Harness 已连接 · ${s.sessionId || ''} · ${s.dryRun ? 'DRY RUN' : 'REAL'}` : 'Harness 未连接');
      } catch (e) { /* ignore */ }
    }
    const params = new URLSearchParams(window.location.search);
    const providerId = params.get('provider') || 'deepseek-web';
    if (typeof window.shell !== 'undefined' && window.shell.getProvider) {
      const meta = await window.shell.getProvider(providerId);
      if (meta) applyProvider(meta);
    }
    if (!view.getAttribute('src')) {
      view.setAttribute('src', 'https://chat.deepseek.com/');
    }
  } catch (e) {
    showFatal('初始化失败: ' + (e && e.message ? e.message : String(e)));
  }
})();

// 白屏/加载失败时的显形提示，避免黑箱
function showFatal(msg) {
  let tip = document.getElementById('fatal-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'fatal-tip';
    tip.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#0e1116;color:#ff6b6b;font-size:14px;z-index:99;padding:24px;text-align:center;';
    document.getElementById('view-wrap').appendChild(tip);
  }
  tip.textContent = msg;
}

// webview 加载失败时显形错误
if (typeof view.addEventListener === 'function') {
  view.addEventListener('did-fail-load', (e) => {
    if (e.isMainFrame && e.errorCode !== -3) {
      showFatal('页面加载失败 [' + e.errorCode + ']: ' + (e.errorDescription || '') + ' — ' + (e.url || ''));
    }
  });
  view.addEventListener('did-fail-provisional-load', (e) => {
    showFatal('导航被拦截/失败 [' + e.errorCode + ']: ' + (e.errorDescription || ''));
  });
}

// ---- 导航按钮（直接操作 webview）----
document.getElementById('back').addEventListener('click', () => view.goBack());
document.getElementById('fwd').addEventListener('click', () => view.goForward());
document.getElementById('reload').addEventListener('click', () => view.reload());
document.getElementById('stop').addEventListener('click', () => view.stop());
document.getElementById('devtools').addEventListener('click', () => {
  if (typeof window.shell !== 'undefined' && window.shell.toggleDevTools) window.shell.toggleDevTools();
});

loginBtn.addEventListener('click', () => {
  const target = (provider && provider.loginUrl) || (provider && provider.url) || 'https://chat.deepseek.com/';
  view.loadURL(target);
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    let u = urlInput.value.trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    view.loadURL(u);
  }
});

// webview 导航事件 → 同步地址栏
view.addEventListener('did-navigate', (e) => { urlInput.value = e.url; });
view.addEventListener('did-navigate-in-page', (e) => { urlInput.value = e.url; });

// webview 就绪后，把它的 webContentsId 上报给主进程（用于回注结果 / 导航兜底）
view.addEventListener('dom-ready', () => {
  try {
    const id = view.getWebContentsId();
    if (typeof window.shell !== 'undefined' && window.shell.attachView) window.shell.attachView(id);
  } catch (e) { /* ignore */ }
});

// ---- Dry Run 开关（底部权限栏）----
dryRunEl.addEventListener('change', () => {
  if (typeof window.shell !== 'undefined' && window.shell.setDryRun) {
    window.shell.setDryRun(dryRunEl.checked);
  }
});

// ---- 审计侧栏 ----
auditCountEl.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});
document.getElementById('close-audit').addEventListener('click', () => {
  sidebar.classList.remove('open');
});

// ---- 主进程推送 ----
if (typeof window.shell !== 'undefined') {
  window.shell.onStatus((s) => {
    if (!s) return;
    if (s.connected) {
      setStatus(true, `Harness 已连接 · ${s.sessionId || ''} · ${s.dryRun ? 'DRY RUN' : 'REAL'}`);
    } else {
      setStatus(false, 'Harness 未连接');
    }
  });

  window.shell.onAudit((entry) => {
    if (!entry) return;
    auditCount += 1;
    auditCountEl.textContent = `审计 ${auditCount}`;
    const div = document.createElement('div');
    div.className = 'audit-item ' + (entry.resultStatus || 'pending');
    const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '';
    const tool = entry.tool || '?';
    const req = entry.requestId || '';
    const dry = entry.dryRun ? ' [DRY]' : '';
    const err = entry.errorCode ? ` · <span style="color:var(--err)">${escapeHtml(entry.errorCode)}</span>` : '';
    const note = entry.note ? `<div class="t">${escapeHtml(entry.note)}</div>` : '';
    div.innerHTML =
      `<div class="t">${ts} ${dry}</div>` +
      `<div class="tool">${escapeHtml(tool)}${err}</div>` +
      `<div class="t">${escapeHtml(String(req))}</div>` +
      note;
    auditList.insertBefore(div, auditList.firstChild);
  });

  // 主进程切模型：重新加载对应 URL
  window.shell.onSwitchProvider((p) => {
    applyProvider(p);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
