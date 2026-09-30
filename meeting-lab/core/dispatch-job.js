'use strict';
/**
 * core/dispatch-job.js —— 人工咨询「分发半」任务契约（规范 V1 §4）
 *
 * 三条 L 级契约（第 6 轮终审冻结，缺一不可）：
 *   C1  READY Gate = 不可变分发快照
 *       snapshot { version, contentHash, createdAt, text, attachments } —— Object.freeze；
 *       DispatchJob 只执行快照；READY 后改稿 = 新快照。
 *       杜绝"9 席回答的不是同一份问题"（ChatGPT 第 6 轮）。
 *
 *   C2  L1/L2/L3 逐席幂等
 *       per-seat { status, attempt, delivered, transport }；
 *       重试只处理 failed 席位，【已 delivered 席位绝不重发】——
 *       降级链是"降级"不是"重跑"（ChatGPT 第 6 轮）。
 *
 *   C3  持久化
 *       serialize() / deserialize() —— dispatchTrack 落盘（Electron store），
 *       应用崩溃/重启后可恢复续传，进行中状态不静默丢失（元宝 第 6 轮）。
 *
 * 本模块是纯逻辑（无 Electron 依赖），UI/编排层只通过这里的 API 操作状态。
 */

const crypto = require('crypto');

const SEAT_STATUS = {
  PENDING: 'pending',   // 待发
  SENDING: 'sending',   // 发送中（attempt 已 +1）
  SENT: 'sent',         // 已发且确认送达（delivered=true）
  FAILED: 'failed',     // 发送失败（可重试，只重试这个）
};

const TRANSPORT = {
  L1: 'L1-cdp',         // CDP setFileInputFiles / insertText 自动投递
  L2: 'L2-copy',        // 自动复制到剪贴板 + 模拟点击文件框（用户 1 次确认）
  L3: 'L3-manual',      // 逐席复制按钮，用户全手动
};

// 失败最多自动重试三次；超过上限必须人工确认，避免网络故障造成重复发送。
const MAX_ATTEMPTS = 3;

/** 内容哈希（快照完整性校验用；截断 16 位够防碰撞） */
function contentHash(text, attachments) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ text, attachments }))
    .digest('hex')
    .slice(0, 16);
}

/* ══════════════════════════════════════════════════════════════
   C1 —— 不可变分发快照
   ══════════════════════════════════════════════════════════════ */

/**
 * 生成 READY 快照。text 非空才允许 READY（空稿 READY 是非法状态）。
 * 返回深度冻结对象：调用方改不进去，只能换新快照。
 */
function createSnapshot({ text, attachments = [], readyAt } = {}) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) throw new Error('[dispatch] READY 需要非空咨询稿（空稿不允许进入分发）');
  const atts = (Array.isArray(attachments) ? attachments : []).map((a) => Object.freeze({ ...a }));
  return Object.freeze({
    version: 1,
    contentHash: contentHash(t, atts),
    createdAt: readyAt || new Date().toISOString(),
    text: t,
    attachments: Object.freeze(atts),
  });
}

