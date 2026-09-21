'use strict';
/**
 * browser/session/token.js —— 启动时生成本机鉴权 token（PROTOCOL.md §1）。
 * 不硬编码；每次启动生成随机 token，通过环境变量传给 Harness 子进程，
 * Browser 连接时放在 X-Agent-Token 头里。
 */

const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = { generateToken };
