'use strict';
/**
 * core/api-seats.js —— API 席位生命周期（第 4 步，2026-09-25）
 *
 * 50 席上限（用户需求）；席位持久化在主进程 seats.json；默认席位首启自动生成
 * （每提供方第一个对话模型一席，与旧 API_CANDIDATES 等价，存量 3 席不掉）。
 * nonChat 模型（image/video/embedding…）拒绝建席（Q2 元数据表）。
 */

const ApiClient = require('./api-client');

const MAX_SEATS = 50;
let seatsCache = [];
let loaded = false;

async function loadSeats() {
  seatsCache = await ApiClient.listSeats() || [];
  loaded = true;
  return seatsCache;
}
function list() { return seatsCache; }
function get(seatId) { return seatsCache.find((s) => s.seatId === seatId) || null; }

/** 建席。modelMeta 可传（含 nonChat 判断），未传则不校验。 */
async function addSeat({ providerId, model, title, systemPrompt, params, perms, modelMeta }) {
  if (seatsCache.length >= MAX_SEATS) throw new Error('SEAT_LIMIT_50（最多 50 个对话窗口）');
  if (modelMeta && modelMeta.nonChat) throw new Error('NON_CHAT_MODEL（' + model + ' 是 ' + modelMeta.kind + ' 模型，不能建对话席位）');
  if (seatsCache.some((s) => s.providerId === providerId && s.model === model)) throw new Error('DUPLICATE_SEAT（该提供方已存在同模型席位）');
  const seat = {
    seatId: 'seat-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    providerId, model,
    title: title || (providerId.replace(/^imp-/, '') + ' · ' + model),
    systemPrompt: systemPrompt || '',
    params: { reasoning: 'off', maxTokens: null, temperature: null, ...(params || {}) },
    perms: { allowImage: true, allowFile: true, maxTokensPerRequest: 4096, maxConcurrentRequests: 1, ...(perms || {}) },
    createdAt: Date.now(),
  };
  seatsCache.push(seat);
  await ApiClient.saveSeats(seatsCache);
  return seat;
}

async function updateSeat(seatId, patch) {
  const s = get(seatId);
  if (!s) throw new Error('NO_SEAT');
  Object.assign(s, patch, { seatId });   // seatId 不可变
  await ApiClient.saveSeats(seatsCache);
  return s;
}

async function removeSeat(seatId) {
  seatsCache = seatsCache.filter((s) => s.seatId !== seatId);
  await ApiClient.saveSeats(seatsCache);
}

/** 首启默认席位：每提供方第一个非 nonChat 模型一席（与旧 API_CANDIDATES 等价） */
async function ensureDefaultSeats() {
  await loadSeats();
  if (seatsCache.length) return { created: 0, total: seatsCache.length };
  const provs = await ApiClient.listProviders();
  let created = 0;
  for (const p of provs) {
    if (!p.hasKey) continue;
    const models = (p.modelsCache || []).filter((m) => !m.nonChat);
    const model = models.length ? models[0].id : null;
    if (!model) continue;
    try { await addSeat({ providerId: p.id, model, title: p.name + ' · ' + model }); created++; } catch (_) {}
  }
  return { created, total: seatsCache.length };
}

module.exports = { MAX_SEATS, loadSeats, list, get, addSeat, updateSeat, removeSeat, ensureDefaultSeats, isLoaded: () => loaded };
