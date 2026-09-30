'use strict';
/**
 * shell/api-main.js —— API 接入核心 · 主进程侧（第 1+2 步，2026-09-25）
 *
 * 架构（第 1 轮咨询共识，8 家外部 AI）：
 *   · 密钥解密【只放主进程】：renderer 里 require('electron').safeStorage === undefined（2026-09-25 实测）。
 *     明文密钥绝不离开本模块闭包——chat-stream 的 fetch 也在这里发，密钥全程不出主进程。
 *   · 密钥与配置分离存（DP 建议）：secrets.json（仅密文）+ providers.json（无敏感字段）——
 *     备份/分享配置不泄露密钥。
 *   · 原子写入：write tmp + rename（G14，防双实例写坏）。
 *   · 流式事件批量推送：delta 缓冲 100ms 合帧后经 webContents.send 推 renderer（Q4 渲染防火墙主进程侧）。
 *   · 数据目录：meeting-lab/data/api/（项目相对，独立于 userData——--reuse-login 时 userData 指向客户端目录，不能蹭）。
 *
 * 协议适配器（Q1 共识）：openai-chat（覆盖全部中转）/ anthropic-messages / gemini-native。
 *   · 统一事件：delta / reasoning_delta / usage / error / done。
 *   · 思考等级映射（Q6 裁断）：五档语义 off/low/medium/high/auto + budgetOverride；
 *     Anthropic 新旧两套（新模型 adaptive + output_config.effort；旧模型 enabled + budget_tokens）；
 *     Gemini 两代（2.5 thinkingBudget / 3.x thinkingLevel）；DeepSeek 走模型路由（chat⇄reasoner）；
 *     OpenAI 走 reasoning_effort。
 */

const path = require('path');
const fs = require('fs');
const { app, ipcMain, safeStorage } = require('electron');
const modelMeta = require('./model-meta');   // 第 3 步：LiteLLM 元数据表（窗口/类型过滤/定价）

const DATA_DIR = path.join(__dirname, '..', 'data', 'api');
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');
const SEATS_FILE = path.join(DATA_DIR, 'seats.json');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

/* ─────────── 原子写入（G14）─────────── */
function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

/* ─────────── SecretStore（safeStorage，仅主进程）─────────── */
const secrets = { ok: false, map: {} };
function secretsInit() {
  try {
    secrets.ok = safeStorage.isEncryptionAvailable();
  } catch (_) { secrets.ok = false; }
  secrets.map = readJson(SECRETS_FILE, {});
}
function secretSave(id, plain) {
  if (!secrets.ok) throw new Error('SAFE_STORAGE_UNAVAILABLE');
  const enc = safeStorage.encryptString(String(plain)).toString('base64');
  secrets.map[id] = enc;
  atomicWrite(SECRETS_FILE, secrets.map);
}
function secretLoad(id) {
  const enc = secrets.map[id];
  if (!enc) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch (_) { return null; }
}
function secretDelete(id) { delete secrets.map[id]; atomicWrite(SECRETS_FILE, secrets.map); }
function hasKey(id) { return !!secrets.map[id]; }

/* ─────────── Registry：providers / seats ─────────── */
let providers = [];   // [{id,name,protocol,baseURL,authScheme,defaultHeaders,modelsCache,modelsFetchedAt,modelsSource,capabilitiesOverride,rateLimit,createdAt}]
let seats = [];       // [{seatId,providerId,model,title,systemPrompt,params,perms,createdAt,archived}]
let imported = false;

function loadRegistry() {
  providers = readJson(PROVIDERS_FILE, { providers: [] }).providers || [];
  seats = readJson(SEATS_FILE, { seats: [] }).seats || [];
}
function saveProviders() { atomicWrite(PROVIDERS_FILE, { providers }); }
function saveSeats() { atomicWrite(SEATS_FILE, { seats }); }

