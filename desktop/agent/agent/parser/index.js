'use strict';
/**
 * agent/parser —— <agent> 块解析与去重（主路径 L2，见 PROTOCOL.md §8.1）。
 * 纯 Node 模块，复用 shared/protocol.js 的 extractAgentBlocks，不在此重写正则。
 * 按内容 hash 去重，同一聊天窗口内每个块只触发一次 tool.call。
 */

const Protocol = require('../../shared/protocol');

class AgentParser {
  constructor() {
    /** @type {Set<string>} 已触发块的内容 hash */
    this.seen = new Set();
  }

  /**
   * 解析一段文本，返回尚未触发过的 agent 块。
   * @param {string} text
   * @returns {Array<{tool:string, arguments:object, raw:string, hash:string}>}
   */
  parse(text) {
    const blocks = Protocol.extractAgentBlocks(text);
    const fresh = [];
    for (const block of blocks) {
      if (this.seen.has(block.hash)) continue;
      this.seen.add(block.hash);
      fresh.push(block);
    }
    return fresh;
  }

  /** 仅判断某个 hash 是否已经触发过，不记录。 */
  has(hash) {
    return this.seen.has(hash);
  }

  mark(hash) {
    if (hash) this.seen.add(hash);
  }

  reset() {
    this.seen.clear();
  }
}

module.exports = { AgentParser };
