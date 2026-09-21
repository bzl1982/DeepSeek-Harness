'use strict';
/**
 * adapters/generic-web/index.js —— 通用网页 AI DOM Adapter。
 *
 * 用于未特化适配的网页版模型（ChatGPT / Kimi / 豆包 / 通义 / 元宝 / Gemini 等）。
 * 与 deepseek-web 相同的接口契约，但选择器更宽松、全部 best-effort：
 *   - detectMessage:        宽松匹配 markdown/assistant/message 容器
 *   - readAssistantMessage: 读最新一条助手文本
 *   - sendUserMessage:      找 textarea/contenteditable + 发送按钮/回车兜底
 *   - detectToolCall:       <agent>{...}</agent> 纯文本提取（与 deepseek-web 一致）
 *   - injectResult:         把工具结果格式化为消息发回对话框
 *
 * 选择器失效时一律返回空/失败，绝不抛错。
 */

/* eslint-disable no-undef */

const SELECTORS = {
  assistantMessage:
    '[class*="markdown"], [class*="assistant"], [class*="message-content"], [class*="prose"], [data-message-author-role="assistant"]',
  userInput:
    'textarea, [contenteditable="true"], div[role="textbox"], [class*="editor"]',
  sendButton:
    'button[class*="send"], button[aria-label*="send" i], button[class*="submit"], button[data-testid*="send"], div[role="button"][class*="send"]',
};

function safeQuery(sel, root) {
  try { return (root || document).querySelector(sel); } catch (e) { return null; }
}
function safeQueryAll(sel, root) {
  try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; }
}

function detectMessage() {
  const nodes = safeQueryAll(SELECTORS.assistantMessage);
  return nodes.filter((n) => n && n.innerText && n.innerText.trim().length > 0);
}

function readAssistantMessage(node) {
  const target = node || detectMessage().slice(-1)[0];
  if (!target) return '';
  return (target.innerText || '').trim();
}

function sendUserMessage(text) {
  if (!text) return false;
  const input = safeQuery(SELECTORS.userInput);
  if (!input) return false;

  input.focus();
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    input.innerText = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  const btn = safeQuery(SELECTORS.sendButton);
  if (btn) {
    setTimeout(() => btn.click(), 50);
    return true;
  }
  try {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }),
    );
    return true;
  } catch (e) {
    return false;
  }
}

function detectToolCall(node) {
  const text = node && node.innerText ? node.innerText : '';
  const re = /<agent>\s*([\s\S]*?)\s*<\/agent>/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    if (parsed && typeof parsed.tool === 'string' && typeof parsed.arguments === 'object') {
      let hash = 0;
      for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0;
      out.push({ tool: parsed.tool, arguments: parsed.arguments || {}, raw, hash: `h${hash}` });
    }
  }
  return out;
}

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
      try { content = JSON.stringify(content, null, 2); } catch (e) { content = String(content); }
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