/** 首次运行：从 DSH 客户端配置（~/.dsh）导入存量提供方与密钥，保证存量 3 席不掉 */
function importFromDsh() {
  if (providers.length) return;
  try {
    const dsh = require('../adapters/dsh-config');
    const { providers: list } = dsh.loadProviders({});
    let n = 0;
    for (const p of Object.values(list)) {
      if (!p.hasKey || !p.baseURL) continue;
      const id = 'imp-' + p.key;
      providers.push({
        id,
        name: p.displayName || p.key,
        protocol: 'openai-chat',          // 现有三家全部 OpenAI 兼容
        baseURL: p.baseURL,
        authScheme: 'bearer',
        defaultHeaders: {},
        modelsCache: (p.models || []).map((m) => ({ id: m })),
        modelsFetchedAt: 0,
        modelsSource: 'static',
        rateLimit: { concurrent: 3 },
        createdAt: Date.now(),
      });
      secretSave(id, p.apiKey);
      n++;
    }
    if (n) { saveProviders(); console.log('[api-main] 已从 ~/.dsh 导入 ' + n + ' 个提供方'); }
    imported = true;
  } catch (e) {
    console.log('[api-main] .dsh 导入跳过：' + e.message);
  }
}

function findProvider(id) { return providers.find((p) => p.id === id) || null; }

/* ─────────── 思考等级映射（Q6 裁断：五档语义）─────────── */
function mapReasoning(protocol, model, mode, budgetOverride) {
  const m = (mode || 'off');
  if (m === 'off') {
    // OpenAI o系/gpt-5 可显式 none；普通模型不传
    if (protocol === 'openai-chat' && /o[0-9]|gpt-5/i.test(model)) return { reasoning_effort: 'none' };
    return {};
  }
  if (protocol === 'openai-chat') {
    // DeepSeek：仅旧阵容（deepseek-chat）走模型路由；2026 新阵容（deepseek-flash/v4-pro）自带思考，不路由不传参
    if (/^deepseek-chat$/i.test(model)) return { __modelRoute: 'deepseek-reasoner' };
    if (/^deepseek-reasoner$/i.test(model)) return {};
    if (/^deepseek/i.test(model)) return {};   // 新阵容：模型自带思考，不传思考参数
    if (/o[0-9]|gpt-5/i.test(model)) return { reasoning_effort: m === 'auto' ? 'medium' : m };
    return {};   // 普通模型不支持思考参数，不传
  }
  if (protocol === 'anthropic-messages') {
    // 新模型（4.6+）adaptive；旧模型 enabled+budget_tokens（≥1024 且 < max_tokens）
    if (/(opus-4-[5-9]|sonnet-4-[5-9]|haiku-4-[5-9]|claude-[5-9])/i.test(model)) {
      return { thinking: { type: 'adaptive' }, output_config: { effort: m === 'auto' ? 'medium' : m } };
    }
    const budget = Math.max(1024, budgetOverride || (m === 'high' ? 8192 : m === 'medium' ? 4096 : 1024));
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }
  if (protocol === 'gemini-native') {
    if (/gemini-3/i.test(model)) {
      const lvl = m === 'high' ? 'HIGH' : m === 'medium' ? 'MEDIUM' : m === 'low' ? 'LOW' : 'MINIMAL';
      return { thinkingConfig: { thinkingLevel: lvl } };
    }
    const b = budgetOverride || (m === 'high' ? 8192 : m === 'medium' ? 4096 : m === 'low' ? 1024 : (m === 'auto' ? -1 : 0));
    return { thinkingConfig: { thinkingBudget: m === 'auto' ? -1 : b } };
  }
  return {};
}

/* ─────────── SSE 行解析器（openai/anthropic 共用；gemini 用 alt=sse 复用）───────────
   ★ abort 感知：reader.read() 与中止信号竞速——超时中止时保证本函数立刻抛出，
     adapter promise 得以 settle → hooks.afterRun 释放信号量槽位。
     （否则槽位泄漏：该 provider 后续所有请求永远排队——2026-09-25 实测踩坑） */
