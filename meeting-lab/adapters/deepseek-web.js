'use strict';
/**
 * adapters/deepseek-web.js —— DeepSeek 网页版 profile（特化）
 *
 * 与客户端现有 agent/adapters/deepseek-web/index.js 同源思路：
 * 选择器全部隔离在这一个文件里，DeepSeek 改版只改这里。
 */

const profile = {
  // 回答容器（取最后一条即为最新回答）
  assistant: [
    '[class*="ds-markdown"]',
    '[class*="markdown"]',
    '[class*="message"] [class*="content"]',
  ],
  // 输入框
  composer: [
    'textarea#chat-input',
    'textarea[placeholder]',
    'textarea',
    '[contenteditable="true"]',
  ],
  // 发送按钮
  send: [
    'div[class*="send"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
  ],
  // "生成中/停止生成"（存在 = 还在答）
  stop: [
    'div[class*="stop"]',
    'button[aria-label*="停止"]',
    'button[aria-label*="Stop"]',
  ],
  generating: [
    '[class*="loading"]',
    '[class*="generating"]',
    '[class*="typing"]',
  ],
  // 附件卡片（上传成功的判据）
  attachment: [
    '[class*="file-card"]',
    '[class*="attachment"]',
    '[class*="upload"] [class*="item"]',
  ],
};

module.exports = { id: 'deepseek-web', name: '深度求索-DeepSeek', profile };