/** 校验快照完整性：hash 与内容不符 = 快照被事后篡改，直接抛错 */
function assertSnapshotIntegrity(snapshot) {
  const actual = contentHash(snapshot.text, snapshot.attachments);
  if (actual !== snapshot.contentHash) {
    throw new Error(`[dispatch] 快照完整性校验失败（hash ${snapshot.contentHash} ≠ 实际 ${actual}）——禁止分发被篡改的稿子`);
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════
   DispatchJob
   ══════════════════════════════════════════════════════════════ */

/**
 * 创建分发任务。snapshot 必须来自 createSnapshot（带 contentHash）。
 * seats: string[]（席位 id 列表）。
 */
function createDispatchJob({ snapshot, seats, jobId, clock } = {}) {
  if (!snapshot || !snapshot.contentHash) throw new Error('[dispatch] 必须提供 createSnapshot 产出的快照');
  assertSnapshotIntegrity(snapshot);
  if (!Array.isArray(seats) || seats.length === 0) throw new Error('[dispatch] seats 不能为空');
  if (new Set(seats).size !== seats.length) throw new Error('[dispatch] seats 有重复项');

  const seatMap = new Map();
  for (const id of seats) {
    seatMap.set(id, {
      seatId: id,
      status: SEAT_STATUS.PENDING,
      attempt: 0,
      delivered: false,
      transport: null,     // 最终成功走的是哪条通道
      error: null,         // 最近一次失败原因
      sentAt: null,
    });
  }

  return {
    jobId: jobId || `dispatch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    snapshot,
    seats: seatMap,
    createdAt: (clock && clock.now) ? new Date(clock.now()).toISOString() : new Date().toISOString(),
  };
}

/** 取单席状态（不存在则抛错，防拼错 id 静默产生脏数据） */
function seatOf(job, seatId) {
  const s = job.seats.get(seatId);
  if (!s) throw new Error(`[dispatch] 未知席位: ${seatId}`);
  return s;
}

/**
 * 标记开始发送（attempt +1）。
 * C2 幂等守卫：已 delivered 的席位拒绝再发；正在 sending 的拒绝并发重入。
 */
function markSending(job, seatId, { transport = TRANSPORT.L1 } = {}) {
  const s = seatOf(job, seatId);
  if (s.delivered || s.status === SEAT_STATUS.SENT) {
    return { ok: false, reason: 'already_delivered', seat: s };
  }
  if (s.status === SEAT_STATUS.SENDING) {
    return { ok: false, reason: 'already_sending', seat: s };
  }
  if (s.attempt >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'attempt_limit', seat: s };
  }
  s.status = SEAT_STATUS.SENDING;
  s.attempt += 1;
  s.transport = transport;
  s.error = null;
  return { ok: true, seat: s };
}

/**
 * 标记发送成功。
 * C2：幂等——重复确认同一个 delivered 席位不产生任何副作用，返回 already。
 */
function markSent(job, seatId, { transport } = {}) {
  const s = seatOf(job, seatId);
  if (s.delivered) return { ok: false, reason: 'already_delivered', seat: s };
  s.status = SEAT_STATUS.SENT;
  s.delivered = true;
  if (transport) s.transport = transport;
  s.sentAt = new Date().toISOString();
  s.error = null;
  return { ok: true, seat: s };
}

/** 标记发送失败（可重试）。error 记录原因，供 L2/L3 兜底展示。 */
function markFailed(job, seatId, { error = 'UNKNOWN' } = {}) {
  const s = seatOf(job, seatId);
  if (s.delivered) return { ok: false, reason: 'already_delivered', seat: s };
  s.status = SEAT_STATUS.FAILED;
  s.error = String(error);
  return { ok: true, seat: s };
}

/** C2 核心：重试目标 = 恰好是 failed 的席位。pending/sending/sent 永不出现在重试名单。 */
function retryTargets(job) {
  const out = [];
  for (const s of job.seats.values()) {
    if (s.status === SEAT_STATUS.FAILED) out.push(s.seatId);
  }
  return out;
}

/** 待发席位（未动过的） */
function pendingTargets(job) {
  const out = [];
  for (const s of job.seats.values()) {
    if (s.status === SEAT_STATUS.PENDING) out.push(s.seatId);
  }
  return out;
}

/** 进度汇总（UI 摘要行 28px 直接渲染这个） */
function progress(job) {
  let sent = 0, failed = 0, pending = 0, sending = 0;
  for (const s of job.seats.values()) {
    if (s.delivered) sent += 1;
    else if (s.status === SEAT_STATUS.FAILED) failed += 1;
    else if (s.status === SEAT_STATUS.SENDING) sending += 1;
    else pending += 1;
  }
  return { total: job.seats.size, sent, failed, pending, sending };
}

/** 失败席位显式点名（§0.3 契约：绝不把缺席写成"无意见"） */
function failedSeats(job) {
  const out = [];
  for (const s of job.seats.values()) {
    if (s.status === SEAT_STATUS.FAILED) out.push({ seatId: s.seatId, error: s.error, attempt: s.attempt });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════
   C3 —— 持久化（崩溃恢复续传）
   ══════════════════════════════════════════════════════════════ */

/** 序列化为纯 JSON（可写入 Electron store / localStorage / 文件） */
function serialize(job) {
  return {
    formatVersion: 1,
    jobId: job.jobId,
    createdAt: job.createdAt,
    snapshot: {
      version: job.snapshot.version,
      contentHash: job.snapshot.contentHash,
      createdAt: job.snapshot.createdAt,
      text: job.snapshot.text,
      attachments: job.snapshot.attachments.map((a) => ({ ...a })),
    },
    seats: [...job.seats.values()].map((s) => ({ ...s })),
  };
}

/**
 * 从 JSON 恢复。
 * 恢复时重跑快照完整性校验（C1）：落盘后稿子被改过 → 拒绝恢复并抛错，
 * 宁可不续传也不能把篡改后的稿子接着发。
 */
function deserialize(data) {
  if (!data || data.formatVersion !== 1) throw new Error('[dispatch] 持久化数据格式不认识（formatVersion）');
  const snapshot = createSnapshot({
    text: data.snapshot.text,
    attachments: data.snapshot.attachments,
    readyAt: data.snapshot.createdAt,
  });
  // 落盘的 hash 必须与按内容重算的一致
  if (snapshot.contentHash !== data.snapshot.contentHash) {
    throw new Error('[dispatch] 恢复失败：落盘快照与内容 hash 不一致（稿子被篡改），拒绝续传');
  }
  const job = createDispatchJob({ snapshot, seats: data.seats.map((s) => s.seatId), jobId: data.jobId });
  // 崩溃时进程不可能可靠地完成发送确认；恢复后把 sending 变成 failed，允许受控重试。
  // 已 delivered 的席位仍绝不重发。
  for (const s of data.seats) {
    const target = job.seats.get(s.seatId);
    target.status = s.status === SEAT_STATUS.SENDING ? SEAT_STATUS.FAILED : s.status;
    target.attempt = s.attempt;
    target.delivered = s.delivered;
    target.transport = s.transport;
    target.error = s.status === SEAT_STATUS.SENDING
      ? '应用在发送确认前中断，需人工确认后重试'
      : s.error;
    target.sentAt = s.sentAt;
  }
  return job;
}

module.exports = {
  SEAT_STATUS,
  TRANSPORT,
  contentHash,
  createSnapshot,
  assertSnapshotIntegrity,
  createDispatchJob,
  markSending,
  markSent,
  markFailed,
  retryTargets,
  pendingTargets,
  MAX_ATTEMPTS,
  progress,
  failedSeats,
  serialize,
  deserialize,
};