async function readSSE(res, onPayload, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let onAbort = null;
  try {
    for (;;) {
      let abortP = null;
      if (signal) {
        if (signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        abortP = new Promise((_, rej) => {
          onAbort = () => rej(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      const { done, value } = await (abortP ? Promise.race([reader.read(), abortP]) : reader.read());
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      onAbort = null;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line) onPayload(line);
      }
    }
    if (buf.trim()) onPayload(buf.trim());
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    try { reader.cancel().catch(() => {}); } catch (_) {}
  }
}

/* ─────────── 统一内部消息 → 协议格式（Q9 附件映射：image 三协议三格式）───────────
 * 内部 content：string | [{type:'text',text} | {type:'image',mime,dataBase64}] */
function partsOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
}
function openaiContent(content) {
  const parts = partsOf(content);
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;   // 纯文本保持 string（兼容性最好）
  return parts.map((pt) => pt.type === 'image'
    ? { type: 'image_url', image_url: { url: 'data:' + (pt.mime || 'image/png') + ';base64,' + pt.dataBase64 } }
    : { type: 'text', text: pt.text });
}
function anthropicContent(content) {
  return partsOf(content).map((pt) => pt.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: pt.mime || 'image/png', data: pt.dataBase64 } }
    : { type: 'text', text: pt.text });
}
function geminiParts(content) {
  return partsOf(content).map((pt) => pt.type === 'image'
    ? { inlineData: { mimeType: pt.mime || 'image/png', data: pt.dataBase64 } }
    : { text: pt.text });
}

