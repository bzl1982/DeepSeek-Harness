'use strict';
/**
 * core/session-store.js —— 每席位多轮会话存储（第 5 步，2026-09-25）
 *
 * 共识落地（Q5，8 家咨询）：
 *   · V1 不上 SQLite：内存常驻 + JSONL 追加落盘（data/api/history/<seatId>.jsonl）。
 *   · ★ 上下文占用 ≠ 各轮 prompt_tokens 累加（每轮都带全量历史）——
 *     UI 显示的"上下文用量" = contextTokensAtSend（最近一次请求的输入量）；
 *     cumulative（prompt/completion/reasoning/total）只做花钱统计，分列记录。
 *   · usage 缺失时本地估算兜底并打 estimated 标记（中文≈1字×2 token，其他≈0.3/字符）。
 *   · 滑窗截断：保留 system prompt，从最旧丢；发送前 projected 超过窗口 ×0.8 → 黄色提醒
 *     （V1 不做自动摘要——豆包/谷歌反对成立）。
 *   · 格式按"完整交互回合"一行（谷歌）：一行 = 一条 message 或一条 usage 或 meta。
 */

const path = require('path');
const fs = require('fs');

const HISTORY_DIR = path.join(__dirname, '..', 'data', 'api', 'history');
const WARN_RATIO = 0.8;          // 超过窗口 80% 提醒
const MAX_MESSAGES = 60;         // 内存保留的最近消息条数（滑窗上限，超出只留盘）

const sessions = new Map();      // seatId -> { messages, contextTokensAtSend, cumulative, contextWindow, warn }

/** 粗略 token 估算（中文≈1字×2，其他≈0.3/字符——谷歌/豆包系数，仅用于截断/兜底，标记 estimated）。
 *  content 可为 string 或 parts 数组（第 8 步：图片按 1000 tok/张粗估，文本取 text 字段）。 */
function estimateTokens(content) {
  let s = '';
  if (Array.isArray(content)) {
    for (const pt of content) {
      if (pt.type === 'text') s += pt.text || '';
      else if (pt.type === 'image') s += ' '.repeat(1000);   // 图片粗估 1k tok
      else if (pt.type === 'file' && pt.textExtracted) s += pt.textExtracted;
    }
  } else s = String(content || '');
  let cjk = 0;
  for (const ch of s) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
  return Math.round(cjk * 2 + (s.length - cjk) * 0.3);
}

function histFile(seatId) {
  return path.join(HISTORY_DIR, String(seatId).replace(/[\\/:*?"<>|]/g, '_') + '.jsonl');
}
/** 原子追加一行 JSONL（G14） */
function appendLine(seatId, obj) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.appendFileSync(histFile(seatId), JSON.stringify(obj) + '\n', 'utf8');
}

/** 取（或按落盘重建）一个会话。contextWindow 来自模型元数据（api-seats/model-meta）。 */
function get(seatId, contextWindow) {
  if (sessions.has(seatId)) {
    const s = sessions.get(seatId);
    if (contextWindow) s.contextWindow = contextWindow;
    return s;
  }
  const s = {
    seatId,
    messages: [],                 // [{role, content, ts, usage?}]，不含估算
    contextTokensAtSend: 0,       // ★ 最近一次请求的输入量 = "上下文占用"
    estimated: false,
    cumulative: { prompt: 0, completion: 0, reasoning: 0, total: 0, requests: 0 },
    contextWindow: contextWindow || 8192,
    warn: false,
  };
  // 从 JSONL 重建（只回填最近 MAX_MESSAGES 条 message；usage/meta 只进累计）
  try {
    const raw = fs.readFileSync(histFile(seatId), 'utf8');
    const msgs = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      if (o.t === 'msg' && o.m) msgs.push(o.m);
      else if (o.t === 'usage' && o.u) { s.cumulative.prompt += o.u.promptTokens || 0; s.cumulative.completion += o.u.completionTokens || 0; s.cumulative.reasoning += o.u.reasoningTokens || 0; s.cumulative.total += o.u.totalTokens || 0; s.cumulative.requests++; if (o.ctxAtSend) s.contextTokensAtSend = o.ctxAtSend; if (o.contextWindow) s.contextWindow = o.contextWindow; }
      else if (o.t === 'meta' && o.contextWindow) s.contextWindow = o.contextWindow;
    }
    s.messages = msgs.slice(-MAX_MESSAGES);
  } catch (_) { /* 无历史文件 */ }
  sessions.set(seatId, s);
  return s;
}

/** 组装发送消息：system 前置 + 滑窗历史 + 本轮输入。返回 { messages, projected, warn } */
function buildMessages(seatId, userContent, { systemPrompt = null, contextWindow = null, maxTokens = null, reasoningBudget = 0 } = {}) {
  const s = get(seatId, contextWindow);
  const win = s.contextWindow || 8192;
  const inTok = estimateTokens(userContent);
  const sysTok = systemPrompt ? estimateTokens(systemPrompt) : 0;
  const headroom = Math.round(win * WARN_RATIO);
  // 从旧到新保留（保 system 预算），直到 projected 安全线
  const kept = [];
  let used = inTok + sysTok + (maxTokens || 512) + reasoningBudget;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(s.messages[i].content);
    if (used + cost > headroom) break;    // 滑窗：塞不下的旧轮丢弃（不摘要）
    used += cost;
    kept.unshift(s.messages[i]);
  }
  const projected = used;
  const warn = projected > headroom;
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const m of kept) messages.push({ role: m.role, content: m.content });
  messages.push({ role: 'user', content: userContent });
  return { messages, projected, warn, contextTokensAtSend: projected };
}

