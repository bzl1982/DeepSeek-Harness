'use strict';
/**
 * core/models.js —— 模型能力档案（能力画像 + 特长 + 缺点 + 角色适配）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这个文件解决什么问题？
 *
 *   用户原话：「每个模式的场景还得考虑每个模型的特长和缺点，
 *             随机设定角色时要考虑模型的能力。」
 *
 *   在它出现之前，角色是按**参会顺序**硬发的（第 1 个席位发第 1 个角色）。
 *   后果：随机点一个 AI 当"书记员"，如果它恰好是响应最慢的那个，
 *   整场会就被它拖住；点一个不会长文输出的当"架构师"，它给三行字敷衍。
 *
 *   → 所以必须先把"模型能干什么"变成**数据**，选角才有依据。
 * ─────────────────────────────────────────────────────────────────────
 *
 * 八维能力打分（1–5，5 = 最强）。
 * ★ 打分口径是「**在会议里**够不够用」，不是「模型跑分多少」：
 *   例：Gemini 的 1M 上下文写作 5 分，但它被安全策略拦截的概率也高，
 *   所以 stability 只给 3 —— 因为"会中途拒答"对一场 9 人会是致命的。
 *
 *   reasoning    深度推理：能不能自己发现隐含矛盾、做多步推导
 *   chinese      中文表达：中文语感、术语准确度（本项目的会议语言是中文）
 *   structure    结构化：能不能稳定输出"编号清单 / 表格 / 分块"这种可解析格式
 *   speed        响应速度：5 = 十几秒，1 = 分钟级（网页版含思考链）
 *   longOutput   长文承载：能不能一次给出 800 字以上还有信息密度
 *   multimodal   多模态：读图、读表格截图、读 PDF 版式
 *   search       联网检索：能不能自己上网查证（网页版多数可以，API 不行）
 *   stability    长会话稳定性：多轮之后是否容易跑偏 / 拒答 / 忘设定
 * ─────────────────────────────────────────────────────────────────────
 *
 * ★ 两个诚实的说明（写在代码里，避免以后被当成"精确测量"）：
 *   1. 这些分数是**基于本机实测与公开认知的工程估计**，不是基准测试结果。
 *      它们的作用是**排序**（谁更适合当书记员），不是**判优劣**。
 *   2. 分数集中维护在 traits 里，将来某次实测发现某模型明显不符，
 *      只改这一个数字，全链路（选角、模式推荐）自动跟着变。
 */

/** 能力维度顺序（用于 UI 画雷达图 / 计算距离） */
const TRAITS = Object.freeze([
  'reasoning', 'chinese', 'structure', 'speed',
  'longOutput', 'multimodal', 'search', 'stability',
]);

/** 维度中文名（UI 显示） */
const TRAIT_LABELS = Object.freeze({
  reasoning: '深度推理', chinese: '中文表达', structure: '结构化',
  speed: '响应速度', longOutput: '长文承载', multimodal: '多模态',
  search: '联网检索', stability: '长会话稳定',
});

/**
 * 模型档案。
 *
 * 每个条目的字段：
 *   id / label / channel      身份与通道（web = 网页版 webview，api = HTTP 接口）
 *   providerId                网页版对应 agentCatalog 的 id（API 模型无此项）
 *   traits                    八维打分
 *   strengths / weaknesses    人话的特长与缺点（直接进 UI 与文档）
 *   bestRoles / avoidRoles    角色适配（选角的硬约束来源）
 *   meetingNote               在会议里该怎么用（一句话）
 */
