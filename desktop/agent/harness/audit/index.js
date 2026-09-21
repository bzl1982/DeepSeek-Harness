'use strict';
/**
 * harness/audit/index.js
 * JSONL 审计日志（PROTOCOL §7）。
 * 文件：harness/data/audit-<YYYY-MM-DD>.jsonl
 * 每条记录字段：ts / sessionId / provider / requestId / tool / arguments /
 *              requiredPermission / confirmation / dryRun / resultStatus / errorCode / durationMs
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');

function dateStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function tsIso(d = new Date()) {
  // 本地时间 ISO（带时区偏移）
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const offSign = off >= 0 ? '+' : '-';
  const offAbs = Math.abs(off);
  const offH = pad(Math.floor(offAbs / 60));
  const offM = pad(offAbs % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds())}${offSign}${offH}:${offM}`
  );
}

class AuditLog {
  constructor(dataDir = DATA_DIR) {
    this.dataDir = dataDir;
  }

  async ensureDir() {
    await fsp.mkdir(this.dataDir, { recursive: true });
  }

  /**
   * 追加一条审计记录。
   * @param {object} entry
   */
  async append(entry) {
    await this.ensureDir();
    const line = JSON.stringify({
      ts: tsIso(),
      sessionId: entry.sessionId || '',
      provider: entry.provider || '',
      requestId: entry.requestId || '',
      tool: entry.tool || '',
      arguments: entry.arguments || {},
      requiredPermission: entry.requiredPermission || '',
      confirmation: entry.confirmation || 'auto', // auto | approved | denied | timeout
      dryRun: !!entry.dryRun,
      resultStatus: entry.resultStatus || 'success', // success | error
      errorCode: entry.errorCode || null,
      durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : 0,
    });
    const file = path.join(this.dataDir, `audit-${dateStamp()}.jsonl`);
    await fsp.appendFile(file, line + '\n', 'utf8');
    return file;
  }

  /**
   * 读取指定会话的审计记录（GET /agent/audit 用）。
   * @param {string} sessionId
   * @returns {Promise<object[]>}
   */
  async readBySession(sessionId) {
    await this.ensureDir();
    const files = (await fsp.readdir(this.dataDir))
      .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
      .sort();
    const out = [];
    for (const f of files) {
      let raw;
      try {
        raw = await fsp.readFile(path.join(this.dataDir, f), 'utf8');
      } catch (e) {
        continue;
      }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (!sessionId || obj.sessionId === sessionId) out.push(obj);
        } catch (e) {
          // 坏行跳过
        }
      }
    }
    return out;
  }
}

module.exports = {
  AuditLog,
  DATA_DIR,
  dateStamp,
  tsIso,
};
