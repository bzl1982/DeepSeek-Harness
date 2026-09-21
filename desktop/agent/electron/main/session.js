'use strict';
/**
 * electron/main/session.js —— AI 页面会话配置。
 * 用 partition: 'persist:agent' 持久化 Cookie / 登录态（PROTOCOL.md 技术栈硬约束）。
 * 在此统一配置该 session 的权限策略（最小权限，不主动放开危险能力）。
 */

const { session } = require('electron');

const PARTITION = 'persist:agent';

function configureAgentSession() {
  const ses = session.fromPartition(PARTITION);

  // 导航/权限最小化：不主动授予麦克风、摄像头、地理位置、通知等。
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    // 只允许自动播放（聊天站可能需要），其余拒绝
    cb(false);
  });
  ses.setPermissionCheckHandler(() => false);

  return ses;
}

module.exports = { configureAgentSession, PARTITION };
