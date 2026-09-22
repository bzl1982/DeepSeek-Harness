'use strict';
/**
 * adapters/api-adapter.js —— API 通道适配器（「双管齐下」的另一路）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须有这一路？（这是选型结论，不是"顺便支持一下"）
 *
 *   网页版 webview 的**根本弱点**：完成检测靠猜。
 *   你得靠 CDP 探网络流、靠 DOM 稳不稳、靠轮询时长来判断"它答完了吗"。
 *   于是就有了我们已经实测到的两类事故：1 秒假完成、长回复只抓到首字。
 *
 *   API 通道**没有这个问题**：SSE 流结束就是答完了，这是协议级事实，
 *   不是启发式判断。所以：
 *
 *     · 需要"快、稳、可编程"的席位（主席 / 书记员 / 判停 / 轮纪要）
 *       → 走 API 通道
 *     · 需要"免费、能联网、9 个格子可视化"的席位
 *       → 走网页版通道
 *
 *   两者**同一套契约**，编排层完全看不出差别 → 这就是双管齐下。
 *
 * ★ 契约对齐（与 adapters/web-adapter.js 一致，见 adapters/contract.js）：
 *     id / name / channel
 *     isReady()                        → boolean
 *     uploadFiles(attachments,{onAck}) → { ok, failed[] }    （API 场景为"准备 ACK"）
 *     sendText(text)                   → { ok }
 *     waitForResponse({detector,timeoutMs}) → { text, completion, stream }
 *     cancel()                         → boolean
 * ─────────────────────────────────────────────────────────────────────
 *
 * ★ 密钥安全：apiKey 只存在闭包内，绝不进日志。log 里只出现 provider:model 名。
 */

const fs = require('fs');
const path = require('path');
const { loadProviders, getProvider } = require('./dsh-config');

/** 可以被"内联进 prompt"的文本类扩展名（API 无法传真文件时的降级路径） */
const INLINE_TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yml', '.yaml', '.xml', '.srt',
]);
/** 可以走 data URL 内联的图片扩展名（多模态能力） */
const INLINE_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

/** 单文件内联上限（超过就不塞 prompt 了，避免请求体炸掉） */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

/**
 * 创建 API 适配器。
 *
 * @param {object} opts
 *   - providerKey  'deepseek' | 'agne' | 'google' | ...
 *   - model        模型 id（不传则取该提供方第一个）
 *   - id           adapter 标识（会议里的席位名，默认 `api:${providerKey}`）
 *   - name         显示名
 *   - configDir    覆盖 .dsh 目录（测试用）
 *   - apiKey/baseURL  显式覆盖（测试用；生产走 dsh-config）
 *   - logger       ({level,msg,data}) => void
 *   - temperature / maxTokens
 */
