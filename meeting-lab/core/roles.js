'use strict';
/**
 * core/roles.js —— 角色库（盲点 A「同质化坍塌」的工程解法 + 用户需求「角色设定多种」）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须单独成模块，而不是写在 context-strategy.js 里：
 *
 *   context-strategy.js 里的角色是「providerId -> 角色文本」的**固定映射**
 *   （deepseek 永远当红队）。这有三个问题：
 *     1. 角色被绑死在"某个 AI 是谁"上，而不是"这场会需要什么职能"；
 *     2. 同一批 AI 无法换角色组重跑（用户要"角色设定多种"就是这个）；
 *     3. 换 provider、加第 10 个 AI、换格子顺序，角色指派就全乱。
 *
 *   正确抽象：**角色是「席位（seat）」的属性，不是 provider 的属性。**
 *   开一场会 = 选一套角色集 + 把角色按顺序发给当前参会者。
 *   谁坐哪把椅子由调用方决定，角色只管"这个席位该用什么视角说话"。
 * ─────────────────────────────────────────────────────────────────────
 *
 * 设计原则（七家共识 + Hy4-3 / KIMI3 补充）：
 *   A. 给「认知职能」，不给「人格腔调」。
 *      ✅「只找漏洞，必须列编号清单」   ❌「你是一个脾气火爆的评审」
 *      前者制造真实视角差异，后者只制造语气噪音。
 *   B. 每个角色必须有一条**互斥输出约束**（只看 X / 只做 Y / 禁止 Z），
 *      这是反趋同的真正机制——角色不是形容词，是"输出内容的边界"。
 *   C. 每个角色带一条**轻量格式约束**。格式差异本身就是反趋同手段：
 *      即使两个 AI 观点撞了，一个出编号清单、一个出成本表，读起来也不是复读机。
 *   D. 角色集内**职能必须互斥**，不允许两个席位同一职能（否则白占一个格子）。
 *      validateAssignment() 会强制检查这条。
 */

/**
 * 角色库（按认知职能分四类）。
 *
 * 每条：
 *   - id      稳定标识，写进存档/配置，永不改名
 *   - label   中文短名（UI 显示）
 *   - group   所属大类，用于 UI 分组与"每类至少一个"的检查
 *   - prompt  注入给网页 AI 的角色前缀（就是"互斥输出约束 + 格式约束"）
 */