const MODEL_CATALOG = Object.freeze({
  /* ═══════════════ 网页版（webview 通道，免额度但慢） ═══════════════ */

  'deepseek-web': {
    id: 'deepseek-web', label: '深度求索-DeepSeek', channel: 'web',
    providerId: 'deepseek-web',
    traits: { reasoning: 5, chinese: 5, structure: 5, speed: 2, longOutput: 5, multimodal: 2, search: 3, stability: 5 },
    strengths: ['推理链完整，能自己发现隐含矛盾', '中文术语准，几乎不需要解释背景', '输出结构稳定，编号/表格不易跑形'],
    weaknesses: ['含思考链，响应最慢的一档（实测 34s+）', '长回复时容易在"思考中"阶段被判提前完成'],
    bestRoles: ['red-team', 'architect', 'fact-check'],
    avoidRoles: [],
    meetingNote: '当质证/架构这类"要深想"的角色最值；别当书记员，它慢而且写得太长。',
  },

  'chatgpt-web': {
    id: 'chatgpt-web', label: 'OpenAI-ChatGPT', channel: 'web',
    providerId: 'chatgpt-web',
    traits: { reasoning: 5, chinese: 4, structure: 5, speed: 3, longOutput: 5, multimodal: 4, search: 4, stability: 4 },
    strengths: ['综合最均衡，长文结构化输出最稳', '能主动画架构图/表格（HTML 渲染）', '多模态理解强，能读截图里的表格'],
    weaknesses: ['中文偶尔带英文句式', '长会话后期会忘掉早期的角色设定'],
    bestRoles: ['architect', 'red-team', 'executor', 'pm'],
    avoidRoles: [],
    meetingNote: '通用主力。要"一眼能看懂的结构化产出"就交给它。多轮会议里注意重述角色设定。',
  },

  'gemini-web': {
    id: 'gemini-web', label: '谷歌-Gemini', channel: 'web',
    providerId: 'gemini-web',
    traits: { reasoning: 4, chinese: 4, structure: 4, speed: 4, longOutput: 5, multimodal: 5, search: 4, stability: 3 },
    strengths: ['超长上下文，塞进整份长材料不丢细节', '多模态最强：读图、读版式、读手写', '整合搜索结果给事实性回答'],
    weaknesses: ['安全策略敏感，偶发中途拒答（实测会弹人机验证）', '输入框是 Quill，自动发送需专门适配'],
    bestRoles: ['retriever', 'fact-check', 'data-analyst'],
    avoidRoles: [],
    meetingNote: '给它"长材料 + 找事实"的活；别让它当唯一收敛者，它有拒答风险，会开完没结论。',
  },

  'kimi-web': {
    id: 'kimi-web', label: '月之暗面-Kimi', channel: 'web',
    providerId: 'kimi-web',
    traits: { reasoning: 3, chinese: 5, structure: 4, speed: 4, longOutput: 4, multimodal: 3, search: 5, stability: 4 },
    strengths: ['长文本摘要与信息抽取扎实', '中文口语自然，读起来不像翻译腔', '联网检索整合能力强，会给来源'],
    weaknesses: ['深度推理一般，遇到多步反证论证会绕', '偏好总结，容易被要求"挑错"时给出温和意见'],
    bestRoles: ['retriever', 'clerk', 'user-advocate'],
    avoidRoles: ['red-team'],
    meetingNote: '检索员/书记员的最优解。让它挑错要额外强调"必须列编号反例"，否则它会给你温和评价。',
  },

  'doubao-web': {
    id: 'doubao-web', label: '字节跳动-豆包', channel: 'web',
    providerId: 'doubao-web',
    traits: { reasoning: 3, chinese: 5, structure: 3, speed: 5, longOutput: 3, multimodal: 3, search: 4, stability: 3 },
    strengths: ['响应最快的一档，适合当主持/节奏控制者', '中文口语化最好，说人话能力强', '移动端产品打磨好，链路稳定'],
    weaknesses: ['明显谄媚倾向：容易附和上一条发言', '深度推理弱，做多步反驳会停在表面', '长文输出信息密度低（灌水）'],
    bestRoles: ['user-advocate', 'pm', 'generalist'],
    avoidRoles: ['red-team', 'fact-check'],
    meetingNote: '当"最挑剔的用户"很合适（口语化）。绝不能让它单独承担质证——它会顺着别人说。',
  },

  'tongyi-web': {
    id: 'tongyi-web', label: '阿里巴巴-通义千问', channel: 'web',
    providerId: 'tongyi-web',
    traits: { reasoning: 3, chinese: 5, structure: 4, speed: 4, longOutput: 4, multimodal: 3, search: 4, stability: 4 },
    strengths: ['中文公文/报告体最规范', '文档处理与表格整理扎实', '办事风格稳，不轻易跑偏'],
    weaknesses: ['输出保守，倾向给"两面都说说"的结论', '创新性观点少'],
    bestRoles: ['clerk', 'executor', 'compliance'],
    avoidRoles: ['reverse'],
    meetingNote: '收敛与落地类角色的稳选择。要它给立场必须明确点名"必须选一个并说明理由"。',
  },

  'yuanbao-web': {
    id: 'yuanbao-web', label: '腾讯-元宝', channel: 'web',
    providerId: 'yuanbao-web',
    traits: { reasoning: 3, chinese: 5, structure: 3, speed: 4, longOutput: 3, multimodal: 3, search: 5, stability: 4 },
    strengths: ['微信公众号/腾讯生态内容检索独有优势', '中文社交语境理解好', '联网检索响应快'],
    weaknesses: ['深度论证弱，倾向罗列信息', '结构化输出不稳定'],
    bestRoles: ['retriever', 'user-advocate'],
    avoidRoles: ['architect'],
    meetingNote: '需要"中文互联网上大家怎么看"时交给它。不要让它做架构或成本核算。',
  },

  'wenxin-web': {
    id: 'wenxin-web', label: '百度-文心', channel: 'web',
    providerId: 'wenxin-web',
    traits: { reasoning: 2, chinese: 4, structure: 3, speed: 4, longOutput: 3, multimodal: 2, search: 4, stability: 3 },
    strengths: ['中文知识库覆盖面广', '百度系检索联动'],
    weaknesses: ['套话多，实质性内容密度低', '质证时会给"还需具体分析"这类回避结论', '实测会出现验证码阻断（会议中直接掉线）'],
    bestRoles: ['generalist', 'retriever'],
    avoidRoles: ['red-team', 'fact-check', 'chair-assistant'],
    meetingNote: '当作第九个补充视角即可。它掉线概率最高，不要放进关键路径（如收敛者）。',
  },

  'google-search': {
    id: 'google-search', label: '谷歌-搜索', channel: 'web',
    providerId: 'google-search',
    traits: { reasoning: 1, chinese: 2, structure: 2, speed: 5, longOutput: 1, multimodal: 1, search: 5, stability: 5 },
    strengths: ['纯检索：给它关键词，返回结果页', '极快，无对话开销'],
    weaknesses: ['★ 不是对话模型：无角色扮演能力、无长文输出', '把角色前缀拼进 q= 会污染查询语义'],
    bestRoles: ['retriever'],
    avoidRoles: ['red-team', 'architect', 'cost-analyst', 'executor', 'chair-assistant', 'clerk', 'reverse', 'compliance', 'fact-check', 'user-advocate', 'pm', 'newcomer', 'data-analyst', 'generalist'],
    meetingNote: '只当检索员，且不要注入角色前缀（会把查询串搞乱）。它是 9 宫格里的"工具"不是"人"。',
  },

  /* ═══════════════ API 通道（HTTP，快但有额度成本） ═══════════════ */

  'api:deepseek': {
    id: 'api:deepseek', label: 'DeepSeek API', channel: 'api',
    providerKey: 'deepseek',
    traits: { reasoning: 5, chinese: 5, structure: 5, speed: 4, longOutput: 5, multimodal: 1, search: 1, stability: 5 },
    strengths: ['同款推理能力，但速度快一个量级（不必等网页渲染）', '稳定可编程，无验证码/无登录失效', '可精确控制长度与格式'],
    weaknesses: ['无联网能力（不能自己查证）', '计费（长会成本随轮数线性上涨）'],
    bestRoles: ['chair-assistant', 'architect', 'red-team'],
    avoidRoles: ['retriever'],
    meetingNote: '★ 主席/主持角色的唯一正确选择：每一轮都要它即时判断，网页版会把会拖到分钟级。',
  },

  'api:agne': {
    id: 'api:agne', label: 'Agne API', channel: 'api',
    providerKey: 'agne',
    traits: { reasoning: 3, chinese: 4, structure: 4, speed: 5, longOutput: 3, multimodal: 2, search: 1, stability: 4 },
    strengths: ['极快，适合高频短任务（点名、判停、记账）', '多模型族可选（含图像/视频，会议中用不到）'],
    weaknesses: ['深度推理中等', '上下文偏短，不能塞长材料'],
    bestRoles: ['chair-assistant', 'clerk'],
    avoidRoles: ['architect', 'retriever'],
    meetingNote: '当会议调度助手（判停、点名、生成轮纪要）性价比最高。',
  },

  'api:google': {
    id: 'api:google', label: 'Google API (Gemini)', channel: 'api',
    providerKey: 'google',
    traits: { reasoning: 4, chinese: 4, structure: 4, speed: 5, longOutput: 5, multimodal: 4, search: 2, stability: 4 },
    strengths: ['超长上下文 + 高速，长材料压缩的最佳执行者', '多模态可读图'],
    weaknesses: ['需注意模型名格式（走 generateContent 时不能用带前缀的 id）', '计费'],
    bestRoles: ['chair-assistant', 'data-analyst', 'fact-check'],
    avoidRoles: [],
    meetingNote: '当"全局压缩器"：每 5 轮把全部发言压成摘要，比网页版快得多。',
  },
});

