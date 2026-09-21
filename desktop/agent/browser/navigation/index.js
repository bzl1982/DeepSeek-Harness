'use strict';
/**
 * browser/navigation —— 导航控制（后退/前进/刷新/停止/加载）。
 * 作用于 AI 页面的 webContents（主进程侧持有其引用）。
 * Electron 较新版本用 webContents.navigation 控制器，这里做兼容。
 */

function navOf(wc) {
  return (wc && wc.navigation) ? wc.navigation : null;
}

function goBack(wc) {
  if (!wc) return false;
  const n = navOf(wc);
  if (n) {
    if (n.canGoBack()) { n.goBack(); return true; }
    return false;
  }
  if (wc.canGoBack()) { wc.goBack(); return true; }
  return false;
}

function goForward(wc) {
  if (!wc) return false;
  const n = navOf(wc);
  if (n) {
    if (n.canGoForward()) { n.goForward(); return true; }
    return false;
  }
  if (wc.canGoForward()) { wc.goForward(); return true; }
  return false;
}

function reload(wc) {
  if (!wc) return false;
  try { wc.reload(); return true; } catch (e) { return false; }
}

function stop(wc) {
  if (!wc) return false;
  try { wc.stop(); return true; } catch (e) { return false; }
}

function loadURL(wc, url) {
  if (!wc || !url) return false;
  try { wc.loadURL(url); return true; } catch (e) { return false; }
}

/** 返回当前 URL 字符串（取不到返回空串） */
function currentURL(wc) {
  if (!wc) return '';
  try { return wc.getURL() || ''; } catch (e) { return ''; }
}

module.exports = { goBack, goForward, reload, stop, loadURL, currentURL };