const ROLE_CATALOG = Object.freeze({
  /* ═══════ 一、质证类：负责挑错、找风险、核事实（对抗性） ═══════ */

  'red-team': {
    id: 'red-team', label: '红队', group: 'challenge',
    prompt: '你是【红队评审】。职责：只找当前方案的漏洞、边界条件、隐藏风险和反例。'
      + '禁止总结、禁止附和、禁止说"总体不错"。必须给出至少 2 个具体反例或失败场景，用编号清单输出。',
  },
  'fact-check': {
    id: 'fact-check', label: '事实核查', group: 'challenge',
    prompt: '你是【事实核查员】。职责：逐条检查前述内容里的事实性断言，指出哪些没有依据、哪些是推测被当成了结论。'
      + '禁止发表自己的方案。输出格式：每条一行「断言 → 有据/无据/存疑 → 理由」。',
  },
  'compliance': {
    id: 'compliance', label: '合规审查', group: 'challenge',
    prompt: '你是【合规与风险审查员】。职责：只谈数据安全、隐私、法务、平台政策与账号风险。'
      + '禁止讨论技术实现优劣。若认为某项无合规风险，直接说"此项无合规风险"，不要展开。',
  },
  'reverse': {
    id: 'reverse', label: '反方', group: 'challenge',
    prompt: '你是【反方】。职责：无论当前主流意见是什么，你只论证它可能错在哪里，站在它的对立面。'
      + '禁止附和任何已有结论。但也不要为了反对而反对——必须给出"如果主流意见错了，最可能错在哪个假设"的具体推理。',
  },

  /* ═══════ 二、建设类：负责给方案、算账、落地（生产性） ═══════ */

  'architect': {
    id: 'architect', label: '架构师', group: 'build',
    prompt: '你是【架构师】。职责：只谈技术可行性与可扩展性、可维护性、演进路径与耦合边界。'
      + '禁止谈成本、禁止谈排期、禁止给市场判断。输出格式：先给结论一句话，再列 2–4 条技术依据。',
  },
  'cost-analyst': {
    id: 'cost-analyst', label: '成本分析师', group: 'build',
    prompt: '你是【成本分析师】。职责：把讨论中的每个主张折算成钱、时间与人力，并指出谁是主要成本项。'
      + '禁止评价方案好坏、禁止给技术建议。能用数字说话的一律用数字。输出格式：一张极简表格（项目 / 估算 / 假设）。',
  },
  'executor': {
    id: 'executor', label: '执行步骤', group: 'build',
    prompt: '你是【落地执行者】。职责：把当前结论翻译成可直接照做的步骤，并标出每步的前置条件与失败回退。'
      + '禁止讨论战略与理念。输出格式：有序步骤列表，每步一行「动作 → 前置条件 → 失败怎么办」。',
  },
  'data-analyst': {
    id: 'data-analyst', label: '数据核算', group: 'build',
    prompt: '你是【数据核算员】。职责：只给能量化、能验证的结论。凡是无法量化的主张，直接标注"不可量化，需补充数据"。'
      + '禁止写段落，只输出条目 + 数字 + 口径说明。',
  },

  /* ═══════ 三、代表类：负责替不同立场的人说话（视角拓展） ═══════ */

  'user-advocate': {
    id: 'user-advocate', label: '用户代言', group: 'represent',
    prompt: '你是【最挑剔的真实用户】。职责：站在使用者角度挑体验毛病，指出哪里看不懂、哪里会让人放弃。'
      + '禁止用技术术语，全程用大白话说人话。若确实没有体验问题，直接说"这次没问题"，不要硬凑。',
  },
  'pm': {
    id: 'pm', label: '产品经理', group: 'represent',
    prompt: '你是【产品经理】。职责：只谈优先级与取舍——做什么、不做什么、先做什么。'
      + '禁止写代码、禁止谈技术细节。输出格式：必做 / 可做 / 不做 三栏式清单，每项一句话理由。',
  },
  'newcomer': {
    id: 'newcomer', label: '新人视角', group: 'represent',
    prompt: '你是【刚加入团队的新人】。职责：提出最朴素、最基础、最容易被专家忽略的疑问，指出讨论中默认成立但从未被验证的前提。'
      + '禁止展现专业深度，禁止给方案。只提问，每个问题一行。',
  },

  /* ═══════ 四、收敛类：负责把发散的观点收成结论（组织性） ═══════ */

  'chair-assistant': {
    id: 'chair-assistant', label: '主持助理', group: 'converge',
    prompt: '你是【会议主持助理】。职责：把本轮各方观点收敛成「已达成共识 / 仍有分歧 / 待决问题 / 下一步动作」四块。'
      + '禁止引入任何新观点，只做归并。若存在分歧，必须点名是哪两方在哪个点上分歧。',
  },
  'clerk': {
    id: 'clerk', label: '书记员', group: 'converge',
    prompt: '你是【会议书记员】。职责：抓细节与遗漏——谁说了但没被回应、哪些结论缺少依据。'
      + '每条发言结尾必须附一句「我注意到的一点：…」。禁止复述已有结论。',
  },
  'generalist': {
    id: 'generalist', label: '基准与会者', group: 'converge',
    prompt: '你是【常规与会者】。职责：只给出主流、稳妥、可被多数人接受的判断，作为全场的观点基准线。'
      + '禁止提出激进方案。不需要标新立异，但必须明确说出你不同意谁、为什么。',
  },
  'retriever': {
    id: 'retriever', label: '检索员', group: 'converge',
    prompt: '你是【检索员】，不是聊天助手。职责：只返回与议题最相关的 3 条事实或资料线索，每条一句话。'
      + '禁止长篇论述、禁止给建议、禁止承接前文闲聊。凑不满 3 条就给 2 条，不编造。',
  },

  /* ═══════ 五、集成类（Q9 新增）：把"分头写的代码"拼成"能跑的" ═══════
     ★ 为什么独立一类、不复用收敛类：
       收敛类（主持助理）的互斥约束是"禁止引入新观点，只做归并"——它不碰代码。
       集成者必须能读错误输出、判断"哪里断了"、把各模块拼起来，这是全新职能。
       ★ 集成者【只报"哪里断了"，不修】——修复归原作者（它不知道原作者的意图，改了就是猜）。 */
  'integrator': {
    id: 'integrator', label: '集成工程师', group: 'integrate',
    prompt: '你是【集成工程师】。职责：把各模块的产物拼装成一个可运行的整体，'
      + '执行编译/运行/测试，定位"哪里断了"（哪行报错、哪个模块间调用签名对不上、哪个依赖没声明）。'
      + '★ 你只报问题清单，不写修复代码（修复归各模块原作者）。'
      + '输出格式：编号清单，每条「文件:行 → 错误信息 → 推测原因（哪个模块的签名/数据不对）」。'
      + '禁止复述契约全文，禁止给战略建议。',
  },
});

