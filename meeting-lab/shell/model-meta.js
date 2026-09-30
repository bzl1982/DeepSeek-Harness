'use strict';
/**
 * shell/model-meta.js —— 模型元数据表（第 3 步，2026-09-25）
 *
 * 来源（Q2 共识 + DP 增补）：
 *   · 主源：LiteLLM model_prices_and_context_window.json（4348 模型，含 max_input_tokens /
 *     max_tokens / mode / supports_reasoning）——经 jsdelivr CDN 拉（本机 GitHub 直连不通，实测 jsdelivr 可达）。
 *   · snapshot：data/api/catalog/litellm-snapshot.json，TTL 30 天，原子写；离线用旧 snapshot。
 *   · 全断：内置 MINI_CATALOG（本机实际模型的人工表：deepseek/gemini/agnes 全覆盖）。
 *   · 查找顺序：AGNES 人工覆盖（image/video 标 nonChat）→ LiteLLM 精确 → 默认保守值。
 *
 * 关键用途（Q2）：给 listModels 结果补 contextWindow/maxOutput/multimodal/reasoning，
 * 并标 nonChat（image/video/embedding 等模型不进对话席位选择器——agne 实测 12 模型中 6 个非对话）。
 */

const path = require('path');
const fs = require('fs');

const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'api', 'catalog', 'litellm-snapshot.json');
const TTL = 30 * 24 * 3600e3;

const SOURCES = [
  'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
  'https://fastly.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
];

/* ── agne 系人工覆盖（2026-09-25 实测：6 文本 / 3 图像 / 3 视频；LiteLLM 表无 agnes-*）── */
const AGNES_OVERRIDES = {
  'agnes-2.5-pro-alpha': { contextWindow: 128000, maxOutput: 16384, multimodal: true },
  'agnes-2.5-pro':       { contextWindow: 128000, maxOutput: 16384, multimodal: true },
  'agnes-2.5-pro-beta':  { contextWindow: 128000, maxOutput: 16384, multimodal: true },
  'agnes-3.0-flash':     { contextWindow: 128000, maxOutput: 16384, multimodal: true },
  'agnes-2.5-flash':     { contextWindow: 128000, maxOutput: 8192,  multimodal: true },
  'agnes-2.0-flash':     { contextWindow: 64000,  maxOutput: 8192,  multimodal: false },
  'agnes-image-2.1-flash': { nonChat: true, kind: 'image' },
  'agnes-image-2.0-flash': { nonChat: true, kind: 'image' },
  'agnes-image-2.5-flash': { nonChat: true, kind: 'image' },
  'agnes-video-2.5-flash': { nonChat: true, kind: 'video' },
  'agnes-video-2.5':       { nonChat: true, kind: 'video' },
  'agnes-video-v2.0':      { nonChat: true, kind: 'video' },
};

/* ── 内置最小兜底（snapshot 不存在且在线全断时用）── */
const MINI_CATALOG = {
  'deepseek-chat':     { contextWindow: 131072, maxOutput: 8192,  multimodal: false, reasoning: { supported: false } },
  'deepseek-reasoner': { contextWindow: 131072, maxOutput: 65536, multimodal: false, reasoning: { supported: true } },
  'gemini-3.6-flash':  { contextWindow: 1048576, maxOutput: 65536, multimodal: true, reasoning: { supported: true } },
  'gemini-2.5-pro':    { contextWindow: 1048576, maxOutput: 65536, multimodal: true, reasoning: { supported: true } },
  'gpt-4o':            { contextWindow: 128000, maxOutput: 16384, multimodal: true, reasoning: { supported: false } },
  'gpt-4o-mini':       { contextWindow: 128000, maxOutput: 16384, multimodal: true, reasoning: { supported: false } },
  'claude-sonnet-4-5': { contextWindow: 200000, maxOutput: 64000, multimodal: true, reasoning: { supported: true } },
  ...Object.fromEntries(Object.entries(AGNES_OVERRIDES).map(([k, v]) => [k, {
    contextWindow: v.contextWindow || 0, maxOutput: v.maxOutput || 0,
    multimodal: v.multimodal !== false, reasoning: { supported: false }, nonChat: !!v.nonChat, kind: v.kind,
  }])),
};

let table = null;        // LiteLLM 全表（内存）
let loadedFrom = '';     // 'snapshot' | 'online' | 'mini'