/** 用户消息入库 */
function appendUser(seatId, content) {
  const s = get(seatId);
  const m = { role: 'user', content, ts: Date.now() };
  s.messages.push(m);
  appendLine(seatId, { t: 'msg', m });
  trim(s);
  return m;
}
/** 助手回复入库（附该轮 usage） */
function appendAssistant(seatId, content, usage) {
  const s = get(seatId);
  const m = { role: 'assistant', content, ts: Date.now(), usage: usage || undefined };
  s.messages.push(m);
  appendLine(seatId, { t: 'msg', m });
  trim(s);
  return m;
}
/** usage 记账（分列：累计仅用于花钱统计）；ctxAtSend/window 一并落盘（重启重建用） */
function recordUsage(seatId, usage, { estimated = false, contextTokensAtSend = 0 } = {}) {
  const s = get(seatId);
  s.cumulative.prompt += usage.promptTokens || 0;
  s.cumulative.completion += usage.completionTokens || 0;
  s.cumulative.reasoning += usage.reasoningTokens || 0;
  s.cumulative.total += usage.totalTokens || (usage.promptTokens || 0) + (usage.completionTokens || 0);
  s.cumulative.requests++;
  if (usage.promptTokens) s.contextTokensAtSend = usage.promptTokens;   // 官方值 → 精确上下文占用
  else s.contextTokensAtSend = Math.max(s.contextTokensAtSend, contextTokensAtSend || 0);
  s.estimated = !!estimated;
  appendLine(seatId, { t: 'usage', u: usage, estimated: s.estimated, ctxAtSend: s.contextTokensAtSend, contextWindow: s.contextWindow });
}
/** 无官方 usage 时的估算兜底（适配器出口强制拉平） */
function estimateUsage(seatId, messages, completionText) {
  const inTok = messages.reduce((a, m) => a + estimateTokens(m.content), 0);
  const outTok = estimateTokens(completionText);
  return { promptTokens: inTok, completionTokens: outTok, reasoningTokens: 0, totalTokens: inTok + outTok };
}
/** UI 快照：右侧"上下文使用情况"的数据源 */
function snapshot(seatId) {
  const s = get(seatId);
  return {
    contextTokensAtSend: s.contextTokensAtSend,
    contextWindow: s.contextWindow,
    ratio: s.contextTokensAtSend / (s.contextWindow || 8192),
    warn: s.contextTokensAtSend > (s.contextWindow || 8192) * WARN_RATIO,
    cumulative: { ...s.cumulative },
    estimated: s.estimated,
    turns: Math.floor(s.messages.length / 2),
  };
}
/** 清空会话（保留文件，另起一段：写一行 reset 标记） */
function clear(seatId) {
  const s = get(seatId);
  s.messages = []; s.contextTokensAtSend = 0; s.warn = false;
  appendLine(seatId, { t: 'reset', at: Date.now() });
}
function trim(s) {
  if (s.messages.length > MAX_MESSAGES) s.messages = s.messages.slice(-MAX_MESSAGES);
}
/** 上下文窗口设置（建席/换模型时同步） */
function setContextWindow(seatId, w) { if (w) get(seatId).contextWindow = w; }

module.exports = { get, buildMessages, appendUser, appendAssistant, recordUsage, estimateUsage, snapshot, clear, setContextWindow, estimateTokens, HISTORY_DIR };