/**
 * 角色需求画像（选角依据 · 用户需求「随机设定角色时要考虑模型的能力」）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么每个角色都要有一份"能力要求"？
 *
 *   角色不是抽象职能，它对**执行者有硬性要求**：
 *     · 书记员要「快」——让响应最慢的模型当书记员，整场会被它拖住；
 *     · 主持助理要「稳」——让会中途拒答的模型当收敛者，会开完没有结论；
 *     · 成本分析师要「结构化」——不会出表格的模型当它，产出无法使用。
 *   所以选角不能按顺序硬发，必须做**能力匹配**。
 * ─────────────────────────────────────────────────────────────────────
 *
 * 字段：
 *   weights  各能力维度的重要性（对应 core/models.js 的 TRAITS，权重 1–5）
 *   floors   硬门槛：低于此分的模型**一票否决**，不允许坐这个席位
 *            （只给最关键的 1–2 个维度设门槛，门槛过多会导致无人可用）
 *
 * ★ 门槛的取值哲学：宁可让位子空着降级，也不要让不适配的模型硬坐。
 *   例：主持助理 stability 门槛 4 分 —— 因为它的产出是"全场结论"，
 *   一个会中途弹验证码的模型当收敛者，等于整场会白开。
 */
const ROLE_REQ = Object.freeze({
  /* 质证类 —— 靠推理深度吃饭 */
  'red-team':    { weights: { reasoning: 5, stability: 3, structure: 3, longOutput: 3 }, floors: { reasoning: 4 } },
  'fact-check':  { weights: { reasoning: 4, structure: 4, search: 3, stability: 4 },   floors: { reasoning: 3, stability: 3 } },
  'compliance':  { weights: { reasoning: 3, chinese: 4, stability: 4, structure: 3 },   floors: { stability: 3 } },
  'reverse':     { weights: { reasoning: 4, chinese: 4, stability: 3 },                 floors: { reasoning: 3 } },

  /* 建设类 —— 靠结构化输出与长文承载 */
  'architect':     { weights: { reasoning: 5, structure: 4, longOutput: 4 },            floors: { reasoning: 4 } },
  'cost-analyst':  { weights: { structure: 5, reasoning: 3, longOutput: 3 },            floors: { structure: 4 } },
  'executor':      { weights: { structure: 5, chinese: 4, longOutput: 3 },              floors: { structure: 4 } },
  'data-analyst':  { weights: { structure: 5, reasoning: 4, longOutput: 3 },            floors: { structure: 4 } },

  /* 代表类 —— 靠中文表达与视角转换 */
  'user-advocate': { weights: { chinese: 5, reasoning: 2, stability: 3 },               floors: { chinese: 4 } },
  'pm':            { weights: { structure: 4, chinese: 4, reasoning: 3 },               floors: { chinese: 3 } },
  'newcomer':      { weights: { chinese: 3, reasoning: 2, stability: 3 },               floors: null },

  /* 收敛类 —— 靠稳定性与结构化（门槛最严，因为它的产出是交付物） */
  'chair-assistant': { weights: { structure: 5, reasoning: 4, stability: 5, speed: 3 }, floors: { structure: 4, stability: 4 } },
  'clerk':           { weights: { speed: 5, structure: 4, chinese: 4 },                 floors: { speed: 4 } },
  'generalist':      { weights: { chinese: 3, stability: 3, reasoning: 2 },             floors: null },
  'retriever':       { weights: { search: 5, speed: 4, chinese: 3 },                    floors: { search: 4 } },

  /* 集成类 —— 要"能读错误输出 + 结构化定位"；★ 只报"哪里断了"，不写修复代码 */
  'integrator':      { weights: { structure: 5, reasoning: 4, speed: 3, longOutput: 3 }, floors: { structure: 4 } },
});

