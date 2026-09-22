'use strict';
/**
 * core/external.js —— 外部 AI 回答的「一等公民化」
 *
 * ─────────────────────────────────────────────────────────────────────
 * 用户的真实工作流（原话）：
 *   「程序写到某个功能写不出想要的效果……此时我就会让 AI 写一个咨询案，
 *     那一份咨询案问所有 AI，他们回答后，我复制回来给我的 AI 助手，
 *     最终选择优秀的尝试，还不行就再进行一轮，直到满意为止。」
 *
 * 里面最关键、也最容易被忽略的一步是 **「我复制回来」** ——
 * 用户本人在当"人肉消息总线"。
 *
 * 为什么必须把这一步建模成一等公民，而不是"手动往记录里插一条消息"：
 *   ① 插进去的消息**进不了上下文切片** → 系统内的 AI 看不到"外面的人怎么说"
 *      → 那一圈外部咨询等于白问（这是最致命的）
 *   ② 没有来源标记 → 事后审计说不清"这条结论是哪家给的"
 *   ③ 无法匿名 → 评标/质证时看到"元宝"会带品牌偏见（position/brand bias）
 *   ④ 若归为 senderType:'user' → 被切片当"用户输入"排除掉（切片只看非 user）
 *
 * ─── 与 adapters/human-relay.js 的分工（两者互补，不是重复）───
 *   - human-relay 解决**座位**问题：它作为 channel:'human' 的席位出现在流程里，
 *     让编排层"停在这里等人粘贴"（含超时不失败、标 human-pending）
 *   - external    解决**消息**问题：回答进来之后，它必须是一条来源可辨、
 *     可被切片、可被匿名、可被审计的会议消息
 *   一句话：前者管「什么时候问人」，后者管「人给的东西怎么进会议」。
 *   只用 human-relay，回答会顶着 'human-relay' 这个 senderId 进来，
 *   分不清是元宝给的还是谷歌给的；只用 external，流程里没人会停下来等你。
 * ─────────────────────────────────────────────────────────────────────
 */

/** 常见外部 AI 来源（UI 下拉用；用户也可填自定义名字）。 */
const EXTERNAL_SOURCES = [
  { id: '元宝', label: '腾讯元宝', hint: '中文语境强、给结论快' },
  { id: '谷歌', label: 'Google（搜索/AI）', hint: '资料新、引用多、英文资料强' },
  { id: '千问', label: '通义千问', hint: '中文工程实现细节好' },
  { id: 'DeepSeek', label: 'DeepSeek 网页版', hint: '推理深，慢' },
  { id: '豆包', label: '豆包', hint: '响应快，适合批量初筛' },
  { id: '混元', label: '腾讯混元', hint: '偏工程与安全视角' },
  { id: 'KIMI', label: 'Kimi', hint: '长文本阅读强' },
  { id: 'GPT', label: 'ChatGPT', hint: '结构化、给可运行代码稳' },
  { id: 'Gemini', label: 'Gemini', hint: '多模态、英文资料强' },
  { id: 'Agnes', label: 'Agnes（海外）', hint: '跑测试耐心、验证型回答' },
  { id: '其他', label: '其他来源', hint: '手动填名字' },
];

/** 各种写法 → 标准 id。用于把「腾讯元宝」「yuanbao」「腾讯-Yuanbao」归一。 */
const SOURCE_ALIASES = {
  元宝: ['元宝', '腾讯元宝', 'yuanbao', 'yb'],
  谷歌: ['谷歌', 'google', 'googlesearch', '谷歌搜索', 'gemini'],
  千问: ['千问', '通义', '通义千问', 'qwen', 'qw'],
  deepseek: ['deepseek', '深度求索', 'ds', 'dp'],
  豆包: ['豆包', 'doubao', 'db'],
  混元: ['混元', '腾讯混元', 'hunyuan', 'hy'],
  kimi: ['kimi', '月之暗面', 'moonshot'],
  gpt: ['gpt', 'chatgpt', 'openai', 'gpt5'],
  gemini: ['gemini', '谷歌ai'],
  agnes: ['agnes', 'agnes3', 'agnes 3.0 flash'],
};

/**
 * 把用户随便写的来源名归一到标准 id。
 * 认不出来就原样返回（不猜、不丢）—— 用户自定义的来源必须能保留。
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeSource(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return '未知来源';
  const key = raw.toLowerCase().replace(/[\s_\-（）()【】\[\]]/g, '');
  for (const [canonical, aliases] of Object.entries(SOURCE_ALIASES)) {
    if (key === canonical) return canonical;
    if (aliases.some((a) => key === a || key.includes(a))) {
      // 命中别名时返回「原始写法」而不是 canonical，避免把用户自定义的名字改掉
      return raw;
    }
  }
  return raw;
}

/**
 * 从粘贴内容里识别「来源标注」前缀，识别得出就剥掉。
 *
 * 用户粘贴时常常连自己写的标注一起带进来，例如：
 *   「【元宝】我认为应该先做接口冻结……」
 *   「--- 混元的回答 ---」
 *   「谷歌：问题是……」
 * 能识别就剥掉（避免标注被当成正文发给其它 AI），识别不出就原样保留。
 *
 * ★ 这里最大的风险不是"识别不出"，而是**误识别**：
 *   「我觉得应该这样做：先写测试，再写实现」也是一句普通的正文 ——
 *   若把冒号前的词当来源，就会把正文前半句**吃掉**，比不识别糟得多。
 *   所以第 ③ 类（冒号形式）加了硬判据：**冒号前的词必须是已知来源名**，
 *   或者冒号后面有空格（英文/自定义来源的常见写法）。
 *
 * @param {string} raw
 * @returns {{ text:string, provider:string|null }}
 */