/* ─────────── 协议适配器：openai-chat ─────────── */
async function chatOpenAI({ provider, model, messages, params, signal, emit, hooks }) {
  if (hooks && hooks.beforeRun) await hooks.beforeRun();
  try {
  return await chatOpenAIInner({ provider, model, messages, params, signal, emit });
  } finally { if (hooks && hooks.afterRun) hooks.afterRun(); }
}
async function chatOpenAIInner({ provider, model, messages, params, signal, emit }) {
  const key = secretLoad(provider.id);
  if (!key) return emit({ type: 'error', code: 'AUTH', message: 'NO_KEY' });
  // DeepSeek 模型路由
  let useModel = model;
  const rm = mapReasoning('openai-chat', model, params.reasoning, params.budgetTokensOverride);
  if (rm.__modelRoute) useModel = rm.__modelRoute;
  const body = { model: useModel, messages: messages.map((m) => ({ role: m.role, content: openaiContent(m.content) })), stream: true, stream_options: { include_usage: true } };
  if (params.temperature !== null && params.temperature !== undefined) body.temperature = params.temperature;
  if (params.maxTokens) body.max_tokens = params.maxTokens;
  if (rm.reasoning_effort && rm.reasoning_effort !== 'none') body.reasoning_effort = rm.reasoning_effort;
  Object.assign(body, rm.__modelRoute ? {} : rm);   // 剩余 reasoning 字段（none 场景）
  const url = provider.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, ...(provider.defaultHeaders || {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    let hint = t.slice(0, 300);
    try { const j = JSON.parse(t); hint = (j.error && (j.error.message || j.error.type)) || hint; } catch (_) {}
    const code = res.status === 401 ? 'AUTH' : res.status === 429 ? 'RATE' : res.status >= 500 ? 'SERVER' : 'HTTP_' + res.status;
    const ra = parseInt(res.headers.get('retry-after'), 10);
    return emit({ type: 'error', code, message: hint, retryAfterMs: isNaN(ra) ? null : ra * 1000 });
  }
  await readSSE(res, (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    let j; try { j = JSON.parse(payload); } catch (_) { return; }
    const d = j.choices && j.choices[0] && j.choices[0].delta;
    if (d && d.reasoning_content) emit({ type: 'reasoning_delta', text: d.reasoning_content });
    if (d && d.content) emit({ type: 'delta', text: d.content });
    if (j.usage) emit({ type: 'usage', usage: {
      promptTokens: j.usage.prompt_tokens || 0,
      completionTokens: j.usage.completion_tokens || 0,
      reasoningTokens: j.usage.reasoning_tokens || j.usage.completion_tokens_details?.reasoning_tokens || 0,
      totalTokens: j.usage.total_tokens || 0,
    } });
  }, signal);
  emit({ type: 'done' });
}

/* ─────────── 协议适配器：anthropic-messages ─────────── */
async function chatAnthropic({ provider, model, messages, params, signal, emit, hooks }) {
  if (hooks && hooks.beforeRun) await hooks.beforeRun();
  try {
  return await chatAnthropicInner({ provider, model, messages, params, signal, emit });
  } finally { if (hooks && hooks.afterRun) hooks.afterRun(); }
}
async function chatAnthropicInner({ provider, model, messages, params, signal, emit }) {
  const key = secretLoad(provider.id);
  if (!key) return emit({ type: 'error', code: 'AUTH', message: 'NO_KEY' });
  const rm = mapReasoning('anthropic-messages', model, params.reasoning, params.budgetTokensOverride);
  let system = null;
  const msgs = [];
  for (const m of messages) {
    if (m.role === 'system') { system = typeof m.content === 'string' ? m.content : JSON.stringify(m.content); continue; }
    msgs.push({ role: m.role, content: anthropicContent(m.content) });
  }
  const body = { model, messages: msgs, stream: true, max_tokens: params.maxTokens || 8192 };
  if (system) body.system = system;
  if (params.temperature !== null && params.temperature !== undefined) body.temperature = params.temperature;
  Object.assign(body, rm);
  if (rm.thinking && rm.thinking.type === 'enabled') body.max_tokens = Math.max(body.max_tokens, rm.thinking.budget_tokens + 4096);
  const url = provider.baseURL.replace(/\/+$/, '') + '/v1/messages';
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', ...(provider.defaultHeaders || {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const code = res.status === 401 ? 'AUTH' : res.status === 429 ? 'RATE' : res.status >= 500 ? 'SERVER' : 'HTTP_' + res.status;
    const ra = parseInt(res.headers.get('retry-after'), 10);
    return emit({ type: 'error', code, message: t.slice(0, 300), retryAfterMs: isNaN(ra) ? null : ra * 1000 });
  }
  let usage = null;
  await readSSE(res, (line) => {
    if (!line.startsWith('data:')) return;
    let j; try { j = JSON.parse(line.slice(5).trim()); } catch (_) { return; }
    if (j.type === 'content_block_delta') {
      if (j.delta && j.delta.type === 'text_delta') emit({ type: 'delta', text: j.delta.text });
      if (j.delta && j.delta.type === 'thinking_delta') emit({ type: 'reasoning_delta', text: j.delta.thinking });
    }
    if (j.type === 'message_start' && j.message && j.message.usage) {
      usage = { promptTokens: j.message.usage.input_tokens || 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    }
    if (j.type === 'message_delta' && j.usage) {
      const out = j.usage.output_tokens || 0;
      if (usage) { usage.completionTokens = out; usage.totalTokens = usage.promptTokens + out; }
    }
  }, signal);
  if (usage) emit({ type: 'usage', usage });
  emit({ type: 'done' });
}

/* ─────────── 协议适配器：gemini-native ─────────── */
async function chatGemini({ provider, model, messages, params, signal, emit, hooks }) {
  if (hooks && hooks.beforeRun) await hooks.beforeRun();
  try {
  return await chatGeminiInner({ provider, model, messages, params, signal, emit });
  } finally { if (hooks && hooks.afterRun) hooks.afterRun(); }
}
async function chatGeminiInner({ provider, model, messages, params, signal, emit }) {
  const key = secretLoad(provider.id);
  if (!key) return emit({ type: 'error', code: 'AUTH', message: 'NO_KEY' });
  const rm = mapReasoning('gemini-native', model, params.reasoning, params.budgetTokensOverride);
  let system = null;
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') { system = typeof m.content === 'string' ? m.content : JSON.stringify(m.content); continue; }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: geminiParts(m.content) });
  }
  const body = { contents, generationConfig: {} };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  Object.assign(body.generationConfig, rm.thinkingConfig || {});
  if (params.temperature !== null && params.temperature !== undefined) body.generationConfig.temperature = params.temperature;
  if (params.maxTokens) body.generationConfig.maxOutputTokens = params.maxTokens;
  let base = provider.baseURL.replace(/\/+$/, '');
  base = base.replace(/\/openai$/, '');      // 兼容 OpenAI 兼容桥端点
  const url = base + '/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(key);
  const res = await fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const code = res.status === 401 || res.status === 403 ? 'AUTH' : res.status === 429 ? 'RATE' : res.status >= 500 ? 'SERVER' : 'HTTP_' + res.status;
    const ra = parseInt(res.headers.get('retry-after'), 10);
    return emit({ type: 'error', code, message: t.slice(0, 300), retryAfterMs: isNaN(ra) ? null : ra * 1000 });
  }
  await readSSE(res, (line) => {
    if (!line.startsWith('data:')) return;
    let j; try { j = JSON.parse(line.slice(5).trim()); } catch (_) { return; }
    const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    if (parts) for (const p of parts) if (p.text) emit({ type: 'delta', text: p.text });
    if (j.usageMetadata) emit({ type: 'usage', usage: {
      promptTokens: j.usageMetadata.promptTokenCount || 0,
      completionTokens: j.usageMetadata.candidatesTokenCount || 0,
      reasoningTokens: j.usageMetadata.thoughtsTokenCount || 0,
      totalTokens: j.usageMetadata.totalTokenCount || 0,
    } });
  }, signal);
  emit({ type: 'done' });
}