/**
 * 取某角色的需求画像（供 core/casting.js 的 fitScore 消费）。
 * @param {string} roleId
 * @returns {{roleId:string, label:string, weights:object, floors:object|null}}
 */
function roleReq(roleId) {
  const def = ROLE_CATALOG[roleId] || ROLE_CATALOG.generalist;
  const req = ROLE_REQ[def.id] || {};
  return {
    roleId: def.id,
    label: def.label,
    weights: { ...(req.weights || { chinese: 3, stability: 3 }) },
    floors: req.floors || null,
  };
}

/**
 * 预置角色集（= 一场会要用哪几把椅子）。
 *
 * 用户需求「角色设定多种」：同一批 AI 换一套 set 就是一场不同性质的会。
 * 每套 set 内的 group 分布尽量均衡——**每类至少一个**是这套设计的硬要求：
 *   只有质证没有建设 → 会开成批斗会；
 *   只有建设没有质证 → 会开成互相点赞；
 *   没有收敛类     → 会开完没有结论。
 */
const ROLE_SETS = Object.freeze({
  /** 3 席（用户裁决 4：测试阶段先用 3 个）——最小可用的"三权分立" */
  'trio': {
    id: 'trio', label: '三人组（建设 / 质证 / 收敛）',
    seats: ['architect', 'red-team', 'chair-assistant'],
  },
  /** 3 席·内容审阅（对"一份材料"而不是"一个问题"） */
  'trio-review': {
    id: 'trio-review', label: '三人审阅（事实 / 体验 / 归并）',
    seats: ['fact-check', 'user-advocate', 'clerk'],
  },
  /** 5 席·风险审查 */
  'risk-audit-5': {
    id: 'risk-audit-5', label: '风险审查五人组',
    seats: ['red-team', 'compliance', 'fact-check', 'executor', 'chair-assistant'],
  },
  /** 7 席·技术选型 */
  'tech-7': {
    id: 'tech-7', label: '技术选型七人组',
    seats: ['architect', 'cost-analyst', 'executor', 'red-team', 'data-analyst', 'pm', 'chair-assistant'],
  },
  /** 9 席·产品评审（满员） */
  'product-9': {
    id: 'product-9', label: '产品评审九人组',
    seats: [
      'architect', 'cost-analyst', 'executor',
      'red-team', 'compliance', 'fact-check',
      'user-advocate', 'pm', 'chair-assistant',
    ],
  },
  /** 9 席·发散（刻意多放质证与代表类，用于早期找问题） */
  'diverge-9': {
    id: 'diverge-9', label: '发散九人组（多视角挑问题）',
    seats: [
      'red-team', 'reverse', 'fact-check', 'compliance', 'newcomer',
      'user-advocate', 'data-analyst', 'architect', 'clerk',
    ],
  },
  /** 7 席·工程交付（Q9：含集成工程师，用于 build 模式"分头写 + 集成验证"） */
  'build-7': {
    id: 'build-7', label: '工程交付七人组（架构 + 实现 + 集成）',
    seats: [
      'pm', 'user-advocate',            // 需求澄清（代表类）
      'architect', 'executor', 'cost-analyst',  // 架构 + 实现（建设类）
      'integrator',                      // ★ 集成验证（集成类，只报"哪里断了"不修）
      'red-team',                        // 质证（挑错/复评）
    ],
  },
});

/** 把 ROLE_SETS 里可能写错的 id 兜底成 generalist（防止 set 定义笔误直接崩） */
function fixSeat(id) {
  return ROLE_CATALOG[id] ? id : 'generalist';
}

/** 取单个角色定义 */
function getRole(roleId) {
  return ROLE_CATALOG[roleId] || null;
}

/**
 * 把一套角色分配给当前参会者。
 *
 * ★ 分配规则（顺序无关性很重要，否则换格子顺序就换结论）：
 *   按 set.seats 的声明顺序，依次发给 participants 的顺序位。
 *   最后一个收敛类角色**总是落在最后一个席位**——因为收敛类的输出
 *   在语义上要"看过所有人"，放最后一名符合会议直觉。
 *
 * @param {string[]} participants          参会者 id（顺序 = 席位顺序）
 * @param {object}   opts
 *   - set     预置集 id（默认 'trio'）
 *   - roles   直接给角色 id 数组（优先级高于 set，允许自定义）
 *   - promptOverrides  { roleId: '自定义 prompt' }  临时改写某角色措辞
 * @returns {{ providerId:string, roleId:string, label:string, group:string, prompt:string }[]}
 */
