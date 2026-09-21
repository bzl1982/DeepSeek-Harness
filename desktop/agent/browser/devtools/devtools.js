'use strict';
/**
 * browser/devtools —— DevTools 开关。
 */

function openDevTools(wc) {
  if (!wc) return false;
  try {
    if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
    return true;
  } catch (e) {
    return false;
  }
}

function closeDevTools(wc) {
  if (!wc) return false;
  try {
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    return true;
  } catch (e) {
    return false;
  }
}

function toggleDevTools(wc) {
  if (!wc) return false;
  try {
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { openDevTools, closeDevTools, toggleDevTools };
