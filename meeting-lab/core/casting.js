'use strict';
/**
 * core/casting.js —— 选角引擎（能力感知的角色分配）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 用户原话：「随机设定角色时要考虑模型的能力。」
 *
 *   这句话里有两个看似矛盾的要求，必须讲清楚它们怎么共存：
 *
 *     「随机」     → 同一批 AI、同一套角色组，每次开会的分配**应该不同**。
 *                    否则每次都是 DeepSeek 当红队、ChatGPT 当架构师，
 *                    你永远只见过这一种组合，等于放弃了探索。
 *
 *     「考虑能力」 → 但"随机"不能把模型扔到它做不到的位子上。
 *                    让一个 speed=1 的模型当书记员，整场会等它。
 *
 *   所以正确的模型是：**能力先做硬约束（门槛 + 黑名单），
 *   再在"够格的人"里做加权随机。**
 *
 *       候选池 = 所有参会模型 − 被一票否决的 − 已被占座的
 *       选中概率 ∝ (适配分)^^sharpness
 *       sharpness 越大越确定；越小越随机
 *
 *   → 结果：永远不会出现"能力不匹配"的分配，
 *           但在"都够格"的人里，每次的组合会不一样。
 * ─────────────────────────────────────────────────────────────────────
 *
 * 分配顺序也有讲究：**约束最紧的席位先分配**。
 *   例：一套角色组里，"检索员"要求 search≥4，只有 2 个模型够格；
 *   而"新人视角"几乎没有门槛，谁都行。
 *   如果先分配"新人视角"（随意挑），可能把仅有的 2 个检索型模型占掉一个，
 *   等轮到"检索员"时就无人可用了 —— 这是经典 CSP 的 fail-first 启发式。
 * ─────────────────────────────────────────────────────────────────────
 */

const { getRole, roleReq, ROLE_SETS, ROLE_CATALOG, validateAssignment } = require('./roles');
const { getModel, fitScore, MODEL_CATALOG, complementarity } = require('./models');

/* ─────────────── 可复现随机（同一个 seed 永远得到同一场会） ─────────────── */

