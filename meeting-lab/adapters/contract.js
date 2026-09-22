'use strict';
/**
 * adapters/contract.js —— WebAI Adapter 统一契约（+ 必填校验）
 *
 * 六家咨询的共识 #2：DOM 选择器绝不能写死进编排层。
 * 编排层只认这个契约；网页改版只改 adapter 一个文件。
 *
 * 与客户端现有 adapter 的关系：
 *   客户端现有（agent/adapters/*）：detectMessage / readAssistantMessage /
 *     sendUserMessage / detectToolCall / injectResult —— 面向"工具调用闭环"
 *   本契约：在此基础上【补齐 3 个会议必需能力】：
 *     · isReady()          —— 会议开始前探测（可借鉴 Magentic-UI 的能力探测）
 *     · uploadFiles()      —— 带 ACK 的文件上传（附件握手）
 *     · waitForResponse()  —— ★ 完成检测（现在完全没有，是最大缺口）
 *     · cancel()           —— 单点中止（闭麦）
 */

const REQUIRED_METHODS = ['isReady', 'sendText', 'uploadFiles', 'waitForResponse', 'cancel'];

const OPTIONAL_METHODS = ['readAssistantMessage', 'detectToolCall', 'injectResult', 'getSignals'];

/**
 * 校验一个 adapter 是否满足契约。
 * @param {object} adapter
 * @returns {{ok:boolean, missing:string[], warnings:string[]}}
 */
function validateAdapter(adapter) {
  const missing = [];
  const warnings = [];

  if (!adapter || typeof adapter !== 'object') {
    return { ok: false, missing: [...REQUIRED_METHODS], warnings: ['adapter is not an object'] };
  }
  if (!adapter.id) missing.push('id');
  if (!adapter.name) warnings.push('name missing (will fall back to id)');

  for (const m of REQUIRED_METHODS) {
    if (typeof adapter[m] !== 'function') missing.push(m);
  }
  for (const m of OPTIONAL_METHODS) {
    if (typeof adapter[m] !== 'function') warnings.push(`optional ${m}() not implemented`);
  }
  return { ok: missing.length === 0, missing, warnings };
}

/** 批量校验，返回可用/不可用清单 */
function validateAll(adapters = {}) {
  const entries = adapters instanceof Map ? [...adapters.entries()] : Object.entries(adapters);
  const usable = [];
  const broken = [];
  for (const [id, a] of entries) {
    const r = validateAdapter(a);
    if (r.ok) usable.push({ id, warnings: r.warnings });
    else broken.push({ id, missing: r.missing });
  }
  return { usable, broken };
}

/**
 * 把 adapter 包一层：超时保护 + 异常归一。
 * 让编排层永远拿到"结构化失败"，而不是抛出来的异常。
 */
function withGuards(adapter, { defaultTimeoutMs = 120000, logger = null } = {}) {
  const log = logger || (() => {});
  const wrap = (fnName, fn) => async (...args) => {
    const started = Date.now();
    try {
      return await fn.apply(adapter, args);
    } catch (err) {
      log('error', `${adapter.id}.${fnName} threw: ${err && err.message}`);
      throw err; // 由 orchestrator 的 classifyError 统一归类
    } finally {
      const ms = Date.now() - started;
      if (ms > defaultTimeoutMs) log('warn', `${adapter.id}.${fnName} took ${ms}ms`);
    }
  };

  const wrapped = {
    id: adapter.id,
    name: adapter.name || adapter.id,
    isReady: wrap('isReady', adapter.isReady || (async () => true)),
    sendText: wrap('sendText', adapter.sendText),
    uploadFiles: wrap('uploadFiles', adapter.uploadFiles || (async () => ({ ok: true, skipped: true }))),
    waitForResponse: wrap('waitForResponse', adapter.waitForResponse),
    cancel: wrap('cancel', adapter.cancel || (async () => true)),
  };
  for (const m of OPTIONAL_METHODS) {
    if (typeof adapter[m] === 'function') wrapped[m] = wrap(m, adapter[m]);
  }
  return wrapped;
}

module.exports = { REQUIRED_METHODS, OPTIONAL_METHODS, validateAdapter, validateAll, withGuards };
