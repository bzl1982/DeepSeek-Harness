'use strict';
/**
 * browser/page/controller.js —— 管理 AI 页面（webview）的 webContents 引用，
 * 负责把 Harness 的 tool.result 回注到页面（Runtime→AI 闭环方向）。
 */

const { webContents } = require('electron');

class PageController {
  constructor() {
    /** @type {number|null} */
    this.wcId = null;
  }

  /** 由 renderer 在 webview dom-ready 后上报 webContentsId */
  attach(wcId) {
    this.wcId = wcId;
  }

  getWebContents() {
    if (!this.wcId) return null;
    try {
      return webContents.fromId(this.wcId);
    } catch (e) {
      return null;
    }
  }

  /**
   * 把工具结果注入页面，由页面侧 preload 调用 DeepSeek adapter.injectResult。
   * @param {string} requestId
   * @param {{tool:string, arguments:object}} toolCall
   * @param {object} toolResult
   */
  injectResult(requestId, toolCall, toolResult) {
    const wc = this.getWebContents();
    if (!wc) return false;
    try {
      wc.send('agent:injectResult', { requestId, toolCall, toolResult });
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 通知页面 preload 该 tool.call 已被接受（用于更新卡片状态） */
  notifyDispatched(requestId, tool) {
    const wc = this.getWebContents();
    if (!wc) return false;
    try {
      wc.send('agent:dispatched', { requestId, tool });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 向 AI 页面注入一段系统提示（作为首条用户消息发送），告诉它有哪些工具、怎么调用。
   * @param {string} text
   */
  sendSystemPrompt(text) {
    const wc = this.getWebContents();
    if (!wc) return false;
    try {
      wc.send('agent:systemPrompt', { text });
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = { PageController };
