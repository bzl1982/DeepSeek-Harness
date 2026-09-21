'use strict';
/**
 * browser/page/agentPreload.js —— AI 页面（DeepSeek webview）的预加载脚本。
 *
 * 职责：
 *  1. 在页面里装 MutationObserver，监听 assistant 消息节点；
 *  2. 发现新增 <agent>{...}</agent> 块 → 去重 → 通过白名单 IPC 发给主进程；
 *  3. 把已触发的 <agent> 块替换成只读卡片「🔧 已请求工具: xxx」；
 *  4. 接收主进程回注的 tool.result，调用 DeepSeek adapter.injectResult 发回对话框。
 *
 * 安全：contextIsolation 下 preload 仍可直接用 ipcRenderer（Node 侧），
 * 页面世界只能通过 contextBridge 拿到白名单 window.agent。
 */

const { contextBridge, ipcRenderer } = require('electron');
// [dsh-desktop 嵌入] 按页面域名自动路由适配器：deepseek.com 走特化 adapter，其余走通用 adapter
const { adapterKeyForHost } = require('../../adapters/registry.js');
function resolveAdapter() {
  try {
    const key = adapterKeyForHost(window.location.hostname);
    if (key === 'deepseek-web') return require('../../adapters/deepseek-web/index.js');
  } catch (e) { /* 回退 generic */ }
  return require('../../adapters/generic-web/index.js');
}
const adapter = resolveAdapter();

// 本地去重（内容 hash），与主进程侧双重保险
const seenHashes = new Set();

/** 扫描一个节点，把其中的 <agent>...</agent> 替换成只读卡片 DOM */
function replaceAgentBlocks(node) {
  if (!node || !node.innerText) return;
  const re = /<agent>[\s\S]*?<\/agent>/gi;
  if (!re.test(node.innerText)) return;
  re.lastIndex = 0;

  // 最稳妥的做法：重建该节点文本，把 agent 块从纯文本里挖出来，
  // 用一个 <div class="agent-tool-card"> 占位。这里做 best-effort。
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const tn of textNodes) {
    const txt = tn.nodeValue || '';
    if (!/<agent>/.test(txt)) continue;
    // 尝试解析工具名；失败时显示原始内容前 120 字符，便于调试格式
    let toolName = 'unknown';
    let rawPreview = '';
    try {
      const m = txt.match(/<agent>\s*([\s\S]*?)\s*<\/agent>/i);
      if (m) {
        rawPreview = m[1].trim().slice(0, 120);
        const obj = JSON.parse(m[1].trim());
        toolName = obj.tool || obj.name || 'unknown';
      }
    } catch (e) {
      toolName = 'parse-error';
    }

    const card = document.createElement('div');
    card.className = 'agent-tool-card';
    card.setAttribute(
      'style',
      'display:inline-block;margin:6px 0;padding:4px 10px;border-radius:6px;' +
        'background:#2b6cb0;color:#fff;font-size:12px;font-family:monospace;',
    );
    card.textContent = `🔧 已请求工具: ${toolName}` + (rawPreview ? `  |  ${rawPreview}...` : '');

    const cleaned = txt.replace(/<agent>[\s\S]*?<\/agent>/gi, '');
    tn.nodeValue = cleaned;
    if (tn.parentNode) tn.parentNode.insertBefore(card, tn.nextSibling);
  }
}

/** 扫描所有 assistant 节点，触发检测与卡片替换 */
function scan() {
  let nodes = [];
  try {
    nodes = adapter.detectMessage();
  } catch (e) {
    return;
  }
  for (const node of nodes) {
    let blocks = [];
    try {
      blocks = adapter.detectToolCall(node);
    } catch (e) {
      blocks = [];
    }
    for (const block of blocks) {
      if (seenHashes.has(block.hash)) continue;
      seenHashes.add(block.hash);
      // 回调页面世界注册的 onToolCall
      if (typeof startObserver._externalCb === 'function') {
        try { startObserver._externalCb(block); } catch (e) { /* ignore */ }
      }
      try {
        ipcRenderer.send('agent:detected', {
          tool: block.tool,
          arguments: block.arguments,
          raw: block.raw,
          hash: block.hash,
        });
      } catch (e) { /* ignore */ }
    }
    // 把已触发的块替换成卡片
    try {
      replaceAgentBlocks(node);
    } catch (e) { /* ignore */ }
  }
}

function startObserver() {
  scan();
  const observer = new MutationObserver(() => {
    // 简单防抖
    if (startObserver._t) clearTimeout(startObserver._t);
    startObserver._t = setTimeout(scan, 200);
  });
  try {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch (e) { /* document.body 尚未就绪 */ }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObserver);
} else {
  startObserver();
}

// 主进程回注结果 → 调 adapter.injectResult
ipcRenderer.on('agent:injectResult', (_e, data) => {
  try {
    adapter.injectResult(data.toolCall, data.toolResult);
  } catch (e) { /* ignore */ }
});

ipcRenderer.on('agent:dispatched', () => {
  // 预留：工具已派发，可在此更新卡片状态
});

// 主进程注入系统提示 → 作为首条消息发送给 AI，告诉它工具清单和调用格式
ipcRenderer.on('agent:systemPrompt', (_e, data) => {
  try {
    if (data && data.text) adapter.sendUserMessage(data.text);
  } catch (e) { /* ignore */ }
});

// §11 白名单 window.agent（页面世界可用）
contextBridge.exposeInMainWorld('agent', {
  onToolCall: (cb) => {
    // 页面自身可注册回调；我们内部检测到块时也回调它
    startObserver._externalCb = cb;
  },
  sendResult: (toolResult) => {
    try {
      adapter.injectResult({ tool: '(manual)' }, toolResult);
    } catch (e) { /* ignore */ }
  },
  hello: () => ipcRenderer.send('agent:hello'),
  listTools: () => ipcRenderer.send('agent:listTools'),
});
