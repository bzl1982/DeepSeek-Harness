'use strict';
/**
 * shell/cdp-driver.js —— CDP 网络监听参考实现（Phase 1 可直接搬进客户端）
 *
 * ============================================================================
 * 这个文件解决的是「文档承诺了 streamEnd 但一直没接」的最后一公里。
 *
 * 为什么必须是 CDP，而不是再写一个 DOM 探针？
 *   因为 streamEnd 的全部价值就在于【不依赖 DOM】：
 *   网页改版、Shadow DOM、iframe 嵌套、类名混淆 —— DOM 信号全瞎，
 *   只有网络层知道"服务器还在吐字吗"。
 *
 * 客户端已有能力（无需新增权限）：
 *   meeting.html:466  wv.debugger.isAttached()
 *   meeting.html:467  wv.debugger.attach('1.3')
 *   meeting.html:489  wv.debugger.sendCommand('DOM.setFileInputFiles', ...)
 *   → 同一个 debugger 会话，再开 Network 域即可，零额外授权。
 * ============================================================================
 */

/**
 * 给一个 webview 元素挂上 Network 域监听。
 *
 * @param {object} wv            <webview> 元素（渲染进程里可直接用）
 * @param {function} onEvent     (method, params) => void   —— 直接喂给 StreamTracker
 * @param {object} opts
 *   - maxBodyBytes  不抓响应体（这里只关心"流有没有在动"，不解析内容）
 * @returns {Promise<function>}  detach 函数（幂等）
 *
 * ★ 关键点（照抄时特别注意）：
 *   1) 必须先 attach 再 enable Network，顺序反了拿不到事件
 *   2) enable 时要给 maxTotalBufferSize，否则长回答会撑爆 CDP 缓冲区
 *      → 我们只需要事件不需要 body，所以给一个保守值即可
 *   3) detach 时务必 removeListener，否则 9 个 webview 长会会累积泄漏
 *   4) isAttached() 判断必不可少：debugger 是单会话资源，
 *      文件上传已经 attach 过，重复 attach 会抛 "Another debugger is already attached"
 */
async function attachNetwork(wv, onEvent, { maxTotalBufferSize = 10 * 1024 * 1024 } = {}) {
  if (!wv || !wv.debugger) {
    throw new Error('attachNetwork: 该 webview 没有 debugger 能力');
  }

  // ---- 1) 确保已 attach（与文件上传共用同一个会话）----
  if (!wv.debugger.isAttached()) {
    wv.debugger.attach('1.3');
    // attach 是异步生效的，给它一点时间，否则紧跟的 enable 会报 not attached
    await new Promise((r) => setTimeout(r, 300));
  }

  // ---- 2) 事件转发 ----
  // Electron 的签名是 (event, method, params)
  const listener = (_event, method, params) => {
    if (!method || !method.startsWith('Network.')) return;
    try {
      onEvent(method, params || {});
    } catch (e) {
      /* 观察者异常绝不能影响页面 */
    }
  };
  wv.debugger.on('message', listener);

  // ---- 3) 开 Network 域 ----
  try {
    await wv.debugger.sendCommand('Network.enable', {
      maxTotalBufferSize,
      maxResourceBufferSize: 1024 * 1024,
    });
  } catch (e) {
    wv.debugger.removeListener('message', listener);
    throw e;
  }

  // ---- 4) 返回幂等的 detach ----
  let detached = false;
  return function detach() {
    if (detached) return;
    detached = true;
    try { wv.debugger.removeListener('message', listener); } catch (e) { /* ignore */ }
    try { wv.debugger.sendCommand('Network.disable').catch(() => {}); } catch (e) { /* ignore */ }
    // ★ 注意：这里【不】detach debugger 本身 ——
    //   文件上传（DOM.setFileInputFiles）还要继续用同一个会话。
    //   把 debugger 的 attach/detach 生命周期交给上传逻辑统一管理，
    //   两处各自 detach 会互相踩（典型症状：上传突然开始失败）。
  };
}

module.exports = { attachNetwork };
