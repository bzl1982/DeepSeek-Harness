'use strict';
/**
 * adapters/generic-web.js —— 通用网页 AI profile（宽松匹配，best-effort）
 *
 * 覆盖：ChatGPT / Kimi / 豆包 / 通义 / 元宝 / Gemini / 文心 / 谷歌搜索
 *
 * 与客户端 agent/adapters/generic-web/index.js 一致：选择器宽松、失效时返回空、绝不抛错。
 * 后期哪家改版频繁，就从这里拆出专属 profile（如 doubao-web.js）。
 */

const profile = {
  assistant: [
    '[class*="markdown"]',
    '[class*="assistant"]',
    '[class*="message-content"]',
    '[class*="prose"]',
    '[data-message-author-role="assistant"]',
  ],
  composer: [
    'textarea',
    '[contenteditable="true"]',
    'div[role="textbox"]',
    '[class*="editor"]',
  ],
  send: [
    'button[class*="send"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="发送"]',
    'button[class*="submit"]',
    'button[data-testid*="send"]',
    'div[role="button"][class*="send"]',
  ],
  stop: [
    'button[aria-label*="stop" i]',
    'button[aria-label*="停止"]',
    'button[class*="stop"]',
    '[data-testid*="stop"]',
  ],
  generating: [
    '[class*="loading"]',
    '[class*="generating"]',
    '[class*="streaming"]',
    '[class*="typing"]',
  ],
  attachment: [
    '[class*="attachment"]',
    '[class*="file-card"]',
    '[class*="file-item"]',
    '[data-testid*="attachment"]',
  ],
};

module.exports = { id: 'generic-web', name: '通用网页版', profile };