const CHAT_BY_PROTOCOL = { 'openai-chat': chatOpenAI, 'anthropic-messages': chatAnthropic, 'gemini-native': chatGemini };

/* ─────────── listModels（按协议）─────────── */
async function listModels(provider) {
  const key = secretLoad(provider.id);
  if (provider.protocol === 'gemini-native') {
    let base = provider.baseURL.replace(/\/+$/, '').replace(/\/openai$/, '');
    const res = await fetch(base + '/models?pageSize=200&key=' + encodeURIComponent(key), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('LIST_MODELS_FAIL_' + res.status);
    const j = await res.json();
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({
        id: String(m.name || '').replace(/^models\//, ''),
        displayName: m.displayName || null,
        contextWindow: m.inputTokenLimit || 0,
        maxOutput: m.outputTokenLimit || 0,
        multimodal: true,
        reasoning: { supported: !!m.thinking },
      }));
  }
  if (provider.protocol === 'anthropic-messages') {
    let base = provider.baseURL.replace(/\/+$/, '');
    if (!/\/v1$/.test(base)) base += '/v1';
    const res = await fetch(base + '/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('LIST_MODELS_FAIL_' + res.status);
    const j = await res.json();
    return (j.data || []).map((m) => ({ id: m.id, displayName: m.display_name || null, contextWindow: 0, maxOutput: 0, multimodal: true, reasoning: { supported: true } }));
  }
  // openai-chat（含中转）。reasoning 不在此预设——交给 model-meta 的 LiteLLM supports_reasoning 权威标注
  const res = await fetch(provider.baseURL.replace(/\/+$/, '') + '/models', {
    headers: { Authorization: 'Bearer ' + key, ...(provider.defaultHeaders || {}) }, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('LIST_MODELS_FAIL_' + res.status);
  const j = await res.json();
  return (j.data || []).map((m) => ({
    id: m.id,
    displayName: null,
    contextWindow: 0,
    maxOutput: 0,
    multimodal: false,
    nonChat: /image|video|tts|embed|whisper|dall|audio|transcribe|veo|lyria|imagen|robotics|live-translate|computer-use|aqa|deep-research/i.test(m.id),
  }));
}

/* ─────────── Q4 裁断：并发控制（全局 8 + per-provider 动态信号量 + 429 冷却降档）─────────── */
function makeDynSem(max) {
  let inFlight = 0; const q = [];
  function pump() { while (inFlight < max && q.length) { inFlight++; q.shift()(); } }
  return {
    setMax(m) { max = Math.max(1, m | 0); pump(); },
    acquire() { return new Promise((res) => { q.push(() => { inFlight++; res(); }); pump(); }); },
    release() { inFlight--; pump(); },
  };
}
const globalSem = makeDynSem(8);          // 全局并发（4 家限流派共识）
const provSems = new Map();               // providerId -> { sem, cooldownUntil, streak, base }
function provState(id) {
  if (!provSems.has(id)) provSems.set(id, { sem: makeDynSem(3), cooldownUntil: 0, streak: 0, base: 3 });
  return provSems.get(id);
}
/** 等待 provider 冷却结束（429 后 30s 默认，或 Retry-After） */
async function waitCooldown(id) {
  const st = provState(id);
  while (Date.now() < st.cooldownUntil) {
    await new Promise((r) => setTimeout(r, Math.min(1000, st.cooldownUntil - Date.now())));
  }
}
function markRateLimited(id, retryAfterMs) {
  const st = provState(id);
  const wait = Math.max(1000, retryAfterMs || 30000);
  st.cooldownUntil = Math.max(st.cooldownUntil, Date.now() + wait);
  const next = Math.max(1, Math.floor(st.sem.max / 2) || 1);
  st.sem.setMax(next);                    // 降档：3→1
  st.streak = 0;
  console.log('[api-main] ' + id + ' 触发 429：冷却 ' + Math.round(wait / 1000) + 's，并发降档至 ' + next);
}
function markSuccess(id) {
  const st = provState(id);
  st.streak++;
  if (st.streak >= 8 && st.sem.max < st.base) { st.sem.setMax(st.sem.max + 1); st.streak = 0; }  // 连续 8 成功恢复一档
}

/* ─────────── IPC 注册（app ready 后调用）─────────── */
const inflight = new Map();   // reqId -> AbortController
let reqSeq = 0;

function register() {
  secretsInit();
  loadRegistry();
  importFromDsh();
  modelMeta.ensure().then((src) => console.log('[api-main] 模型元数据源 = ' + src));   // 第 3 步

  ipcMain.handle('api:list-providers', () => providers.map((p) => ({
    ...p, hasKey: hasKey(p.id),
  })));

  ipcMain.handle('api:save-provider', (e, { provider, apiKey }) => {
    const p = provider || {};
    if (!p.id || !p.baseURL || !p.protocol) return { ok: false, error: 'MISSING_FIELDS' };
    const i = providers.findIndex((x) => x.id === p.id);
    const clean = { ...p };
    delete clean.hasKey;
    if (i >= 0) providers[i] = { ...providers[i], ...clean };
    else providers.push({ rateLimit: { concurrent: 3 }, modelsCache: [], modelsFetchedAt: 0, modelsSource: 'manual', createdAt: Date.now(), ...clean });
    if (apiKey) { try { secretSave(p.id, apiKey); } catch (err) { return { ok: false, error: err.message }; } }
    saveProviders();
    return { ok: true };
  });

  ipcMain.handle('api:delete-provider', (e, { id }) => {
    providers = providers.filter((p) => p.id !== id);
    secretDelete(id);
    seats = seats.filter((s) => s.providerId !== id);
    saveProviders(); saveSeats();
    return { ok: true };
  });

  ipcMain.handle('api:test-key', (e, { id }) => ({ ok: hasKey(id) }));

  ipcMain.handle('api:fetch-models', async (e, { id, force }) => {
    const p = findProvider(id);
    if (!p) return { ok: false, error: 'NO_PROVIDER' };
    if (!force && p.modelsCache && p.modelsCache.length && Date.now() - (p.modelsFetchedAt || 0) < 24 * 3600e3) {
      return { ok: true, models: p.modelsCache, cached: true };
    }
    try {
      const models = await listModels(p);
      const enriched = modelMeta.enrich(models);   // ★ 第 3 步：补窗口/类型/nonChat/定价
      if (!models.length && p.modelsCache && p.modelsCache.length) {
        return { ok: true, models: p.modelsCache, cached: true, suspicious: true };   // 空列表不覆盖缓存（ChatGPT 硬货）
      }
      p.modelsCache = enriched; p.modelsFetchedAt = Date.now(); p.modelsSource = 'auto';
      saveProviders();
      return { ok: true, models: enriched };
    } catch (err) {
      if (p.modelsCache && p.modelsCache.length) return { ok: true, models: p.modelsCache, cached: true, stale: true };
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('api:meta-status', () => modelMeta.status());
  ipcMain.handle('api:meta-refresh', async () => ({ ok: await modelMeta.refreshOnline() }));

  ipcMain.handle('api:list-seats', () => seats);
  ipcMain.handle('api:save-seats', (e, { list }) => { seats = list || []; saveSeats(); return { ok: true }; });

  /* ★ 第 7 步：整表保存（含排序）——renderer 传排好序的完整 providers 数组（无密钥字段） */
  ipcMain.handle('api:save-providers-all', (e, { list }) => {
    const byId = new Map(providers.map((p) => [p.id, p]));
    const next = [];
    for (const item of (list || [])) {
      const old = byId.get(item.id);
      if (!old) continue;                       // 新提供方走 api:save-provider 创建
      next.push({ ...old, ...item, modelsCache: old.modelsCache, modelsFetchedAt: old.modelsFetchedAt, modelsSource: old.modelsSource });
    }
    providers = next;
    saveProviders();
    return { ok: true };
  });
  /* ★ 第 7 步：模型排序（provider 内 modelsCache 顺序 = 选择器顺序） */
  ipcMain.handle('api:reorder-models', (e, { id, ids }) => {
    const p = findProvider(id);
    if (!p) return { ok: false };
    const byId = new Map((p.modelsCache || []).map((m) => [m.id, m]));
    const ordered = [];
    for (const mid of (ids || [])) { const m = byId.get(mid); if (m) { ordered.push(m); byId.delete(mid); } }
    p.modelsCache = ordered.concat([...byId.values()]);
    saveProviders();
    return { ok: true, models: p.modelsCache };
  });

  ipcMain.handle('api:chat-stream', async (e, { reqId, providerId, model, messages, params }) => {
    const p = findProvider(providerId);
    if (!p) return { ok: false, error: 'NO_PROVIDER' };
    const adapter = CHAT_BY_PROTOCOL[p.protocol];
    if (!adapter) return { ok: false, error: 'UNKNOWN_PROTOCOL: ' + p.protocol };
    const myReq = reqId || ('r' + (++reqSeq) + '-' + Date.now());
    const ac = new AbortController();
    inflight.set(myReq, ac);
    /* ★ 超时兜底（第 1 步重构曾丢失——挂起的请求会永远 SENDING）：默认 180s（思考模型长回复） */
    const timeoutMs = (params && params.timeoutMs) || 180000;
    const killTimer = setTimeout(() => {
      emit({ type: 'error', code: 'TIMEOUT', message: '请求超过 ' + Math.round(timeoutMs / 1000) + 's 未完成，已中止' });
      try { ac.abort(); } catch (_) {}
    }, timeoutMs);
    const sender = e.sender;
    let buf = [];
    let flushTimer = null;
    const flush = () => {
      if (!buf.length) return;
      const batch = buf; buf = [];
      try { if (!sender.isDestroyed()) sender.send('api:stream-evt', { reqId: myReq, evts: batch }); } catch (_) {}
    };
    const emit = (evt) => {
      /* ★ 429 自适应（ChatGPT 硬货）：RATE → 读 retryAfterMs 冷却 + 并发降档 */
      if (evt.type === 'error' && evt.code === 'RATE') markRateLimited(providerId, evt.retryAfterMs);
      if (evt.type === 'delta' || evt.type === 'reasoning_delta') {
        buf.push(evt);
        if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 100);
      } else {
        if (evt.type === 'done') markSuccess(providerId);
        flush();   // usage/error/done 立即推
        try { if (!sender.isDestroyed()) sender.send('api:stream-evt', { reqId: myReq, evts: [evt] }); } catch (_) {}
      }
    };
    /* ★ 限流顺序：全局信号量 → provider 冷却等待 → provider 信号量（G9：慢的 provider 不拖别人） */
    adapter({ provider: p, model, messages, params: params || {}, signal: ac.signal, emit, hooks: {
      beforeRun: async () => { await globalSem.acquire(); await waitCooldown(providerId); await provState(providerId).sem.acquire(); },
      afterRun: () => { provState(providerId).sem.release(); globalSem.release(); },
    } })
      .catch((err) => {
        const aborted = err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''));
        emit({ type: 'error', code: aborted ? 'CANCELLED' : 'NETWORK', message: err && err.message });
      })
      .finally(() => {
        clearTimeout(killTimer);
        if (flushTimer) { clearTimeout(flushTimer); flush(); }
        inflight.delete(myReq);
      });
    return { ok: true, reqId: myReq };
  });

  ipcMain.handle('api:abort', (e, { reqId }) => {
    const ac = inflight.get(reqId);
    if (ac) { try { ac.abort(); } catch (_) {} return { ok: true }; }
    return { ok: false };
  });

  console.log('[api-main] API 接入核心已挂载（providers: ' + providers.length + '，seats: ' + seats.length + '，safeStorage: ' + (secrets.ok ? '可用' : '不可用') + '）');
}

module.exports = { register };
