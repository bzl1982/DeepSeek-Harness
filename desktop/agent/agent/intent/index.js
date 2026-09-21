'use strict';
/**
 * agent/intent —— L3 自然语言兜底（PROTOCOL.md §8）。
 * 第一阶段只做最简实现：把少量固定句式映射为 tool.call payload。
 * 命中不了就返回 null，调用方应静默忽略，不报错打扰用户。
 */

/**
 * @param {string} text 用户/助手文本
 * @returns {{tool:string, arguments:object}|null}
 */
function inferIntent(text) {
  if (!text || typeof text !== 'string') return null;

  // 提取一个 Windows/ POSIX 路径
  const pathMatch = text.match(/([A-Za-z]:[\\\/][^\s，。；；"']+)/);
  const path = pathMatch ? pathMatch[1] : null;

  const t = text.toLowerCase();

  // 列出目录
  if (/(查看|列出|浏览|打开|看看|list|ls|dir|目录结构|项目结构)/.test(t) && path) {
    return { tool: 'filesystem.list', arguments: { path } };
  }
  // 读文件
  if (/(读取|读一下|打开.*文件|看看.*内容|read|cat|查看.*内容)/.test(t) && path) {
    return { tool: 'filesystem.read', arguments: { path } };
  }
  // 搜索
  const queryMatch = text.match(/搜索[:：]?\s*([^\s，。]+)/);
  if (/(搜索|查找|search|find|grep)/.test(t) && path && queryMatch) {
    return { tool: 'filesystem.search', arguments: { root: path, query: queryMatch[1] } };
  }
  // git status
  if (/(git\s*status|当前分支|改了什么)/.test(t) && path) {
    return { tool: 'git.status', arguments: { cwd: path } };
  }
  // 执行命令
  const cmdMatch = text.match(/(?:执行|运行|run|exec|shell)[:：]?\s*["']?([^"'\n，。]+)["']?/);
  if (/(执行命令|运行命令|shell|exec)/.test(t) && cmdMatch) {
    return { tool: 'shell.exec', arguments: { command: cmdMatch[1].trim() } };
  }

  return null;
}

module.exports = { inferIntent };