function createApiAdapter({
  providerKey,
  model = null,
  id = null,
  name = null,
  configDir = null,
  apiKey = null,
  baseURL = null,
  logger = null,
  temperature = null,
  maxTokens = null,
} = {}) {
  const log = logger || (() => {});

  // ── 解析配置（密钥只在闭包里）──
  const cfg = providerKey
    ? getProvider(providerKey, { dir: configDir })
    : null;

  const key = apiKey || (cfg && cfg.apiKey) || null;
  const url = (baseURL || (cfg && cfg.baseURL) || '').replace(/\/+$/, '');
  const models = (cfg && cfg.models) || [];
  const chosenModel = model || models[0] || null;
  const closed = { key, url, chosenModel };

  const adapterId = id || `api:${providerKey || 'unknown'}`;
  const adapterName = name || (cfg ? `${cfg.displayName} API` : adapterId);

  // ── 会话内的状态 ──
  let inflight = null;        // 当前请求的 AbortController
  let lastRequestText = null; // 本轮发出的文本（用于诊断，不落日志）
  let ready = !!(closed.key && closed.url && closed.chosenModel);
  let lastError = null;

  /* ─────────── 附件：API 的"上传"其实是内联准备 ─────────── */

  async function prepareAttachments(attachments = []) {
    const failed = [];
    const textParts = [];
    const imageParts = [];

    for (const att of attachments) {
      const p = att.localPath;
      if (!p) { failed.push({ name: att.name, error: 'NO_LOCAL_PATH' }); continue; }

      let st;
      try { st = fs.statSync(p); } catch (e) {
        failed.push({ name: att.name, error: `STAT_FAIL: ${e.message}` });
        continue;
      }
      if (!st.isFile()) { failed.push({ name: att.name, error: 'NOT_A_FILE' }); continue; }
      if (st.size > MAX_INLINE_BYTES) {
        failed.push({ name: att.name, error: `TOO_LARGE_TO_INLINE (${st.size}B > ${MAX_INLINE_BYTES}B)` });
        continue;
      }

      const ext = path.extname(att.name || p).toLowerCase();
      try {
        if (INLINE_IMAGE_EXT.has(ext)) {
          const b64 = fs.readFileSync(p).toString('base64');
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${MIME_BY_EXT[ext] || 'image/png'};base64,${b64}` },
          });
        } else if (INLINE_TEXT_EXT.has(ext)) {
          const txt = fs.readFileSync(p, 'utf8');
          textParts.push(`【附件 ${att.name}】\n${txt}`);
        } else {
          // pdf/docx/xlsx/zip 等：API 无法内联，明确报失败让上游降级
          failed.push({ name: att.name, error: 'UNSUPPORTED_FORMAT_FOR_API' });
        }
      } catch (e) {
        failed.push({ name: att.name, error: `READ_FAIL: ${e.message}` });
      }
    }
    return { failed, textParts, imageParts };
  }

  /* ─────────── SSE 流解析 ─────────── */

  /**
   * 发一次 chat/completions 请求并读流。
   * @returns {{ ok:boolean, text:string, error:string|null, usage:object|null }}
   */
  async function callStream({ text, imageParts = [], onDelta = null, timeoutMs = 120000 }) {
    if (!closed.key) return { ok: false, text: '', error: 'NO_API_KEY', usage: null };
    if (!closed.url) return { ok: false, text: '', error: 'NO_BASE_URL', usage: null };
    if (!closed.chosenModel) return { ok: false, text: '', error: 'NO_MODEL', usage: null };

    const content = imageParts.length
      ? [{ type: 'text', text }, ...imageParts]
      : text;

    const body = {
      model: closed.chosenModel,
      messages: [{ role: 'user', content }],
      stream: true,
    };
    if (temperature !== null) body.temperature = temperature;
    if (maxTokens !== null) body.max_tokens = maxTokens;

    inflight = new AbortController();
    const timer = setTimeout(() => { try { inflight.abort(); } catch (_) {} }, timeoutMs);

    let acc = '';
    let usage = null;

    try {
      const res = await fetch(`${closed.url}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${closed.key}`,
        },
        body: JSON.stringify(body),
        signal: inflight.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let hint = errText.slice(0, 300);
        try {
          const j = JSON.parse(errText);
          hint = (j.error && (j.error.message || j.error.type)) || hint;
        } catch (_) { /* 非 JSON 错误体，用原文 */ }
        const tag = res.status === 401 ? 'AUTH_FAILED'
          : res.status === 429 ? 'RATE_LIMITED'
            : res.status >= 500 ? 'SERVER_ERROR' : `HTTP_${res.status}`;
        return { ok: false, text: '', error: `${tag}: ${hint}`, usage: null };
      }

      // 手动解析 SSE（Node 内置 fetch 的 body 是 ReadableStream）
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // 按空行切事件
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              const d = j.choices && j.choices[0] && j.choices[0].delta;
              const piece = (d && (d.content || d.reasoning_content)) || '';
              if (piece) {
                acc += piece;
                if (onDelta) { try { onDelta(piece, acc); } catch (_) { /* 回调异常不影响主流程 */ } }
              }
              if (j.usage) usage = j.usage;
            } catch (_) { /* 半截 JSON，忽略（下一轮会补齐） */ }
          }
        }
      }
      return { ok: true, text: acc, error: null, usage };
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''));
      return {
        ok: false, text: acc, usage: null,
        error: aborted ? 'TIMEOUT_OR_CANCELLED' : `NETWORK: ${e && e.message}`,
      };
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  }

  /* ─────────── 契约实现 ─────────── */

  return {
    id: adapterId,
    name: adapterName,
    channel: 'api',
    providerKey: providerKey || null,
    model: closed.chosenModel,
    profile: null,   // 网页版有 partition profile，API 没有

    /** 配置是否齐全（不发请求、不花额度） */
    async isReady() {
      ready = !!(closed.key && closed.url && closed.chosenModel);
      return ready;
    },

    /** 供 UI 显示诊断（脱敏） */
    describe() {
      let host = '(未配置)';
      try { host = closed.url ? new URL(closed.url).host : host; } catch (_) {}
      return {
        id: adapterId, channel: 'api', provider: providerKey,
        model: closed.chosenModel, host,
        hasKey: !!closed.key, ready, lastError,
      };
    },

    /**
     * 「上传」= 内联准备 + 立即 ACK。
     * ★ 与网页版语义差异必须说清：网页版是真上传（有 ACK 等待），
     *   API 是随每次请求内联（无独立上传阶段）。所以这里立刻 ACK，
     *   让上游的取数门闩不会被 API 席位拖住。
     */
    async uploadFiles(attachments = [], { onAck = null } = {}) {
      const prep = await prepareAttachments(attachments);
      if (prep.failed.length) {
        log('warn', `[${adapterId}] 附件内联失败 ${prep.failed.length} 项`, {
          detail: prep.failed.map((f) => `${f.name}:${f.error}`),
        });
      }
      const okNames = attachments.length - prep.failed.length;
      // 每个成功项都回调 ACK（上游按 attId ACK 计数）
      if (onAck) {
        for (const att of attachments) {
          const bad = prep.failed.find((f) => f.name === att.name);
          if (!bad) { try { onAck(att.attachmentId || att.name); } catch (_) {} }
        }
      }
      lastError = prep.failed.length ? `INLINE_PARTIAL:${prep.failed.length}` : null;
      return { ok: prep.failed.length === 0, failed: prep.failed, prepared: { ok: okNames } };
    },

    /** 记录本轮要发的文本（真正请求在 waitForResponse 里发） */
    async sendText(text) {
      lastRequestText = text;
      return { ok: true };
    },

    /**
     * 发请求 + 读完整流。
     * ★ 完成检测在这里是**确定的**：流结束 = 答完。
     *   返回结构对齐 web-adapter：{ text, completion, stream }
     */
    async waitForResponse({ detector = null, timeoutMs = 120000 } = {}) {
      const started = Date.now();
      const text = lastRequestText || '';

      const r = await callStream({ text, timeoutMs });

      if (detector) {
        try {
          detector.touchContent && detector.touchContent();
          detector.markStreamEnd && detector.markStreamEnd();
        } catch (_) { /* detector 是可选协作对象，异常不影响结果 */ }
      }

      if (!r.ok) lastError = r.error;
      const completion = {
        done: r.ok,
        reason: r.ok ? 'api-stream-end' : r.error,
        signals: {
          // API 通道的三个信号都是"协议级事实"，不是启发式
          streamEnded: r.ok,
          stopGone: r.ok,
          domStable: true,
        },
        elapsedMs: Date.now() - started,
      };
      return {
        text: r.text || '',
        completion,
        stream: { transport: 'api', usage: r.usage, elapsedMs: Date.now() - started },
      };
    },

    /** 中止当前请求（闭麦） */
    async cancel() {
      if (inflight) {
        try { inflight.abort(); } catch (_) { /* 已结束 */ }
        return true;
      }
      return false;
    },

    /** API 通道一次请求就知道能力（不需要 DOM 探测） */
    async detectCapabilities() {
      return { transport: 'api', multimodal: true, search: false, streaming: true };
    },

    dispose() {
      try { if (inflight) inflight.abort(); } catch (_) {}
    },
  };
}

/**
 * 按模型档案里的 api 模型 id（如 'api:deepseek'）批量创建适配器。
 *
 * @param {object} opts { configDir, logger, models }  models 可指定要开哪几个
 * @returns {{ adapters: object, warnings: string[] }}
 */
function createApiAdapters({ configDir = null, logger = null, models = null } = {}) {
  const warnings = [];
  const adapters = {};

  let loaded;
  try {
    loaded = loadProviders({ dir: configDir });
  } catch (e) {
    return { adapters, warnings: [`读 DSH 配置失败：${e.message}`] };
  }
  warnings.push(...loaded.warnings);

  const want = models || Object.keys(loaded.providers);

  for (const key of want) {
    const p = loaded.providers[key];
    if (!p) { warnings.push(`提供方「${key}」不在 DSH 配置里，跳过`); continue; }
    if (!p.hasKey) { warnings.push(`提供方「${key}」无密钥，跳过（不创建空适配器）`); continue; }
    if (!p.baseURL) { warnings.push(`提供方「${key}」无 baseURL，跳过`); continue; }

    const a = createApiAdapter({ providerKey: key, configDir, logger });
    adapters[a.id] = a;
  }

  return { adapters, warnings };
}

module.exports = {
  createApiAdapter,
  createApiAdapters,
  INLINE_TEXT_EXT,
  INLINE_IMAGE_EXT,
  MAX_INLINE_BYTES,
};
