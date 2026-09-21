'use strict';
/**
 * harness/permissions/index.js
 * 权限引擎 + 确认队列（PROTOCOL §4 / §3.6）。
 *
 * PermissionEngine.decide(toolName, toolDef, args) 返回决策：
 *   { decision: 'auto' | 'confirm' | 'deny',
 *     requiredPermission: 'READ'|'WRITE'|'EXECUTE'|'ADMIN',
 *     reason: string }
 *
 *   - READ  → auto
 *   - WRITE / EXECUTE → confirm
 *   - ADMIN → confirm（默认拒绝由调用方在超时/deny 时落实）
 *   - shell.exec 命中 hazard 黑名单 → 升级为 ADMIN
 *
 * ConfirmationQueue：
 *   - create({ tool, arguments, requiredPermission, reason, ttlMs }) → { confirmationId, promise }
 *     promise resolve('approve') / resolve('deny')；超时 reject(Error CONFIRMATION_TIMEOUT)
 *   - respond(confirmationId, decision) → boolean（是否命中了一个 pending）
 */

const Protocol = require('../../shared/protocol');
const hazard = require('../tools/shell/hazard');

const { PERMISSION } = Protocol;

class PermissionEngine {
  /**
   * @param {string} toolName
   * @param {{permission:string}} toolDef
   * @param {object} args
   */
  decide(toolName, toolDef, args) {
    let permission = toolDef.permission;
    let reason = '';

    // shell.exec 危险命令升级
    if (toolName === 'shell.exec' && args && typeof args.command === 'string') {
      const h = hazard.inspect(args.command);
      if (h.hit) {
        permission = PERMISSION.ADMIN;
        reason = `命中危险命令规则：${h.reason}`;
      }
    }

    if (permission === PERMISSION.READ) {
      return { decision: 'auto', requiredPermission: PERMISSION.READ, reason: 'READ 自动放行' };
    }
    if (permission === PERMISSION.WRITE) {
      return { decision: 'confirm', requiredPermission: PERMISSION.WRITE, reason: reason || 'WRITE 需要用户确认' };
    }
    if (permission === PERMISSION.EXECUTE) {
      return { decision: 'confirm', requiredPermission: PERMISSION.EXECUTE, reason: reason || 'EXECUTE 需要用户确认' };
    }
    if (permission === PERMISSION.ADMIN) {
      return { decision: 'confirm', requiredPermission: PERMISSION.ADMIN, reason: reason || 'ADMIN 必须二次确认，默认拒绝' };
    }
    // NETWORK 第一阶段不暴露，落到这里按拒绝处理
    return { decision: 'deny', requiredPermission: permission, reason: `权限等级 ${permission} 第一阶段未开放` };
  }
}

class ConfirmationQueue {
  constructor() {
    /** @type {Map<string, {resolve:Function, reject:Function, timer:NodeJS.Timeout, info:object}>} */
    this.pending = new Map();
  }

  create(info) {
    const confirmationId = Protocol.nextConfirmationId();
    const ttlMs = Number.isInteger(info.ttlMs) && info.ttlMs > 0 ? info.ttlMs : 60000;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(confirmationId)) {
          this.pending.delete(confirmationId);
          const e = new Error('CONFIRMATION_TIMEOUT');
          e.toolError = 'CONFIRMATION_TIMEOUT';
          reject(e);
        }
      }, ttlMs);
      this.pending.set(confirmationId, { resolve, reject, timer, info });
    });
    return { confirmationId, promise };
  }

  respond(confirmationId, decision) {
    const item = this.pending.get(confirmationId);
    if (!item) return false;
    this.pending.delete(confirmationId);
    clearTimeout(item.timer);
    if (decision === 'approve') {
      item.resolve('approve');
    } else {
      item.resolve('deny');
    }
    return true;
  }

  size() {
    return this.pending.size;
  }
}

module.exports = {
  PermissionEngine,
  ConfirmationQueue,
};