/** 全部模型 id */
const MODEL_IDS = Object.freeze(Object.keys(MODEL_CATALOG));

/** 按通道取模型 */
function listByChannel(channel) {
  return MODEL_IDS.filter((id) => MODEL_CATALOG[id].channel === channel).map((id) => MODEL_CATALOG[id]);
}

/** 取单个模型档案 */
function getModel(id) {
  return MODEL_CATALOG[id] || null;
}

/**
 * 由网页版 providerId 反查模型档案。
 * 会议核心拿到的是 providerId（如 'deepseek-web'），需要转换成能力档案。
 */
function byProviderId(providerId) {
  return MODEL_IDS.map((id) => MODEL_CATALOG[id]).find((m) => m.providerId === providerId) || null;
}

/**
 * 模型对某个角色的适配分（0–100）。
 *
 * ★ 这里刻意做成"加权缺项惩罚"而不是简单平均：
 *   一个角色最看重的 1–2 个维度不达标，就应该**直接淘汰**，
 *   而不是靠其他维度的高分把它拉回来。
 *   例：书记员最看重 speed + structure，一个 reasoning=5/speed=1 的模型
 *   平均分不低，但当书记员会把整场会拖死 —— 必须被 penalize 掉。
 *
 * @param {string} modelId
 * @param {object} roleReq  角色需求画像（见 roles.js 的 REQ）
 * @returns {{ score:number, breakdown:object, veto:string|null }}
 */