function loadSnapshot() {
  const snap = readJsonSafe(SNAPSHOT_FILE);
  if (!snap || !snap.table) return false;
  table = snap.table;
  loadedFrom = 'snapshot';
  return true;
}
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/** 在线刷新（jsdelivr 主 + fastly 备）；成功写 snapshot。返回 true/false。 */
async function refreshOnline() {
  for (const u of SOURCES) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const j = JSON.parse(await res.text());
      if (!Object.keys(j).length) continue;
      table = j;
      loadedFrom = 'online';
      fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
      const tmp = SNAPSHOT_FILE + '.tmp-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), table: j }), 'utf8');
      fs.renameSync(tmp, SNAPSHOT_FILE);
      return true;
    } catch (_) { /* 下一个源 */ }
  }
  return false;
}

/** 启动加载：快照（含 TTL 判断）→ 在线 → 内置。返回 loadedFrom。 */
async function ensure() {
  if (table) return loadedFrom;
  if (loadSnapshot()) {
    const snap = readJsonSafe(SNAPSHOT_FILE);
    if (Date.now() - (snap.fetchedAt || 0) > TTL) {
      refreshOnline().then((ok) => { if (ok) console.log('[model-meta] 快照过期，已在线刷新'); }).catch(() => {});
    }
    return loadedFrom;
  }
  const ok = await refreshOnline();
  if (!ok) { table = MINI_CATALOG; loadedFrom = 'mini'; }
  return loadedFrom;
}

/** 查单个模型：剥 models/ 前缀（谷歌硬货：Gemini id 带 models/ 前缀要洗）→ agnes 人工覆盖 → LiteLLM 精确 → 内置 → 保守默认 */
function lookup(rawId) {
  const modelId = String(rawId || '').replace(/^models\//, '');
  const ov = AGNES_OVERRIDES[modelId];
  const e = table ? table[modelId] : null;
  if (e) {
    const mode = e.mode || 'chat';
    return {
      contextWindow: e.max_input_tokens || e.max_tokens || 8192,
      maxOutput: e.max_tokens || 4096,
      multimodal: !!(e.supports_image_input || /vision|vl|omni/i.test(modelId)),
      reasoning: { supported: !!e.supports_reasoning || /reasoner|thinking|o[0-9]/i.test(modelId) },
      nonChat: mode !== 'chat' && mode !== 'completion',
      kind: mode !== 'chat' && mode !== 'completion' ? mode : 'chat',
      pricing: { inputPerM: e.input_cost_per_token != null ? e.input_cost_per_token * 1e6 : null,
                 outputPerM: e.output_cost_per_token != null ? e.output_cost_per_token * 1e6 : null },
      source: 'litellm',
    };
  }
  if (ov) return { contextWindow: ov.contextWindow || 0, maxOutput: ov.maxOutput || 4096,
    multimodal: ov.multimodal !== false, reasoning: { supported: false },
    nonChat: !!ov.nonChat, kind: ov.kind || 'chat', source: 'agnes-override' };
  const mini = MINI_CATALOG[modelId];
  if (mini) return { ...mini, source: 'mini' };
  return { contextWindow: 8192, maxOutput: 4096, multimodal: false,
    reasoning: { supported: /reasoner|thinking|o[0-9]/i.test(modelId) }, nonChat: false, kind: 'chat', source: 'default' };
}

/** 批量富化 listModels 结果（api-main 的 fetch-models 调用）。
 *  优先级：LiteLLM/人工表的 reasoning 为权威；m.nonChat（listModels 正则）与 meta.nonChat 取或。 */
function enrich(models) {
  return (models || []).map((m) => {
    const meta = lookup(m.id);
    return {
      ...m,
      contextWindow: m.contextWindow || meta.contextWindow,
      maxOutput: m.maxOutput || meta.maxOutput,
      multimodal: m.multimodal || meta.multimodal,
      reasoning: meta.source === 'litellm' ? meta.reasoning : (m.reasoning || meta.reasoning),
      nonChat: meta.nonChat || !!m.nonChat,
      kind: meta.kind || 'chat',
      pricing: meta.pricing || null,
      metaSource: meta.source,
    };
  });
}

function status() {
  return { loadedFrom, entries: table ? Object.keys(table).length : 0,
    snapshotExists: fs.existsSync(SNAPSHOT_FILE) };
}

module.exports = { ensure, lookup, enrich, refreshOnline, status };