/** 字符串 → 32 位整数种子 */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小而快的确定性 PRNG */
function makeRng(seed) {
  let a = (typeof seed === 'string' ? hashSeed(seed) : (seed >>> 0) || 1) >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 按权重抽一个（权重为 0 的永不选中）。
 * @param {Array<{item:any, weight:number}>} pool
 * @param {Function} rng
 */
function weightedPick(pool, rng) {
  const total = pool.reduce((s, p) => s + Math.max(0, p.weight), 0);
  if (total <= 0) return pool.length ? pool[Math.floor(rng() * pool.length)].item : null;
  let r = rng() * total;
  for (const p of pool) {
    r -= Math.max(0, p.weight);
    if (r <= 0) return p.item;
  }
  return pool[pool.length - 1].item;
}

/**
 * 核心：给参会者分配角色。
 *
 * @param {string[]} participants       参会模型 id（= MODEL_CATALOG 的 key，如 'deepseek-web'）
 * @param {object}   opts
 *   - set       角色组 id（默认 'trio'）
 *   - roles     直接指定角色 id 数组（优先级高于 set）
 *   - seed      随机种子（字符串或数字）。不传则用时间戳 → 每次不同
 *   - sharpness 选择锐度（默认 3）：
 *                 1 = 接近均匀随机（爱怎么分怎么分，只看够不够格）
 *                 6 = 强烈偏向最高分（几乎总是最优解）
 *   - preferComplementary  是否让"对立席位"优先选能力互补的模型（默认 true）
 *   - promptOverrides      { roleId: '自定义措辞' }
 * @returns {{
 *   assignment: Array<{providerId, modelId, roleId, label, group, prompt, fitScore, reason}>,
 *   seed: string|number,
 *   ledger: Array<object>,     // 每个席位的候选排名（可解释、可审计）
 *   warnings: string[],
 *   ok: boolean
 * }}
 */
function castRoles(participants = [], {
  set = 'trio',
  roles = null,
  seed = null,
  size = null,
  sharpness = 3,
  preferComplementary = true,
  promptOverrides = {},
} = {}) {
  const warnings = [];
  const effectiveSeed = seed === null || seed === undefined
    ? `t${Date.now()}` : seed;
  const rng = makeRng(effectiveSeed);

  if (!Array.isArray(participants) || participants.length === 0) {
    return { assignment: [], seed: effectiveSeed, ledger: [], warnings: ['没有参会者'], ok: false };
  }

  /* ---- 1) 确定这场会有哪几把椅子 ---- */
  let seatIds;
  if (Array.isArray(roles) && roles.length) {
    seatIds = roles.map((r) => (ROLE_CATALOG[r] ? r : 'generalist'));
  } else {
    const preset = ROLE_SETS[set];
    if (!preset) throw new Error(`castRoles: unknown role set "${set}"`);
    seatIds = [...preset.seats];
  }

  /* ---- 2) 会议规模 = min(参会者, 席位) ----
   *
   * ★ 这里有个容易写错的地方（本项目实际踩过，被 validateAssignment 抓出来）：
   *   会议规模必须由**角色组**决定，不能被参会者数量随意扩张。
   *
   *   错法：参会者 12 个、product-9 只有 9 席 → 给多出的 3 个各补一个
   *        「基准与会者」席位 → 三个格子说一样的话，白占位置。
   *   对法：只上前 N 个（N = 席位数），并明确告诉你谁没上台。
   *
   *   想让更多人上台 → 换更大的角色组；别让引擎偷偷复制角色。
   */
  const seatCount = seatIds.length;
  let n = Number.isInteger(size) && size > 0 ? size : Math.min(participants.length, seatCount);

  if (n > seatCount) {
    while (seatIds.length < n) seatIds.push('generalist');
    warnings.push(
      `指定规模 ${n} 超过角色组「${set}」的 ${seatCount} 席，多出的席位复用「基准与会者」`
      + '——会产生雷同内容，建议改用更大的角色组',
    );
  }
  n = Math.min(n, participants.length);
  seatIds = seatIds.slice(0, n);

  /* ★ 候选池 = **全部参会者**，而不是"数组里排前 N 个"。
   *
   *   谁上台应该由**能力**决定，不由传参顺序决定。
   *   反例（实测过）：参会顺序是 alphabetically 排的 web 模型时，
   *   `google-search`（reasoning=1、不能对话）排在前面被拉上台，
   *   结果它被迫坐「产品经理」席位 —— 而后面更强的 API 模型没机会上。
   *
   *   所以：把全部人放进候选池，让 9 把椅子自然地挑走最适配的 9 个人，
   *   剩下的（最不适配这套角色组的）自然落选。
   */
  const seated = participants;

  /* ---- 3) 对每把椅子，先算出所有入座者的适配情况 ---- */
  const seats = seatIds.map((roleId, index) => {
    const req = roleReq(roleId);
    const def = getRole(roleId) || ROLE_CATALOG.generalist;
    const candidates = seated.map((pid) => {
      const r = fitScore(pid, req);
      return { modelId: pid, score: r.score, veto: r.veto, breakdown: r.breakdown };
    }).sort((a, b) => (a.veto ? 1 : 0) - (b.veto ? 1 : 0) || b.score - a.score);

    const eligible = candidates.filter((c) => !c.veto);
    return { index, roleId, def, req, candidates, eligible, assignedTo: null };
  });

  /* ---- 3) fail-first：可选人最少的椅子先分配 ---- */
  const order = [...seats].sort((a, b) => a.eligible.length - b.eligible.length || a.index - b.index);

  const taken = new Set();   // 已占座的模型
  const ledger = [];

  for (const seat of order) {
    // 池 = 够格 且 没被占
    let pool = seat.eligible.filter((c) => !taken.has(c.modelId));

    // 互补性加成：如果已有"对立席位"分配完毕，让能力差异大的模型优先
    let weights = pool.map((c) => ({ item: c, weight: Math.pow(Math.max(1, c.score) / 100, sharpness) }));
    if (preferComplementary && taken.size) {
      const wantsOpposite = ['red-team', 'reverse', 'fact-check', 'user-advocate', 'newcomer']
        .includes(seat.roleId);
      if (wantsOpposite) {
        weights = pool.map((c) => {
          const avgComp = [...taken].reduce((s, t) => s + complementarity(c.modelId, t), 0) / taken.size;
          // 互补度 0–100 → 乘数 0.7–1.3
          const boost = 0.7 + (avgComp / 100) * 0.6;
          return { item: c, weight: Math.pow(Math.max(1, c.score) / 100, sharpness) * boost };
        });
      }
    }

    let picked = null;

    if (pool.length) {
      // ★ 锐度语义：
      //   sharpness 小 → 在"够格的人"里接近均匀随机（探索不同组合）
      //   sharpness 大 → 退化为确定性择优（软 argmax），避免"两个席位的
      //                  候选分只差 1 分、却因随机抽签抽到了差的那个"
      // 12 是分水岭：超过它意味着"我要最强的，别给我抽签"。
      if (sharpness >= 12) {
        picked = weights.reduce((best, w) => (w.weight > best.weight ? w : best), weights[0]).item;
      } else {
        picked = weightedPick(weights, rng);
      }
    }

    // 降级链：够格的人被占完了 → 从"被否决的"里按分数挑最好的（并记警告）
    let degradedFrom = null;
    if (!picked) {
      const fallback = seat.candidates.filter((c) => !taken.has(c.modelId));
      if (fallback.length) {
        picked = fallback[0];
        degradedFrom = picked.veto;
        warnings.push(
          `席位「${seat.def.label}」无合格人选（够格者已被其他席位占用），`
          + `降级使用 ${picked.modelId}：${picked.veto}`,
        );
      }
    }

    if (!picked) {
      warnings.push(`席位「${seat.def.label}」无人可分配（参会者不足），本场空置`);
      ledger.push({ roleId: seat.roleId, label: seat.def.label, ranked: seat.candidates, assigned: null });
      continue;
    }

    taken.add(picked.modelId);
    seat.assignedTo = picked;

    ledger.push({
      roleId: seat.roleId,
      label: seat.def.label,
      assigned: picked.modelId,
      score: picked.score,
      degradedFrom,
      ranked: seat.candidates.map((c) => ({
        modelId: c.modelId, score: c.score, veto: c.veto,
      })),
    });
  }

  /* ---- 3.5) 谁没上台（按能力择优后自然落选的人） ---- */
  const unseated = participants.filter((p) => !taken.has(p));
  if (unseated.length) {
    const names = unseated.map((p) => {
      const m = getModel(p);
      return m ? m.label : p;
    });
    warnings.push(
      `角色组「${set}」只有 ${seatCount} 席：${unseated.length} 个模型落选（${names.join('、')}）`
      + '——按能力择优后它们不是当前席位的合适人选。要全部上场请选更大的角色组。',
    );
  }

  /* ---- 4) 输出（结构与 assignRoles 兼容，外加解释字段） ---- */
  const assignment = seats
    .filter((s) => s.assignedTo)
    .sort((a, b) => a.index - b.index)
    .map((s) => {
      const m = getModel(s.assignedTo.modelId);
      const reason = s.assignedTo.veto
        ? `降级：${s.assignedTo.veto}`
        : `适配 ${s.assignedTo.score} 分（${topDims(s.assignedTo.breakdown)}）`;
      return {
        providerId: s.assignedTo.modelId,
        modelId: s.assignedTo.modelId,
        channel: m ? m.channel : 'web',
        roleId: s.def.id,
        label: s.def.label,
        group: s.def.group,
        prompt: promptOverrides[s.def.id] || s.def.prompt,
        fitScore: s.assignedTo.score,
        reason,
      };
    });

  /* ---- 5) 健康检查（复用 roles.js 的职能互斥校验） ---- */
  const health = validateAssignment(assignment);
  warnings.push(...health.errors, ...health.warnings);

  return {
    assignment,
    seed: effectiveSeed,
    ledger,
    warnings,
    ok: health.ok,
  };
}

/** 从 breakdown 里挑出"贡献最大的两个维度"做成人话，用于展示为什么选它 */
function topDims(breakdown = {}) {
  const items = Object.entries(breakdown)
    .filter(([, v]) => v && !v.fail && v.weight)
    .map(([k, v]) => ({ k, v: v.value, w: v.weight * v.value }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 2);
  const CN = {
    reasoning: '推理', chinese: '中文', structure: '结构化', speed: '速度',
    longOutput: '长文', multimodal: '多模态', search: '检索', stability: '稳定性',
  };
  return items.map((i) => `${CN[i.k] || i.k}${i.v}`).join(' + ') || '无显著优势';
}

/**
 * 「随机一键排」：给一个模型集合，自动排出一套合理的会议编制。
 *
 * 用途：用户点"随机分组"时调用。它做两件事：
 *   1. 选角色组（按参会规模挑最合适的预置集）
 *   2. 做能力感知的选角
 *
 * @param {string[]} participants
 * @param {object} opts { set, size, seed, sharpness }
 */
function autoCast(participants = [], opts = {}) {
  const n = participants.length;
  let set = opts.set;
  if (!set) {
    // 按人数挑预置集：3 席优先 trio，5 席 risk-audit-5，7 席 tech-7，其余按规模选
    if (n <= 3) set = 'trio';
    else if (n <= 5) set = 'risk-audit-5';
    else if (n <= 7) set = 'tech-7';
    else if (n <= 9) set = (opts.mode === 'diverge' ? 'diverge-9' : 'product-9');
    else set = 'product-9';
  }
  return { ...castRoles(participants, { ...opts, set }), set };
}

/**
 * 为某个"会议模式"推荐编制（模式里带 modelFit 要求时用）。
 *
 * @param {object} mode   getMode() 的返回值
 * @param {string[]} participants
 * @param {object} opts   { seed, sharpness }
 */
function castForMode(mode, participants = [], opts = {}) {
  const want = (mode && mode.preferRoleGroups) || null;
  const set = (mode && mode.recommendedSet) || undefined;
  const base = autoCast(participants, { ...opts, set });
  if (!want) return base;

  // 模式偏好某些职能类 → 在分配结果里校验，缺失就记警告（不强行改分配）
  const groups = new Set(base.assignment.map((a) => a.group));
  const missing = want.filter((g) => !groups.has(g));
  if (missing.length) {
    base.warnings.push(
      `「${mode.label}」偏好 ${missing.join('/')} 类角色，但当前角色组没有——`
      + `建议切换角色组（当前：${base.set}）`,
    );
  }
  return base;
}

module.exports = {
  hashSeed,
  makeRng,
  castRoles,
  autoCast,
  castForMode,
  topDims,
};