function fitScore(modelId, roleReq = {}) {
  const m = MODEL_CATALOG[modelId];
  if (!m) return { score: 0, breakdown: {}, veto: 'unknown model' };

  // 硬禁：模型档案里显式声明"这角色别给我"
  if (Array.isArray(m.avoidRoles) && m.avoidRoles.includes(roleReq.roleId)) {
    return { score: 0, breakdown: {}, veto: `该模型档案声明不适合「${roleReq.label || roleReq.roleId}」` };
  }

  const weights = roleReq.weights || {};
  const floors = roleReq.floors || {};   // 某维度的最低门槛（低于即淘汰）

  let sum = 0;
  let wsum = 0;
  const breakdown = {};

  for (const t of TRAITS) {
    const w = weights[t] || 0;
    if (!w) continue;
    const v = m.traits[t] || 1;

    // 门槛淘汰：不满足最低要求 → 一票否决（返回 veto 但不立即 return，
    // 这样 breakdown 仍可展示给用户看"差在哪"，便于调参）
    if (floors[t] && v < floors[t]) {
      breakdown[t] = { value: v, weight: w, fail: true };
      return {
        score: 0,
        breakdown,
        veto: `「${TRAIT_LABELS[t]}」${v} 分低于该角色要求的 ${floors[t]} 分`,
      };
    }

    breakdown[t] = { value: v, weight: w };
    sum += v * w;
    wsum += 5 * w;   // 归一化：满分 5
  }

  const score = wsum ? Math.round((sum / wsum) * 100) : 0;
  return { score, breakdown, veto: null };
}

/**
 * 给一组"候选模型"排序列出最适合某角色的顺序。
 * @returns {Array<{modelId, score, veto, breakdown}>} 已按分数降序，veto 的排在最后
 */
function rankForRole(candidateIds = [], roleReq = {}) {
  return candidateIds
    .map((id) => ({ modelId: id, ...fitScore(id, roleReq) }))
    .sort((a, b) => {
      if (!!a.veto !== !!b.veto) return a.veto ? 1 : -1;
      return b.score - a.score;
    });
}

/**
 * 两个模型的"互补度"（0–100）：分越高，说明它们越不容易说同样的话。
 *
 * ★ 用途：反"同质化坍塌"。
 *   如果两个格子的能力画像高度相似（都是 reasoning=5/chinese=5/...），
 *   它们拿到同一个问题几乎必然给出雷同答案。
 *   选角时可以让"互补度高"的模型去承担**对立的两个角色**。
 */
function complementarity(aId, bId) {
  const a = MODEL_CATALOG[aId];
  const b = MODEL_CATALOG[bId];
  if (!a || !b) return 0;
  let diff = 0;
  for (const t of TRAITS) diff += Math.abs((a.traits[t] || 0) - (b.traits[t] || 0));
  return Math.round((diff / (4 * TRAITS.length)) * 100);  // 每维最大差 4
}

/** 列出全部模型（供 UI 渲染选择器） */
function listModels() {
  return MODEL_IDS.map((id) => {
    const m = MODEL_CATALOG[id];
    return {
      id: m.id, label: m.label, channel: m.channel,
      traits: { ...m.traits },
      strengths: [...m.strengths], weaknesses: [...m.weaknesses],
      bestRoles: [...(m.bestRoles || [])],
      meetingNote: m.meetingNote,
    };
  });
}

module.exports = {
  TRAITS,
  TRAIT_LABELS,
  MODEL_CATALOG,
  MODEL_IDS,
  getModel,
  byProviderId,
  listByChannel,
  listModels,
  fitScore,
  rankForRole,
  complementarity,
};
