'use strict';
/**
 * adapters/deepseek-web —— DeepSeek Web DOM Adapter（PROTOCOL.md §12）。
 * 所有 DOM 选择器隔离在此文件；DeepSeek 改版只改这里。
 *
 * 本模块会在「页面/预加载」上下文里运行，函数直接使用全局 document/window，
 * 不依赖 Node。detectToolCall 复用 shared/protocol.js 的 extractAgentBlocks。
 *
 * 注意：DeepSeek 前端 class 是 hash 的，这里用「包含关键字」的宽松选择器，
 * 并在每一步做空值保护，选择器失效时函数返回 null/空数组而不抛错。
 */

/* eslint-disable no-undef */

// DOM 选择器集中维护区
const SELECTORS = {
  // 助手消息渲染后的 markdown 容器（DeepSeek 助手回复区）
  assistantMessage: '[class*="markdown"], [class*="assistant"], [class*="message-content"]',
  // 用户输入框：优先 textarea，其次 contenteditable
  userInput: 'textarea[class*="editor"], textarea, [contenteditable="true"]',
  // 发送按钮
  sendButton:
    'button[class*="send"], div[role="button"][class*="send"], button[aria-label*="send" i], button[class*="submit"]',
};

function safeQuery(sel, root) {
  try {
    return (root || document).querySelector(sel);
  } catch (e) {
    return null;
  }
}

function safeQueryAll(sel, root) {
  try {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  } catch (e) {
    return [];
  }
}

/**
 * detectMessage —— 从页面 DOM 找出助手消息节点。
 * @returns {HTMLElement[]}
 */
function detectMessage() {
  const nodes = safeQueryAll(SELECTORS.assistantMessage);
  // 过滤掉明显是用户输入区的节点
  return nodes.filter((n) => n && n.innerText && n.innerText.trim().length > 0);
}

/**
 * readAssistantMessage —— 读助手最新一条文本（L3 兜底用）。
 * @param {HTMLElement} [node]
 * @returns {string}
 */
function readAssistantMessage(node) {
  const target = node || detectMessage().slice(-1)[0];
  if (!target) return '';
  return (target.innerText || '').trim();
}

/**
 * sendUserMessage —— 向聊天框输入并发送一条消息（用于把工具结果喂回 AI）。
 * @param {string} text
 * @returns {boolean} 是否成功填入并触发发送
 */
function sendUserMessage(text) {
  if (!text) return false;
  const input = safeQuery(SELECTORS.userInput);
  if (!input) return false;

  input.focus();

  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    // 通过 setter + input 事件让 React/Vue 受控组件感知值变化
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) {
      setter.set.call(input, text);
    } else {
      input.value = text;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // contenteditable
    input.innerText = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  // 尝试点发送按钮
  const btn = safeQuery(SELECTORS.sendButton);
  if (btn) {
    setTimeout(() => btn.click(), 50);
    return true;
  }
  // 兜底：模拟回车发送
  try {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }),
    );
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * detectToolCall —— 在助手节点文本里找 <agent>{...}</agent> 块。
 * 纯文本提取，返回解析后的 tool.call payload 列表。
 * @param {HTMLElement} node
 * @returns {Array<{tool:string, arguments:object, raw:string, hash:string}>}
 */
function detectToolCall(node) {
  // 这里不能 require（页面上下文），由 preload 通过参数注入 parser 函数。
  // 保留纯字符串实现：与 shared/protocol.js 一致的正则，避免跨上下文 require。
  const text = node && node.innerText ? node.innerText : '';
  const out = [];
  const seen = new Set();

  // 统一从文本里提取所有 JSON 候选（tool/name 字段），宽松匹配多种格式：
  //   1) <agent>{...}</agent>
  //   2) ```json {...} ```
  //   3) 直接 {"tool":"...","arguments":{...}}
  function tryParse(raw) {
    raw = (raw || '').trim();
    if (!raw) return null;
    // 去掉 markdown 代码块包裹
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && (typeof obj.tool === 'string' || typeof obj.name === 'string')) {
        const tool = obj.tool || obj.name;
        const args = obj.arguments || obj.args || obj.inputs || {};
        return { tool, arguments: args, raw };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // 1) <agent>...</agent>
  const reAgent = /<agent>\s*([\s\S]*?)\s*<\/agent>/gi;
  let m;
  while ((m = reAgent.exec(text)) !== null) {
    const parsed = tryParse(m[1]);
    if (parsed) {
      const hash = 'h' + (function(r){let h=0;for(let i=0;i<r.length;i++)h=(h*31+r.charCodeAt(i))|0;return h;})(parsed.raw);
      if (!seen.has(hash)) { seen.add(hash); out.push({ tool: parsed.tool, arguments: parsed.arguments, raw: parsed.raw, hash }); }
    }
  }

  // 2) markdown 代码块 ```json ... ```
  const reCode = /```(?:json)?\s*([\s\S]*?)```/gi;
  while ((m = reCode.exec(text)) !== null) {
    const parsed = tryParse(m[1]);
    if (parsed) {
      const hash = 'h' + (function(r){let h=0;for(let i=0;i<r.length;i++)h=(h*31+r.charCodeAt(i))|0;return h;})(parsed.raw);
      if (!seen.has(hash)) { seen.add(hash); out.push({ tool: parsed.tool, arguments: parsed.arguments, raw: parsed.raw, hash }); }
    }
  }

  // 3) 直接找 {"tool":"...","arguments":{...}} 模式（兜底）
  const reJson = /\{[^{}]*"tool"\s*:\s*"[^"]+"[^{}]*\}/gi;
  while ((m = reJson.exec(text)) !== null) {
    const parsed = tryParse(m[0]);
    if (parsed) {
      const hash = 'h' + (function(r){let h=0;for(let i=0;i<r.length;i++)h=(h*31+r.charCodeAt(i))|0;return h;})(parsed.raw);
      if (!seen.has(hash)) { seen.add(hash); out.push({ tool: parsed.tool, arguments: parsed.arguments, raw: parsed.raw, hash }); }
    }
  }

  return out;
}

/**
 * injectResult —— 把工具结果作为一条消息发回 DeepSeek 对话，触发 AI 继续。
 * @param {{tool:string, arguments:object}} toolCall
 * @param {object} toolResult  tool.result 的 payload
 * @returns {boolean}
 */
function injectResult(toolCall, toolResult) {
  const lines = [];
  lines.push('[Agent 工具结果]');
  lines.push(`工具：${toolCall && toolCall.tool}`);
  const p = (toolResult && toolResult.payload) || toolResult || {};
  if (p.dryRun) lines.push('（Dry Run：未实际执行）');
  if (p.status === 'error') {
    const err = p.error || {};
    lines.push(`错误：${err.code || ''} ${err.message || ''}`);
  } else if (p.result != null) {
    let content = p.result;
    if (typeof content !== 'string') {
      try {
        content = JSON.stringify(content, null, 2);
      } catch (e) {
        content = String(content);
      }
    }
    if (content.length > 4000) content = content.slice(0, 4000) + '\n...(truncated)';
    lines.push('结果：');
    lines.push('```');
    lines.push(content);
    lines.push('```');
  }
  lines.push('请基于以上结果继续。');
  return sendUserMessage(lines.join('\n'));
}

module.exports = {
  SELECTORS,
  detectMessage,
  readAssistantMessage,
  sendUserMessage,
  detectToolCall,
  injectResult,
};