function parsePastedLabel(raw) {
  const text = String(raw == null ? '' : raw);

  const isKnownSource = (name) => {
    const k = String(name == null ? '' : name).trim().toLowerCase();
    if (!k) return false;
    if (Object.keys(SOURCE_ALIASES).includes(k)) return true;
    return Object.values(SOURCE_ALIASES).some((arr) => arr.some((a) => a === k));
  };

  // ① 括号形式「【元宝】…」/「[Kimi] …」—— 意图最明确，无条件认
  let m = text.match(/^\s*[【[]\s*([^】\]]{1,20})\s*[】\]]\s*[:：\-—]?\s*/);
  if (m) return { text: text.slice(m[0].length).trim(), provider: m[1].trim() };

  // ② 分隔线形式「--- 混元的回答 ---」
  //    ★ 这里必须用**非贪婪** {1,20}?：贪婪会把「混元的回答」整体吃成来源名
  //      （回溯后留下 "混元的回" + "答"），得到的来源名字是错误的。
  m = text.match(/^\s*[-—=]{2,}\s*([^\s:：\n]{1,20}?)\s*(?:的回答|的答复|答)\s*[-—=]{2,}\s*[:：]?\s*/);
  if (m) return { text: text.slice(m[0].length).trim(), provider: m[1].trim() };

  // ③ 冒号形式「谷歌：…」/「Kimi: …」—— 必须过"已知来源"或"冒号后有空格"这一关
  m = text.match(/^\s*([^\s:：\n]{1,20})\s*[:：]\s*/);
  if (m) {
    const candidate = m[1].trim();
    const hasSpaceAfterColon = /^\s*[^\s:：\n]{1,20}\s*[:：]\s+/.test(text);
    if (isKnownSource(candidate) || hasSpaceAfterColon) {
      return { text: text.slice(m[0].length).trim(), provider: candidate };
    }
  }

  return { text: text.trim(), provider: null };
}

/**
 * 造一条「外部 AI 回答」消息。
 *
 * 约定 senderId = `external:<来源>`，三个地方都靠它：
 *   - 切片：OTHERS 按 `senderId !== selfId` 过滤 → 外部回答自动"看得到、
 *     又不会和任何参会者混淆"（没有任何参会者的 id 长这样）
 *   - 审计：按 senderId 分组 = "元宝给了几条"
 *   - 匿名：CANDIDATES 切片按**内容哈希**定序 → 与 provider 无关，
 *     所以外部回答同样能被匿名（防品牌偏见）
 *
 * @param {object} o
 *   - meetingId  必填
 *   - provider   来源名（元宝/谷歌/千问/…）
 *   - content    回答正文
 *   - model      具体模型名（可选，如 'DeepSeek-V3'）
 *   - url        来源链接（可选，便于回溯）
 *   - question   这条回答针对的问题（可选；外部回答常常不是针对当前议题，
 *                记下来避免被误当成"在回应本轮讨论"）
 *   - note       备注（可选）
 *   - round/kind/timestamp/id 透传
 * @returns {object} 符合 createMessage 形状的消息
 */
function createExternalMessage({
  meetingId,
  provider,
  content = '',
  model = null,
  url = null,
  question = null,
  note = null,
  round = 1,
  kind = null,
  timestamp = null,
  id = null,
  createMessage,
} = {}) {
  if (!meetingId) throw new Error('createExternalMessage: meetingId required');
  if (!provider) throw new Error('createExternalMessage: provider required');
  if (!createMessage) throw new Error('createExternalMessage: createMessage required（避免循环依赖，由调用方注入）');

  const source = normalizeSource(provider);
  const body = String(content == null ? '' : content).trim();
  if (!body) throw new Error('createExternalMessage: content 不能为空');

  return createMessage({
    meetingId,
    senderType: 'external',
    senderId: `external:${source}`,
    content: body,
    kind,
    round,
    ...(timestamp != null ? { timestamp } : {}),
    ...(id != null ? { id } : {}),
    external: {
      provider: source,
      model: model || null,
      url: url || null,
      question: question || null,
      note: note || null,
    },
  });
}

/**
 * 审计视图：按来源汇总（"这场会有多少结论其实是外部给的"）。
 * @param {Array<object>} messages
 */
function summarizeExternal(messages = []) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && m.senderType === 'external');
  const byProvider = {};
  for (const m of list) {
    const p = (m.external && m.external.provider) || '未知来源';
    byProvider[p] = (byProvider[p] || 0) + 1;
  }
  return {
    total: list.length,
    byProvider,
    providers: Object.keys(byProvider),
  };
}

/**
 * 把外部回答转成切片可用的发言条目（与 agent 消息同形）。
 *
 * ★ 这里刻意**只吐 senderId + content**，不吐 external 细节 ——
 *   provider 名一旦进了 prompt，参会者就会因为"这是元宝说的"而改变态度
 *   （品牌偏见）。要不要暴露来源，由调用方在切片层决定（默认不暴露）。
 *
 * @param {Array<object>} messages
 * @param {object} opts
 *   - blind   true = 匿名（默认 false，即显示 `外部-1` 这类无来源标签）
 */
function toSliceEntries(messages = [], { blind = false } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && m.senderType === 'external');
  return list.map((m, i) => ({
    senderId: blind ? `外部-${i + 1}` : m.senderId,
    content: m.content || '',
    external: true,
  }));
}

module.exports = {
  EXTERNAL_SOURCES,
  SOURCE_ALIASES,
  normalizeSource,
  parsePastedLabel,
  createExternalMessage,
  summarizeExternal,
  toSliceEntries,
};