function assignRoles(participants = [], { set = 'trio', roles = null, promptOverrides = {} } = {}) {
  if (!Array.isArray(participants) || participants.length === 0) return [];

  let seatIds;
  if (Array.isArray(roles) && roles.length) {
    seatIds = roles.map(fixSeat);
  } else {
    const preset = ROLE_SETS[set];
    if (!preset) throw new Error(`assignRoles: unknown role set "${set}"`);
    seatIds = [...preset.seats];
  }

  // 席位不够 → 用 generalist 补齐（不报错，但调用方可从 toJSON 里看到补位）
  while (seatIds.length < participants.length) seatIds.push('generalist');
  // 席位多余 → 截断（多出来的角色这场没人坐）
  seatIds = seatIds.slice(0, participants.length);

  return participants.map((providerId, i) => {
    const roleId = seatIds[i];
    const def = ROLE_CATALOG[roleId] || ROLE_CATALOG.generalist;
    return {
      providerId,
      roleId: def.id,
      label: def.label,
      group: def.group,
      prompt: promptOverrides[def.id] || def.prompt,
    };
  });
}

/**
 * 校验一次分配是否健康——这是**防"9 个复读机"的最后一道闸**。
 *
 * 检查项：
 *   1. 职能不得重复（两个席位同一角色 = 白占一个格子，必然复读）
 *   2. 四个大类里，质证类与收敛类必须都在场
 *      （只有质证=批斗会；缺质证=互相点赞；缺收敛=开完没结论）
 *   3. 收敛类角色若在第一位，给出提示（它没内容可收敛）
 *
 * @returns {{ ok:boolean, errors:string[], warnings:string[] }}
 */
function validateAssignment(assignment = []) {
  const errors = [];
  const warnings = [];

  const seen = new Map();
  for (const a of assignment) {
    if (!ROLE_CATALOG[a.roleId] && a.roleId !== 'generalist') {
      errors.push(`未知角色 id：${a.roleId}`);
    }
    if (seen.has(a.roleId)) {
      errors.push(`角色重复：${a.label}（${a.roleId}）同时给了 ${seen.get(a.roleId)} 和 ${a.providerId} —— 必然产出雷同内容`);
    } else {
      seen.set(a.roleId, a.providerId);
    }
  }

  const groups = new Set(assignment.map((a) => a.group));
  if (assignment.length >= 2) {
    if (!groups.has('challenge')) errors.push('缺少【质证类】角色：没有人在挑错，会议会变成互相点赞');
    if (!groups.has('converge')) warnings.push('缺少【收敛类】角色：会开完不会自动产出结论，需要人工归并');
  }
  if (assignment.length >= 3 && !groups.has('build')) {
    warnings.push('缺少【建设类】角色：全是审查意见，没有可执行方案');
  }

  // 收敛类必须在最后（它要"看过所有人"才有内容可归并）
  const firstConverge = assignment.findIndex((a) => a.group === 'converge');
  if (firstConverge === 0 && assignment.length > 1) {
    warnings.push('收敛类角色排在第一位：它前面没有任何发言可收敛，建议放到末位');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 把分配结果转成 composePrompt 需要的 `providerId -> 角色文本` 映射。
 *
 * 用途：`composePrompt({ task, role: map[providerId], ... })`
 * —— context-strategy.js 的 composePrompt 已支持显式传入 `role`，
 *    所以这里**不需要修改任何现有文件**就能接上角色分化。
 */
function toPromptRoleMap(assignment = []) {
  const map = {};
  for (const a of assignment) map[a.providerId] = a.prompt;
  return map;
}

/** 列出全部角色（供 UI 渲染角色选择器） */
function listRoles() {
  return Object.values(ROLE_CATALOG).map(({ id, label, group, prompt }) => ({ id, label, group, prompt }));
}

/** 列出全部角色集（供 UI 渲染模式/角色组下拉） */
function listRoleSets() {
  return Object.values(ROLE_SETS).map((s) => ({
    id: s.id, label: s.label, seats: s.seats.length, roles: [...s.seats],
  }));
}

module.exports = {
  ROLE_CATALOG,
  ROLE_REQ,
  ROLE_SETS,
  getRole,
  roleReq,
  assignRoles,
  validateAssignment,
  toPromptRoleMap,
  listRoles,
  listRoleSets,
};
