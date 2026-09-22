'use strict';
/**
 * core/modes.js —— 会议模式（用户需求：「各种模式，例如共同审阅、协助、反复修正」）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这一层解决什么问题？
 *
 *   speaker.js 只回答「**这一轮**谁发言」（4 种策略）。
 *   但"共同审阅 / 协助 / 反复修正"不是"一轮里谁发言"的差别，
 *   而是**多阶段 + 每个阶段看什么 + 什么时候停**的差别：
 *
 *     共同审阅 = 先各自独立看材料（防锚定）→ 交叉质证 → 归并
 *     协助     = 先各出方案 → 会诊挑错 → 收敛成可执行结论
 *     反复修正 = 挑错 → 修订 → 再挑错 →「挑不出新问题」才停
 *
 *   所以模式 = 阶段序列 + 上下文切片规则 + 终止判据。
 *   模式**不认识 DOM、不认识网页、不认识 Electron**——纯逻辑，可单测。
 * ─────────────────────────────────────────────────────────────────────
 *
 * 三个设计要点（都有出处）：
 *
 *   1. **上下文切片（slice）比"换角色"更能制造真实差异**（Hy4-3 结论）。
 *      给不同发言者喂**不同的前文切片**：质证者只看别人的结论、
 *      修订者只看批评清单、归并者看全部。这比只改语气有效得多。
 *
 *   2. **"先独立后交叉"是审阅类的关键顺序**（防锚定效应）。
 *      如果第一轮就让人看到别人的意见，后面的发言会全部向第一个发言者收敛，
 *      最终 9 份回答互相抄——这正是"同质化坍塌"在流程层的成因。
 *
 *   3. **反复修正必须有客观终止判据**，不能靠轮数硬切。
 *      判据 = 「本轮批评集合相对上一轮无新增」→ 纯集合运算，可单测。
 */

/** 发言方式（与 speaker.js 的 MODE 对齐，模式层不重造） */
const SPEAK = Object.freeze({
  PARALLEL: 'parallel',   // 同时发言
  SEQUENTIAL: 'sequential', // 依次发言（后者能看到前者）
});

/** 上下文切片种类 */
const SLICE = Object.freeze({
  TASK: 'task',           // 只给本轮任务（原始输入）
  MATERIAL: 'material',   // 给待审阅的材料
  OTHERS: 'others',       // 给「别人的」发言（不含自己的）—— 防自我强化
  ALL: 'all',             // 给全部发言（归并者用）
  CRITIQUES: 'critiques', // 给上一阶段的批评清单（修订者用）
  DRAFT: 'draft',         // 给当前草稿（挑错者用）
  NONE: 'none',           // 不给任何会议上下文（纯角色开场）
  // ★ Q6：分头实现时执行者该看到的"最小切片"
  // = 冻结契约全文 + 自己负责的模块说明 + 每个同伴模块的一行签名（不展开）
  // 关键：**不给"别人的实现细节"，只给"别人的接口"**——这是"接口先行"的本意。
  // 保证并行不互相等待，同时约束住所有人的函数签名/数据结构。
  CONTRACT: 'contract',

  // ★ 评标专用切片（tournament 的「评标」「复评」阶段）。
  // = 全部候选方案，**匿名化**（方案A/方案B…，认不出是谁写的）
  //   + **确定性顺序**（按内容哈希排，与 senderId 无关）
  //   + **只取候选本体**，不含任何评分/名次/结论。
  //
  // 为什么不能用 OTHERS（这是第五轮的一处关键判断）：
  //   ① OTHERS 抽掉"自己那份"→ 每个评审者只排 N-1 份，且各人排除的**不是同一份**
  //      → 各方案被排次数不等 → Borda 均值分母不同 → 跨方案比较失真。
  //   ② tournament 是 loop 模式，第 2 轮起 messages 里已有别人的评标结果，
  //      而 OTHERS 只过滤"自己的" → 评审者会看到上轮别人的名次表 → **跟票**。
  //   ③ 匿名化本来就解决了"看到自己那份会自我加分"的顾虑（认不出哪份是自己的），
  //      不需要靠"抽掉自己"来防锚定。
  //   ④ 候选集合与顺序对所有评审者**完全一致** → 名次表可直接聚合。
  CANDIDATES: 'candidates',
});

/**
 * 席位选择器（phase.seat）：
 *   'all'       全部参会者
 *   'challenge' 角色分配里属于质证类的
 *   'build'     建设类
 *   'represent' 代表类
 *   'converge'  收敛类
 *   'first'     第一席位
 *   'last'      最后一个席位
 *   ['red-team', ...] 显式角色 id 数组
 *   'picker'    由主持人/选择器决定（需要 strategy = llm_selector，走真实 API）
 */
const MODES = Object.freeze({
  /* ═══════════════════════════════════════════════════════════════
     每个模式必须回答四个问题（用户需求：先把场景定义清楚）：
       scene.when     什么时候该用它（一句话，人话）
       scene.example  一个具体例子（用户能对上号的）
       scene.notFor   什么时候别用它（避免误用）
       scene.output   它会产出什么（开完会你手上多出什么东西）
       modelFit       它对模型能力的要求 + 推荐编制
     ═══════════════════════════════════════════════════════════════ */

  /* ─────── 1. 广播：同一件事，听多个独立视角 ─────── */
  broadcast: {
    id: 'broadcast',
    label: '广播',
    desc: '全员同时收到同一问题，各自回答一轮。最快，靠角色分化产生差异。',
    scene: {
      when: '你只想听同一件事的多个不同角度，不需要 AI 之间对话。',
      example: '「这个方案有什么问题？」——想看 9 个 AI 各给一份独立意见。',
      notFor: '需要 AI 互相反驳、需要自动收敛出结论时（用「共同审阅」或「协助」）。',
      output: 'N 份并行的独立意见（不互相影响，适合当第一轮素材）。',
    },
    modelFit: { need: { reasoning: 3 }, recommendSet: 'diverge-9', channels: ['web', 'api'], tips: '全员都得上。适合作为任何会议的第一阶段。' },
    needs: [],
    phases: [
      { name: '回答', seat: 'all', speak: SPEAK.PARALLEL, slice: SLICE.TASK },
    ],
    stopWhen: 'single-pass',
  },

  /* ─────── 2. 共同审阅：一份材料，多个视角把关 ─────── */
  review: {
    id: 'review',
    label: '共同审阅',
    desc: '针对一份材料：各自先独立审阅（防锚定）→ 交叉质证 → 归并出结论。',
    scene: {
      when: '你手上有一份**具体材料**（文档 / 代码 / 方案 / 合同），要它被多角度把关。',
      example: '丢一份需求文档进去：事实核查员查数据漏洞、用户代言者挑看不懂的地方、书记员抓遗漏。',
      notFor: '开放性问题（没有具体材料可审）。',
      output: '审阅结论 + 分歧点清单 + 被忽略的遗漏项。',
    },
    modelFit: {
      need: { reasoning: 4, structure: 4 }, recommendSet: 'trio-review',
      channels: ['web', 'api'],
      tips: '★ 第一阶段的「独立审阅」必须并行——若让 AI 先看到别人的意见，后面会全部向第一个发言者收敛（锚定效应）。',
    },
    needs: ['material'],
    phases: [
      { name: '独立审阅', seat: 'all', speak: SPEAK.PARALLEL, slice: SLICE.MATERIAL },
      { name: '交叉质证', seat: 'challenge', speak: SPEAK.SEQUENTIAL, slice: SLICE.OTHERS },
      { name: '归并结论', seat: 'converge', speak: SPEAK.SEQUENTIAL, slice: SLICE.ALL },
    ],
    stopWhen: 'single-pass',
  },

  /* ─────── 3. 协助：你自己要做，AI 当顾问团 ─────── */
  assist: {
    id: 'assist',
    label: '协助',
    desc: '用户是执行者，AI 是顾问团：先各出方案 → 会诊挑错 → 收敛成能直接照做的结论。',
    scene: {
      when: '你自己是执行者，需要的是「**能直接照做**的方案」，不是讨论。',
      example: '「我要把通辽会议接入微软框架，具体怎么落地？」——要步骤，不要综述。',
      notFor: '纯粹想了解一个概念时（那是普通对话，不用开会）。',
      output: '可执行步骤 + 每步前置条件 + 失败了怎么回退。',
    },
    modelFit: {
      need: { reasoning: 4, structure: 5 }, recommendSet: 'tech-7',
      channels: ['web', 'api'],
      tips: '执行步骤类角色对「结构化输出」要求最高——不会出清单的模型当它，产出没法用。',
    },
    needs: [],
    phases: [
      { name: '各出方案', seat: 'build', speak: SPEAK.PARALLEL, slice: SLICE.TASK },
      { name: '会诊挑错', seat: 'challenge', speak: SPEAK.SEQUENTIAL, slice: SLICE.OTHERS },
      { name: '收敛执行', seat: 'converge', speak: SPEAK.SEQUENTIAL, slice: SLICE.ALL },
    ],
    stopWhen: 'single-pass',
  },

  /* ─────── 4. 反复修正：打磨已有产出物 ─────── */
  iterate: {
    id: 'iterate',
    label: '反复修正',
    desc: '对同一产出物循环「挑错 → 修订」，直到本轮批评相对上一轮无新增为止（有客观终止判据，不靠轮数硬切）。',
    scene: {
      when: '你**已经有了一版产出物**（文案 / 方案 / 代码），要反复挑错改到挑不出新问题。',
      example: '一份要给客户的方案：红队挑错 → 修订 → 再挑 → 再改，直到某轮挑不出新东西自动停。',
      notFor: '还没有第一版的时候（先跑「协助」拿到初稿）。',
      output: '收敛后的终版 + 完整的批评清单（知道改过哪些问题）。',
    },
    modelFit: {
      need: { reasoning: 5 }, recommendSet: 'risk-audit-5',
      channels: ['web', 'api'],
      tips: '★ 会自动判停：靠"本轮批评相对上轮无新增"，不是固定跑 5 轮。质证席位推理能力要够，否则挑两轮就挑不动了。',
    },
    needs: ['draft'],
    loop: true,
    maxIterations: 5,
    phases: [
      { name: '挑错', seat: 'challenge', speak: SPEAK.PARALLEL, slice: SLICE.DRAFT },
      { name: '修订', seat: 'build', speak: SPEAK.SEQUENTIAL, slice: SLICE.CRITIQUES },
    ],
    stopWhen: 'no-new-critique',
  },

  /* ─────── 5. 交叉辩论：有争议，正反对撞 ─────── */
  debate: {
    id: 'debate',
    label: '交叉辩论',
    desc: '全员先各自立论，再进入多轮对辩（每人只看别人的论点，不看自己的，避免自我强化）。',
    scene: {
      when: '有两个（或几个）方案**难分高下**，你要看它们正面对撞的结果。',
      example: '「用 MAF 还是自研？」「上云还是自建？」',
      notFor: '问题只有一个正确答案时（那是浪费，直接用「协助」）。',
      output: '各方的**最强论证** + 各自的致命弱点（不是折中意见）。',
    },
    modelFit: {
      need: { reasoning: 4, chinese: 4 }, recommendSet: 'diverge-9',
      channels: ['web', 'api'],
      tips: '★ 对辩阶段每人「只看别人的、不看自己的」——防止 AI 复述自己上一轮的话。立场对立的席位建议选能力互补的模型。',
    },
    needs: [],
    maxRounds: 3,
    phases: [
      { name: '立论', seat: 'all', speak: SPEAK.PARALLEL, slice: SLICE.TASK },
      { name: '对辩', seat: 'all', speak: SPEAK.SEQUENTIAL, slice: SLICE.OTHERS },
    ],
    stopWhen: 'single-pass',
  },

  /* ─────── 6. 专家会诊：层层加码 ─────── */
  panel: {
    id: 'panel',
    label: '专家会诊',
    desc: '每个席位依次发言一次，后者能看到前者所有发言（语境累积）。适合需要层层加码的议题。',
    scene: {
      when: '问题复杂，需要每个专家**看到前面所有人的发言**再往下深挖，像真正的专家会诊。',
      example: '疑难故障排查、复杂架构决策——第一个人开了头，后面的人接着往深里挖。',
      notFor: '人多的时候（串行会让总时长线性增长，9 人会很慢）。',
      output: '逐层加深的分析链 + 最后汇总结论。',
    },
    modelFit: {
      need: { reasoning: 4, longOutput: 4 }, recommendSet: 'tech-7',
      channels: ['web', 'api'],
      tips: '串行接龙，每位都看得见前面全部发言 → 越到后面上下文越长，挑「长文承载」强的模型坐后排。',
    },
    needs: [],
    phases: [
      { name: '会诊', seat: 'all', speak: SPEAK.SEQUENTIAL, slice: SLICE.OTHERS },
      { name: '归并结论', seat: 'converge', speak: SPEAK.SEQUENTIAL, slice: SLICE.ALL },
    ],
    stopWhen: 'single-pass',
  },

  /* ─────── 7. 主席点名：主持人动态追问分歧 ─────── */
  chairman: {
    id: 'chairman',
    label: '主席点名',
    desc: '主持人在每一轮根据分歧点动态点名追问。★ 主席必须走真实 API，绝不能用网页版（ADR-001 第 6 条）。',
    scene: {
      when: '你希望有个**主持人**像真人开会那样，抓住分歧点追问到底，而不是平均分配发言。',
      example: '评审会、复盘会：主持人看到 A 和 B 意见相反，就点他们俩各自说清理由。',
      notFor: '没有明确分歧点的开放性咨询。',
      output: '被追问到底的分歧结论 + 谁在哪个点上无法自圆其说。',
    },
    modelFit: {
      need: { reasoning: 5, stability: 5 }, recommendSet: 'product-9',
      channels: ['api'],
      requiresApi: true,
      tips: '★ 主席必须走 API 通道：它每轮都要即时判断，网页版的渲染延迟会把一轮拖到分钟级，9 人会上没法用。',
    },
    needs: ['chairman'],
    requiresChairman: true,
    /* ★ 第五轮修 bug：这里原本**缺 `loop` 字段**，导致「每一轮追问」这句宣传从未生效过。
     *   执行层是 `const maxIter = mode.loop ? (mode.maxIterations||5) : 1`
     *   → loop 缺失 → maxIter = 1 → 只跑一轮 → stopWhen:'no-new-question' 成了死代码
     *   （第 1 轮 shouldStop 恒返回 stop:false，随即被 iteration>=maxIter 打断，判据根本没被用上）。
     *   修法：先给它 loop:true，再设上限 —— 两件都要做，只加上限没有用（loop 为假时 maxIter 恒为 1）。 */
    loop: true,
    maxIterations: 4, // 每轮 = 1 次主持判断 + k 次被点名者发言（k 由主持人定，通常 2~4）
    phases: [
      { name: '点名发言', seat: 'picker', speak: SPEAK.SEQUENTIAL, slice: SLICE.OTHERS },
    ],
    stopWhen: 'no-new-question',
  },

  /* ─────── 8. 分头攻克：任务可拆时，速度 xN ─────── */
  divide: {
    id: 'divide',
    label: '分头攻克',
    desc: '把大任务拆成 N 个子任务，每个 AI 认领一块并行推进，最后汇总拼装。',
    scene: {
      when: '任务**能被拆开**，且拆开后各块互不依赖（这是前提）。',
      example: '「把这 9 个模块的接口文档各写一份」——每人一个模块，最后汇总。',
      notFor: '任务不可拆分时（拆了会各说各话、拼不起来）。',
      output: 'N 份子任务成果 + 一份拼装好的完整产出。',
    },
    modelFit: {
      need: { structure: 4 }, recommendSet: 'tech-7',
      channels: ['web', 'api'],
      tips: '★ 前提是任务真的可拆。拆不开硬拆 = 9 份互不相干的半成品，拼装时全废。',
    },
    needs: [],
    phases: [
      { name: '拆分任务', seat: 'converge', speak: SPEAK.SEQUENTIAL, slice: SLICE.TASK },
      { name: '分头攻克', seat: 'all', speak: SPEAK.PARALLEL, slice: SLICE.TASK },
      { name: '汇总拼装', seat: 'converge', speak: SPEAK.SEQUENTIAL, slice: SLICE.ALL },
    ],
    stopWhen: 'single-pass',
  },

  /* ─────── 9. 招标评审：出 N 份候选 → 独立评标 → 定标 → 改进 → 复评（择优迭代闭环）─────── */
  tournament: {
    id: 'tournament',
    label: '招标评审',
    desc: '出 N 份候选方案 → 评审者**先独立打分（并行、互不可见，防锚定）**→ 定标 → 改进胜出者 → 复评。用于「写不出想要的效果，出去问一圈再回来挑」的工作流。',
    scene: {
      when: '你**还没有满意的答案**，想要 N 个候选 + 一个客观的"谁最好"判定，而不是 9 份互相抄的意见。',
      example: '「这个功能写不出想要的效果」——先让 9 个 AI 各给一份解法，再由质证类独立排序，选出最能打的那份去改进。',
      notFor: '已有一份满意初稿时（那是「反复修正」）；问题有唯一正确答案时（那是「协助」）。',
      output: '胜出方案 + 备选 + 各评审者的独立排序（可复现"为什么选它"）。',
    },
    modelFit: {
      need: { reasoning: 4, structure: 4 }, recommendSet: 'tech-7',
      channels: ['web', 'api'],
      tips: '★ 评标阶段必须**并行**（评审者看到彼此评分就会跟票=锚定），且候选必须**匿名 + 定序**'
        + '（认不出自己那份 → 无自我加分；人人看到同样 N 份 → Borda 均值可比）。'
        + '用名次（1..N）不用分数，跨模型可比。定标结果由 bordaMeans 算出，**不是**让 AI 拍板。',
    },
    needs: [],
    loop: true,
    maxIterations: 3, // 每轮 = 5 个阶段（比 iterate 的 2 阶段重），3 轮封顶
    phases: [
      /* ★ 每个阶段多带一个 `produces` 字段：标明"这个阶段产出的是什么"。
       *   它与 `slice`（看什么）正交：
       *     slice     = 输入契约（本阶段能看到哪些前文）
       *     produces  = 输出契约（本阶段产出的消息是什么类型）
       *   编排层必须把 produces 写进 message.kind —— 否则 CANDIDATES 切片
       *   无法区分"候选方案"和"评标意见"，会把评标结果也当成候选发出去（含评分 → 跟票）。
       *   这正是第五轮发现的"贯通性缺口"：切片的输入侧做了，输出侧没做。 */
      // 出标：全员各给一份候选方案。看 TASK（只看原始问题，不看别人的——第一份方案也防锚定）。
      { name: '出标', seat: 'all', speak: SPEAK.PARALLEL, slice: SLICE.TASK, produces: 'candidate' },
      // ★ 评标：质证类**并行**给每个方案排名次。
      //   切片用 CANDIDATES（全部候选，**匿名 + 定序**）—— 不是 ALL，也不是 OTHERS。
      //   ① 不用 ALL：会看到自己的那份 → 自我加分（这一点第五轮某家说对了）。
      //   ② 也不用 OTHERS（抽掉自己那份）：那会让每个评审者只排 N-1 份，
      //      且各人排除的**不是同一份** → 各方案被排次数不等 → Borda 均值分母不同 → 不可比；
      //      并且 tournament 是 loop 模式，第 2 轮起 OTHERS 会放行"上轮别人的名次表" → 跟票。
      //   ③ 正解是**匿名**：认不出哪份是自己的，就不存在自我加分，
      //      同时人人看到同样的 N 份、同样的顺序 → 名次表可直接聚合。
      { name: '评标', seat: 'challenge', speak: SPEAK.PARALLEL, slice: SLICE.CANDIDATES, produces: 'ballot' },
      // 定标：收敛类看全部（此时锚定已发生——但定标是"基于 Borda 均值表"，不是"基于谁说得最有道理"，锚定影响可控）。
      { name: '定标', seat: 'converge', speak: SPEAK.SEQUENTIAL, slice: SLICE.ALL, produces: 'verdict' },
      // 改进：建设类对胜出者定向改。看 CRITIQUES（评标阶段的批评清单）。
      { name: '改进', seat: 'build', speak: SPEAK.SEQUENTIAL, slice: SLICE.CRITIQUES, produces: 'revision' },
      // 复评：质证类挑改进后的错。看 DRAFT（改进后的胜出者）。
      { name: '复评', seat: 'challenge', speak: SPEAK.PARALLEL, slice: SLICE.DRAFT, produces: 'review' },
    ],
    // ★ 终止判据：连续两轮定标同一方案 → 收敛（不是"无新批评"——择优迭代每轮方案全换，批评集合天然全变，用 no-new-critique 永不收敛）。
    stopWhen: 'same-winner',
  },

  /* ─────── 10. 工程交付：提想法 → 商量功能/架构 → 冻结契约 → 分头写 → 集成验证 → 修复（生成软件，不是聊文本）─────── */
  build: {
    id: 'build',
    label: '工程交付',
    desc: '「我提一个想法 → 他们商量出功能与架构 → 一个 AI 写一部分 → 最后汇总成可运行软件」的落地模式。★ 产出是文件（产物），不是聊天文本。',
    scene: {
      when: '你想把**一个想法变成真的能跑的软件**，需要"商量架构 + 分头实现 + 集成验证"三件事。',
      example: '「做一个待办清单网页」——先定功能与模块，冻结接口契约，分头写各模块，最后有人拼装 + 编译运行验证。',
      notFor: '只是要一份讨论文档/方案（那是「协助」或「招标评审」，产物是文本不是软件）。',
      output: '可运行的代码文件（产物 {path, content}）+ 编译/运行结果 + 修复记录。',
    },
    modelFit: {
      need: { structure: 5, reasoning: 4 }, recommendSet: 'tech-7',
      channels: ['api'],  // ★ 工程交付要"能落盘、能编译"，网页版 webview 做不了，必须走 API + 主进程
      requiresApi: true,
      tips: '★ 阶段 3「冻结契约」由架构师写、收敛类只做"确认"（收敛类的互斥约束是"禁止引入新观点"，让它写契约会自相矛盾——这是草案 B 的一个 bug，本模式修正了它）。★ 修复回路归**原作者**，集成者只报"哪里断了"。',
    },
    needs: [],
    loop: true,
    maxIterations: 4, // 修复回路：集成失败 → 原作者修 → 再集成，4 轮封顶
    phases: [
      // 1 需求澄清：代表类（用户代言/产品经理）顺序说清"做什么、不做什么"
      { name: '需求澄清', seat: 'represent', speak: SPEAK.SEQUENTIAL, slice: SLICE.OTHERS, produces: 'requirement' },
      // 2 架构设计：建设类（架构师）给模块划分 + 依赖关系
      { name: '架构设计', seat: 'architect', speak: SPEAK.SEQUENTIAL, slice: SLICE.OTHERS, produces: 'architecture' },
      // 3 冻结契约：★ 由架构师写契约（签名/数据结构/错误约定），收敛类只做"冻结确认"
      //    （收敛类的互斥约束是"禁止引入新观点"，让它写契约会自相矛盾——这是草案 B 的一个 bug，本模式修正了它）
      { name: '冻结契约', seat: 'architect', speak: SPEAK.SEQUENTIAL, slice: SLICE.ALL, produces: 'contract' },
      // 4 分头实现：★ 全员并行，切片 = CONTRACT（契约全文 + 自己模块 + 同伴签名，不看别人实现）
      //    produces='artifact'：★ 这一阶段的产出是**文件**（{path, content}），不是聊天文本 ——
      //    它是"文本 → 可运行软件"的临界点（当前编排层还只当文本收，见报告 P1）
      { name: '分头实现', seat: 'all', speak: SPEAK.PARALLEL, slice: SLICE.CONTRACT, produces: 'artifact' },
      // 5 集成验证：★ 新角色 integrator（不是 chair-assistant——主持助理的互斥约束"禁止引入新观点"不碰代码）
      //    集成者拼装 + 编译/运行，报"哪里断了"
      { name: '集成验证', seat: 'integrator', speak: SPEAK.SEQUENTIAL, slice: SLICE.ALL, produces: 'integration' },
      // 6 修复回路：★ 原作者修（集成者不修——它不知道原作者的意图，改了就是猜）
      //    看 CRITIQUES（集成者报的"哪里断了"清单）
      { name: '修复', seat: 'all', speak: SPEAK.PARALLEL, slice: SLICE.CRITIQUES, produces: 'patch' },
    ],
    // 终止：集成通过（buildPass=true）或达修复轮数上限
    stopWhen: 'build-pass',
  },
});

/** 全部模式 id */
const MODE_IDS = Object.freeze(Object.keys(MODES));

/** 取模式定义 */
function getMode(modeId) {
  return MODES[modeId] || null;
}

/** 列出全部模式（供 UI 渲染模式下拉 + 场景说明卡） */
function listModes({ costSample = ['a', 'b', 'c', 'd', 'e'] } = {}) {
  return MODE_IDS.map((id) => {
    const m = MODES[id];
    // 成本档位：按典型规模（5 人）静态估算，让 UI 能在下拉旁直接标"轻/中/重"
    const cost = estimateCost(id, { participants: costSample });
    return {
      id: m.id, label: m.label, desc: m.desc,
      scene: m.scene ? { ...m.scene } : null,
      modelFit: m.modelFit ? { ...m.modelFit } : null,
      phases: m.phases.length,
      /* ★ 必须带上 seat：它才是"这个阶段谁发言"的选择器来源
       *   （如 chairman 模式的 seat:'picker'，表示由主持人动态点名）。
       *   之前只导出了 speak（顺序/并行），UI 拿到 phaseList 后无法还原
       *   "主席点名"这类语义，会误显示成"（等人）"空阶段。 */
      phaseList: m.phases.map((p) => ({
        name: p.name, seat: p.seat, speak: p.speak, slice: p.slice, produces: p.produces || null,
      })),
      needsMaterial: m.needs.includes('material'),
      needsDraft: m.needs.includes('draft'),
      requiresChairman: !!m.requiresChairman,
      loop: !!m.loop,
      maxIterations: m.maxIterations || 1,
      stopWhen: m.stopWhen,
      // ★ 成本维度（五家里 4 家列为最高优先级：直接回应"别瞎聊浪费 token"）
      costTier: cost.tier,        // 'light' | 'medium' | 'heavy'（5 人规模）
      maxCalls: cost.maxCalls,    // 最坏调用次数
      maxContext: cost.maxContext, // 最坏上下文注入条数（O(N²) 的体现）
      costNote: cost.advices[0],
    };
  });
}

/**
 * 把一个阶段的"席位选择器"解析成具体的 providerId 列表。
 *
 * @param {string|string[]} seat
 * @param {object} ctx
 *   - participants  string[]  全部参会者
 *   - assignment    assignRoles() 的返回值（可为空 → 退化为全部参会者）
 *   - picked        string     主持人点名结果（seat === 'picker' 时使用）
 * @returns {{ speakers:string[], degraded:boolean, reason:string }}
 */
function resolveSeat(seat, { participants = [], assignment = [], picked = null } = {}) {
  const byGroup = (group) => assignment.filter((a) => a.group === group).map((a) => a.providerId);

  // 主持人点名
  if (seat === 'picker') {
    if (!picked) return { speakers: [], degraded: true, reason: '主持人尚未点名' };
    return { speakers: [picked], degraded: false, reason: '主持人点名' };
  }

  // 显式角色 id 数组
  if (Array.isArray(seat)) {
    const ids = assignment.filter((a) => seat.includes(a.roleId)).map((a) => a.providerId);
    return ids.length
      ? { speakers: ids, degraded: false, reason: `角色席位 ${seat.join('/')}` }
      : { speakers: [...participants], degraded: true, reason: `角色席位 ${seat.join('/')} 无人在座，退化为全体` };
  }

  const groupMap = { challenge: 'challenge', build: 'build', represent: 'represent', converge: 'converge', integrate: 'integrate' };

  // ★ 显式角色 id（单个字符串，如 'architect' / 'integrator'）：
  //   既不是 groupMap 的键、也不是 picker/first/last/all 时，按 roles.js 的角色 id 匹配。
  //   这是 build 模式"冻结契约由架构师写"的前提 —— seat:'architect' 必须只挑出架构师本人。
  const KNOWN_SEAT_TOKENS = new Set([...Object.keys(groupMap), 'picker', 'first', 'last', 'all', ...Array.isArray(seat) ? [] : []]);
  if (typeof seat === 'string' && !KNOWN_SEAT_TOKENS.has(seat)) {
    const ids = assignment.filter((a) => a.roleId === seat).map((a) => a.providerId);
    return ids.length
      ? { speakers: ids, degraded: false, reason: `角色席位 ${seat}` }
      : { speakers: [...participants], degraded: true, reason: `角色「${seat}」无人在座，退化为全体` };
  }
  if (groupMap[seat]) {
    const ids = byGroup(groupMap[seat]);
    return ids.length
      ? { speakers: ids, degraded: false, reason: `${seat} 类席位` }
      : { speakers: [...participants], degraded: true, reason: `无 ${seat} 类角色，退化为全体` };
  }

  if (seat === 'first') return { speakers: participants.slice(0, 1), degraded: false, reason: '第一席位' };
  if (seat === 'last') return { speakers: participants.slice(-1), degraded: false, reason: '末位席位' };

  // 'all' 及未知值
  return { speakers: [...participants], degraded: seat !== 'all', reason: seat === 'all' ? '全体' : `未知席位「${seat}」，退化为全体` };
}

/* ══════════════════════════════════════════════════════════════════
   CANDIDATES 切片：候选匿名化（评标防锚定 / 防跟票的基石）
   ══════════════════════════════════════════════════════════════════ */

/** FNV-1a 32 位哈希（用于"按内容定序"，不用于安全场景） */
function fnv1a(str = '') {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 匿名标签：1→方案A … 26→方案Z，27 起 →方案AA（够任何会议用） */
function anonLabel(i) {
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let n = i; let out = '';
  do { out = L[n % 26] + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return `方案${out}`;
}

/**
 * 把一批候选消息匿名化，并给出**确定性**的展示顺序。
 *
 * ★ 为什么顺序必须确定性（且与 senderId 无关）：
 *   所有评审者必须看到**同一套标签 + 同一个顺序**，否则各自输出的
 *   `方案X` 指的不是同一份东西，Borda 聚合会得到一堆无法对照的名次表。
 *   同时顺序又不能按 senderId 排（那样等于没匿名 —— 第一个出标的人猜得到自己是 A）。
 *   解法：按**内容哈希**排序。内容一旦写定就不再变，于是：
 *     · 对所有评审者是同一顺序 ✔
 *     · 与"谁写的"无关 ✔（换个人写同样的内容，它仍是同一个标签）
 *     · 跨轮稳定 ✔（未被修改的候选，轮次间标签不变，便于"连续两轮同一定标"判据）
 *
 * @param {Array<{senderId:string, content:string}>} candidates
 * @returns {{ items:Array<{label:string,content:string,author:string}>,
 *             map:Object<string,string>, order:string[] }}
 *   - map  = { 方案A: 'deepseek-web' } —— **只作审计用，绝不进 prompt**
 */
function anonymizeCandidates(candidates = []) {
  const decorated = candidates
    .filter((c) => c && String(c.content || '').trim())
    .map((c) => ({ content: String(c.content), author: c.senderId || '?', key: fnv1a(String(c.content)) }))
    .sort((a, b) => a.key - b.key || a.author.localeCompare(b.author)); // key 冲突时用 author 兜底，保证全序
  const items = decorated.map((c, i) => ({ label: anonLabel(i), content: c.content, author: c.author }));
  const map = {};
  for (const it of items) map[it.label] = it.author;
  return { items, map, order: items.map((i) => i.label) };
}

/**
 * 计算某发言者本轮能看到哪些前文（**上下文切片**）。
 *
 * 这是"制造真实视角差异"的第二把刀（第一把是角色）：
 *   - OTHERS   ：看不到自己说过的话 → 逼它回应别人，而不是复述自己
 *   - CRITIQUES：只看批评清单 → 逼它改，而不是重新发挥
 *   - ALL      ：看全部 → 用于收敛归并
 *   - CANDIDATES：只看候选本体（匿名 + 定序）→ 用于评标，防自我加分 + 防跟票
 *
 * @param {string} kind  SLICE.*
 * @param {object} ctx
 *   - task、material、draft、critiques
 *   - messages  [{ senderId, content, kind? }]  kind==='candidate' 的才是候选
 *   - selfId    当前发言者
 *   - candidates 可直接传入已筛好的候选（优先于 messages）
 * @returns {{ text:string, included:string[], map?:Object }}
 */
function selectSlice(kind, {
  task = '', material = '', draft = '', critiques = [], messages = [],
  selfId = null, contract = null, candidates = null,
} = {}) {
  const joinMsgs = (list) => list.map((m) => `【${m.senderId}】${m.content || ''}`).join('\n');

  switch (kind) {
    case SLICE.NONE:
      return { text: '', included: [] };

    case SLICE.TASK:
      return { text: task, included: task ? ['task'] : [] };

    case SLICE.MATERIAL:
      return { text: material, included: material ? ['material'] : [] };

    case SLICE.DRAFT:
      return { text: draft, included: draft ? ['draft'] : [] };

    case SLICE.CONTRACT: {
      // ★ Q6 落地：执行者看到 = 冻结契约全文 + 自己负责的模块说明 + 每个同伴模块的一行签名（不展开）。
      // 关键：不给"别人的实现细节"，只给"别人的接口"——保证并行不互相等待。
      // contract 结构（由"冻结契约"阶段产出）：
      //   { text: 契约全文, modules: [{ owner: providerId, module: '文件名', signature: '一行签名' }] }
      const c = contract || {};
      const parts = [c.text || ''];
      if (Array.isArray(c.modules)) {
        const mine = c.modules.filter((m) => m.owner === selfId);
        const others = c.modules.filter((m) => m.owner !== selfId);
        if (mine.length) {
          parts.push('【你负责的模块】\n' + mine.map((m) => `${m.module}：${m.signature || '(未签名)'}`).join('\n'));
        }
        if (others.length) {
          parts.push('【同伴模块（只看接口，不看实现）】\n' + others.map((m) => `${m.owner} 的 ${m.module}：${m.signature || '(未签名)'}`).join('\n'));
        }
      }
      const text = parts.filter(Boolean).join('\n\n');
      return { text, included: text ? ['contract'] : [] };
    }

    case SLICE.CRITIQUES:
      return { text: critiques.join('\n'), included: critiques.length ? ['critiques'] : [] };

    case SLICE.CANDIDATES: {
      // ★ 评标专用：只给"候选本体"，匿名 + 定序，**不含任何评分/名次/结论**。
      //   - 不含评分 → loop 第 2 轮起也看不到上轮别人的名次表 → 防跟票
      //   - 匿名     → 认不出哪份是自己的 → 无需靠"抽掉自己"防自我加分
      //   - 集合一致 → 每个评审者都排同样 N 份 → Borda 均值可比
      const pool = Array.isArray(candidates) && candidates.length
        ? candidates
        : messages.filter((m) => m && (m.kind === 'candidate' || m.role === 'candidate'));
      if (!pool.length) {
        return { text: '', included: [], map: {}, warning: '没有标记为 candidate 的候选消息' };
      }
      const { items, map } = anonymizeCandidates(pool);
      const text = items.map((it) => `【${it.label}】\n${it.content}`).join('\n\n');
      return { text, included: items.map((i) => i.label), map };
    }

    case SLICE.OTHERS: {
      const others = messages.filter((m) => m.senderId !== selfId);
      return { text: joinMsgs(others), included: others.length ? ['others'] : [] };
    }

    case SLICE.ALL:
    default:
      return { text: joinMsgs(messages), included: messages.length ? ['all'] : [] };
  }
}

/**
 * 展开一个模式的全部阶段（把它接到编排器之前，先看清楚"这场会要发生什么"）。
 *
 * ★ 纯静态展开，不执行任何动作——因此可以完全离线单测，
 *   也可以直接渲染成 UI 上的"会议流程预览"。
 *
 * @param {string} modeId
 * @param {object} ctx  { participants, assignment, picked, panelGroupSize }
 *   - panelGroupSize   Q7 降本：panel 模式"接龙"阶段的分组大小（默认 0=不分组）。
 *                      9 人分 3 组（panelGroupSize=3）：组内接龙（O(3) 上下文）
 *                      → 组长接龙（O(3) 上下文）。总 << O(9×8)。
 *                      副作用：组长要"代表组内发言"，丢一层信息。
 * @returns {Array<{ index:number, name:string, speakers:string[], speak:string, slice:string, degraded:boolean, reason:string }>}
 */
function planPhases(modeId, { participants = [], assignment = [], picked = null, panelGroupSize = 0, groupLeaderOf = null } = {}) {
  const mode = MODES[modeId];
  if (!mode) throw new Error(`planPhases: unknown mode "${modeId}"`);

  const result = [];
  for (const p of mode.phases) {
    // ★ Q7：panel 模式的"会诊"阶段（OTHERS 切片 + 顺序接龙）支持分组降本
    //   分组后：每个组内会诊（OTHERS 自动按 selfId 过滤，组边界由编排层限定 messages），
    //   再加一个"组长会诊"阶段（各组组长代表本组发言，看其它组组长的摘要）。
    //   该阶段被展开为多阶段，后续阶段（归并结论）仍正常执行。
    const isPanelChain = mode.id === 'panel' && p.slice === SLICE.OTHERS && p.speak === SPEAK.SEQUENTIAL
      && panelGroupSize >= 2 && participants.length > panelGroupSize;
    if (isPanelChain) {
      const groups = [];
      for (let i = 0; i < participants.length; i += panelGroupSize) {
        groups.push(participants.slice(i, i + panelGroupSize));
      }
      // 每组一个"组内会诊"阶段
      groups.forEach((grp, gi) => {
        result.push({
          index: result.length,
          name: `组${gi + 1}会诊（${grp.length}人）`,
          seat: `panel-group-${gi}`,
          speakers: grp,
          speak: SPEAK.SEQUENTIAL,
          slice: SLICE.OTHERS, // 组内只看组内别人的发言（OTHERS 按 selfId 过滤，组边界由编排层限定 messages）
          groupSize: grp.length, // ★ 组边界契约：编排层喂 messages 时只取本组
          degraded: false,
          reason: `Q7 分组降本：组内会诊，每人只看组内前 ${Math.max(grp.length - 1, 0)} 份而非全部 ${participants.length - 1} 份`,
        });
      });
      // 组长会诊：每组第 1 人当组长（或 groupLeaderOf 指定的）
      const leaders = groups.map((grp) => (groupLeaderOf ? groupLeaderOf(grp, participants) : grp[0]));
      result.push({
        index: result.length,
        name: '组长会诊',
        seat: 'panel-group-leaders',
        speakers: leaders,
        speak: SPEAK.SEQUENTIAL,
        slice: SLICE.OTHERS, // 组长看其它组组长的发言
        groupLeaders: true,
        degraded: false,
        reason: 'Q7 分组降本：各组组长代表本组会诊，把 O(N²) 压到 O(G·g + G)',
      });
      continue; // 跳过原 OTHERS 会诊阶段（被分组版取代），继续处理后续阶段
    }

    const r = resolveSeat(p.seat, { participants, assignment, picked });
    result.push({
      index: result.length,
      name: p.name,
      speakers: r.speakers,
      speak: p.speak,
      slice: p.slice,
      /* ★ 输出契约：本阶段产出的消息类型（'candidate'/'ballot'/'verdict'/…）。
       *   编排层必须把它透传到 message.kind，否则 CANDIDATES 切片无法区分
       *   "候选方案"与"评标意见"（后者含评分 → 若被当成候选发出去就会跟票）。 */
      produces: p.produces || null,
      degraded: r.degraded,
      reason: r.reason,
    });
  }
  return result;
}

/* ══════════════════════════════════════════════════════════════════
   成本估算：跑会之前就知道"这场会要烧多少"
   ══════════════════════════════════════════════════════════════════ */

/**
 * 估算一场会议的成本（**纯静态推算，不发任何请求**）。
 *
 * ★ 为什么必须有这个（第五轮五家里 4 家把它列为最高优先级）：
 *   用户的原始抱怨是「在那里瞎聊浪费 TOKEN 就没意思了」，
 *   但模式定义里**一个成本字段都没有** —— 点"开始会议"之前完全看不到要花多少。
 *   等开完才发现烧了 60 次调用，那时已经晚了。
 *
 * 两个互补指标（都要看，缺一个就会误判）：
 *   - calls              ：调用次数（花在"次数"上的钱）
 *   - contextInjections  ：上下文注入量（花在"字"上的钱）—— **这才是 O(N²) 的体现**
 *     顺序接龙时第 k 个人要读前 k-1 份发言，于是注入量 ∝ n(n-1)/2，人数翻倍、代价四倍。
 *     一个 9 人的 panel 调用次数只有 9 次（看着很便宜），但注入量是 36 份 —— 它才是贵的那个。
 *
 * @param {string} modeId
 * @param {object} ctx { participants, assignment, panelGroupSize }
 * @returns {{
 *   modeId:string, participants:number, rounds:number,
 *   callsPerRound:number, maxCalls:number, contextPerRound:number, maxContext:number,
 *   tier:'light'|'medium'|'heavy', worstCase:boolean,
 *   breakdown:Array<{phase:string, speakers:number, slice:string, inject:number, note:string}>,
 *   advices:string[],
 * }}
 */
function estimateCost(modeId, {
  participants = [], assignment = [], panelGroupSize = 0,
  pickerEstimate = 3,   // ★ picker 席位（主席点名）是运行期动态决定的，静态算不出来 → 按 N 人预估
} = {}) {
  const mode = MODES[modeId];
  if (!mode) throw new Error(`estimateCost: unknown mode "${modeId}"`);

  const plan = planPhases(modeId, { participants, assignment, panelGroupSize });
  const rounds = mode.loop ? (mode.maxIterations || 5) : 1;
  const hasPicker = mode.phases.some((p) => p.seat === 'picker');

  const breakdown = [];
  let accum = 0;          // 到此阶段为止"已产生的发言条数"（跨组共享的部分）
  let innerAccum = 0;     // ★ 分组时"本组内"已产生的发言条数（组间隔离，不跨组累积）
  let firstGroupSize = 0;
  let prevGroupMembers = new Set(); // 上一组的人，用来判断"这是新的一组还是同一组"
  let callsPerRound = 0;
  let contextPerRound = 0;

  for (const p of plan) {
    /* ★ 分组阶段必须按"组内独立累积"算，否则会把降本算成涨价：
     *   planPhases 把分组展开成若干个**串行**阶段（组1/组2/组3），
     *   但编排层是按 groupSize 限定 messages 的（组间互不可见）。
     *   若照搬全局 accum，组2 会算上组1 的产出 → 注入量反而比不分组更高。
     *   判"新组"用**发言者交集**（组间无交集 = 新组），不靠阶段名文案。 */
    const isGroupInner = !!p.groupSize && !p.groupLeaders;
    const isGroupLeader = !!p.groupLeaders;
    if (isGroupInner && !p.speakers.some((s) => prevGroupMembers.has(s))) {
      innerAccum = 0;                    // 换组了 → 组内累积清零（组间不可见）
      prevGroupMembers = new Set(p.speakers);
    }
    const baseAccum = isGroupInner ? innerAccum : accum;

    // picker 阶段静态拿不到发言者（要点名后才知道）→ 用预估人数，别显示成 0（会被误读为免费）
    const isPickerStage = p.speakers.length === 0 && hasPicker && !isGroupInner;
    const n = p.speakers.length || (isPickerStage ? pickerEstimate : 0);

    let inject = 0;
    let note = '看固定材料（不带会议上下文）';

    if (p.slice === SLICE.NONE) {
      note = '不带任何上下文（纯角色开场）';
    } else if (p.slice === SLICE.TASK || p.slice === SLICE.MATERIAL) {
      note = '只看原始任务/材料（互相看不见）';
    } else if (p.slice === SLICE.DRAFT || p.slice === SLICE.CRITIQUES || p.slice === SLICE.CONTRACT) {
      inject = n; // 每人看一份草稿/清单/契约
      note = '每人看一份固定产物（草稿/批评清单/契约）';
    } else if (p.slice === SLICE.CANDIDATES) {
      inject = n; // 每人看同一份"匿名候选包"（与人数无关）
      note = '每人看同一份匿名候选包（防锚定，包大小固定）';
    } else if (p.slice === SLICE.OTHERS || p.slice === SLICE.ALL) {
      if (p.speak === SPEAK.SEQUENTIAL) {
        inject = n * baseAccum + (n * (n - 1)) / 2; // 第 k 人看 baseAccum + k-1 条
        note = `顺序接龙：第 k 人读前 k-1 份 → O(n²)`;
      } else {
        inject = n * baseAccum;                      // 并行：都看已积累的全部
        note = '并行：每人读已积累的全部发言';
      }
    }
    if (isGroupInner) note += '（组内，组间不可见）';
    if (isGroupLeader) {
      // 组长：读"本组组内发言"（firstGroupSize 份）+ 已发言组长的摘要
      const G = n;
      inject = G * firstGroupSize + (G * (G - 1)) / 2;
      note = `组长会诊：每人读本组 ${firstGroupSize} 份 + 前面组长的摘要`;
    }
    if (isPickerStage) note += `（发言者由主持人动态点名，此处按 ${pickerEstimate} 人预估）`;

    callsPerRound += n;
    contextPerRound += inject;
    breakdown.push({ phase: p.name, speakers: n, slice: p.slice, inject, note, estimated: isPickerStage || undefined });

    if (isGroupInner) { innerAccum += n; if (!firstGroupSize) firstGroupSize = p.groupSize; }
    else { accum += n; innerAccum = 0; }
  }

  const maxCalls = callsPerRound * rounds;
  const maxContext = contextPerRound * rounds;

  /* 档位判据（给用户"一眼看懂"的档，不是精确金额） */
  let tier = 'light';
  if (maxCalls > 40 || maxContext > 150) tier = 'heavy';
  else if (maxCalls > 12 || maxContext > 30) tier = 'medium';

  /* 优化建议：只在真的贵时给，避免像噪声 */
  const advices = [];
  const worst = breakdown.reduce((a, b) => (b.inject > (a ? a.inject : -1) ? b : a), null);
  if (worst && worst.inject >= 12) {
    // 注意字段名是 phase（不是 name）—— 写错会渲染成「阶段「undefined」」
    advices.push(`阶段「${worst.phase}」注入 ${worst.inject} 份，是主要开销（${worst.note}）`);
  }
  if (maxContext > 60 && modeId === 'panel' && !panelGroupSize && participants.length > panelGroupSize + 1) {
    /* ★ 分组到底能省多少？**算出来，别拍脑袋**。
     *   常见误算是只盯着"会诊"那一段（9 人 36 份 → 12 份，"省 2/3"），
     *   但 9 人 panel 的真正大头是后面的「归并结论」（117 份，占总量 76%）——
     *   只分会诊、不动归并，总账省不了多少。所以要按总量对比。 */
    const grouped = estimateCost(modeId, { participants, assignment, panelGroupSize: 3 });
    const saved = Math.round((1 - grouped.contextPerRound / contextPerRound) * 100);
    advices.push(`可开 panelGroupSize=3 分组：注入量 ${contextPerRound} → ${grouped.contextPerRound} 份（省 ${saved}%）`);
  }
  if (panelGroupSize && modeId === 'panel') {
    /* ★ 这条不是废话，是分组的**成立前提**：
     *   分组的降本来自"组内明细不再向上传播，只留组长摘要"。
     *   若编排层在「归并结论」阶段照旧注入全部 messages（含 9 条组内明细），
     *   分组就白做了 —— 总注入量甚至会比不分组更高（因为多了组长那一层）。
     *   所以编排层必须按 `groupLeaders` 标记限定该阶段可见的消息。 */
    advices.push('★ 分组降本的前提：归并阶段只读**组长摘要**（不读组内明细）'
      + '—— 需编排层按 groupLeaders 标记限定可见消息，否则分组白做');
  }
  if (rounds > 1) {
    advices.push(`最多循环 ${rounds} 轮 → 最坏 ${maxCalls} 次调用；收敛判据生效会提前停（判据失效时才跑满）`);
  }
  if (participants.length > 5 && (modeId === 'panel' || modeId === 'debate')) {
    advices.push(`参会 ${participants.length} 人：该模式成本随人数平方增长，**减人比换模型更省钱**`);
  }
  if (!advices.length) advices.push('成本很低，放心开');

  return {
    modeId,
    participants: participants.length,
    rounds,
    callsPerRound,
    maxCalls,
    contextPerRound,
    maxContext,
    tier,
    worstCase: rounds > 1 && !!mode.loop,
    breakdown,
    advices,
  };
}

/**
 * 一次算完全部模式的成本档位（供 UI 列表 / 文档生成）。
 * 默认按 5 人参会估算（测试台的典型规模）。
 */
function costOverview({ participants = ['a', 'b', 'c', 'd', 'e'], assignment = [], panelGroupSize = 0 } = {}) {
  const N = participants.length;
  return MODE_IDS.map((id) => {
    const c = estimateCost(id, { participants, assignment, panelGroupSize });
    return { id, label: MODES[id].label, tier: c.tier, maxCalls: c.maxCalls, maxContext: c.maxContext, rounds: c.rounds, N };
  });
}

/**
 * 从集成者的回复里判断「集成是否通过」—— **文本层临时判据，明确区分可信度**。
 *
 * ★ 为什么不能简单地"文本里出现'通过'就算通过"（五家共识里的一条硬货）：
 *   「无新批评 ≠ 软件正确」。模型很乐意说"已经全部通过、可以交付了"，
 *   但它没编译过、没跑过测试 —— 那句话是**生成**出来的，不是**验证**出来的。
 *   真正可信的 build-pass 只能来自真实执行结果（编译退出码 / 测试报告）。
 *
 * 所以本函数的不对称设计是有意的：
 *   - 文本说"未通过/失败/报错" → 判 `false`（**可信**：模型承认失败，通常不会撒谎说自己失败）
 *   - 文本说"通过/成功"        → 判 `null`（**不采信**：这只是模型的自述，需要真实结果背书）
 *   - 判不出来                  → 判 `null`（不猜）
 *   `pass === null` 时调用方应继续用真实执行结果，或按"未通过"保守处理。
 *
 * @param {string} text 集成者（integrator）的回复
 * @returns {{ pass:boolean|null, confidence:string, evidence:string|null }}
 */
function judgeBuildPass(text = '') {
  const t = String(text || '');
  if (!t.trim()) return { pass: null, confidence: 'empty', evidence: null };

  // 否定词优先判定：中文的"未通过"里也含"通过"，必须先看否定
  const negRe = /(未通过|不通过|没有通过|失败|报错|无法编译|编译错误|编译不过|测试失败|构建失败|跑不起来|缺少依赖|类型错误)/;
  const negEn = /(\bfailed\b|\berror\b|\bnot\s+pass|\bcompile\s+error|\bunresolved\b|\bmissing\b.*\b(module|dependency)\b)/i;
  const mNeg = t.match(negRe) || t.match(negEn);
  if (mNeg) {
    return { pass: false, confidence: 'text-heuristic', evidence: mNeg[0] };
  }

  const posRe = /(通过|成功|可交付|编译通过|测试全绿|全部通过|可以交付)/;
  const posEn = /(\bpassed\b|\bsuccess\b|\bbuild\s+succeeded\b|all\s+tests\s+pass)/i;
  const mPos = t.match(posRe) || t.match(posEn);
  if (mPos) {
    return {
      pass: null,
      confidence: 'text-heuristic-untrusted',
      evidence: mPos[0],
      reason: '模型自述"通过"不可采信（它没真编译过）→ 必须用真实编译/测试结果才能判 build-pass',
    };
  }

  return { pass: null, confidence: 'undetermined', evidence: null };
}

/**
 * 组装「定标」阶段该喂给模型的内容：**候选 + Borda 均值表**。
 *
 * ★ 为什么不能只丢一句"你觉得哪个最好"（混元明确推翻的做法）：
 *   那等于让某个模型用一句话拍板 —— 脆弱瓶颈、不可复现、且它可能根本没读懂方案。
 *   正确做法：代码先按名次表算出 Borda 均值，把**计算结果**交给定标席，
 *   定标席的职责是"确认并说明理由"，不是"重新投票"。
 *
 * @param {object} ctx
 *   - candidates  匿名候选包文本（或不传，则只用 Borda 表）
 *   - borda       bordaMeans() 的返回值
 *   - map         匿名标签 → 真实作者。★ **刻意不使用**：只在调用方做日志/审计，
 *                 **绝不能进 prompt** —— 否则定标者会带着"这是谁写的"的品牌偏见，
 *                 匿名就白做了。保留此参数是为了让调用方明确知道它是审计用的。
 * @returns {string} 定标阶段的 prompt
 */
function buildVerdictPrompt({ candidates = '', borda = null } = {}) {
  const lines = [];
  if (candidates) lines.push('【候选方案（已匿名）】', candidates, '');
  if (borda && borda.means && Object.keys(borda.means).length) {
    const rank = Object.entries(borda.means).sort((a, b) => a[1] - b[1]);
    lines.push('【各评审者的独立名次汇总（Borda 均值，越小越好）】');
    rank.forEach(([label, mean], i) => {
      const cov = borda.coverage && borda.coverage[label] != null ? `，被 ${borda.coverage[label]} 人排名` : '';
      lines.push(`${i + 1}. ${label}　均值 ${mean.toFixed(2)}${cov}`);
    });
    lines.push('');
    if (borda.warning) lines.push(`⚠ ${borda.warning}`, '');
    lines.push('★ 名次汇总由代码统计得出，不是谁的主观印象。你的任务是**确认结论并说明理由**：');
    lines.push(`　1) 为什么 ${borda.winnerId} 胜出（引用它方案里的具体内容）`);
    lines.push(`　2) 它相比 ${borda.runnerUpId || '备选'} 的取舍在哪`);
    lines.push('　3) 若你认为汇总有误，必须指出是哪一份名次表算错了，而不是重新投票');
  } else {
    lines.push('★ 尚无名次汇总（评标阶段没有解析出可用的名次表）——请说明为什么无法定标，不要凭印象指定胜出者。');
  }
  return lines.join('\n');
}

/**
 * 客观终止判据（纯集合逻辑，可单测）。
 *
 * ★ 为什么不能靠"跑到 N 轮就停"：
 *   如果第 2 轮已经挑不出新问题了，硬跑 5 轮就是烧配额刷 3 轮废话；
 *   反之如果第 5 轮还在冒新问题，硬停就是半成品交付。
 *
 * ★ 调用契约（第五轮踩过的坑，务必照做）：
 *   调用方**必须**把判据需要的字段一起传进来，否则判据会"静默失效"：
 *     - 'no-new-critique' / 'no-new-question' → critiques + prevCritiques / questions + prevQuestions
 *     - 'same-winner'   → winnerId + prevWinnerId （由 bordaMeans 算出，**不是** AI 拍板）
 *     - 'build-pass'    → buildPass （由集成验证的真实结果给出）
 *   漏传的后果是"判据恒返回不停止"，会议只能跑满 maxIterations —— 不报错、不崩溃，只是白烧钱。
 *
 * @param {string} modeId
 * @param {object} ctx
 *   - iteration       当前是第几轮迭代
 *   - critiques       本轮批评清单（字符串数组）
 *   - prevCritiques   上一轮批评清单
 *   - questions       本轮新问题（chairman 模式用）
 *   - prevQuestions   上一轮问题
 *   - winnerId        本轮定标结果（tournament 用，来自 bordaMeans）
 *   - prevWinnerId    上一轮定标结果
 *   - buildPass       集成验证是否通过（build 用）
 * @returns {{ stop:boolean, reason:string }}
 */
function shouldStop(modeId, {
  iteration = 1, critiques = [], prevCritiques = [], questions = [], prevQuestions = [],
  winnerId = null, prevWinnerId = null,
  /* ★ 用 null 而不是 false 作"未提供"的哨兵：
   *   false 是**合法值**（"集成没通过"），拿它当默认值会让"调用方漏传"和
   *   "集成确实没通过"变得无法区分 —— 缺参检测就永远不触发（这个坑踩过一次）。 */
  buildPass = null,
} = {}) {
  const mode = MODES[modeId];
  if (!mode) throw new Error(`shouldStop: unknown mode "${modeId}"`);

  // 迭代上限永远优先兜底（防止判据失效导致无限循环）
  if (mode.loop && iteration >= (mode.maxIterations || 5)) {
    return { stop: true, reason: `达到迭代上限 ${mode.maxIterations || 5} 轮` };
  }

  switch (mode.stopWhen) {
    case 'no-new-critique': {
      if (iteration <= 1) return { stop: false, reason: '第 1 轮尚无对比基线' };
      const fresh = newCritiques(critiques, prevCritiques);
      return fresh.length === 0
        ? { stop: true, reason: '本轮批评相对上一轮无新增，视为已收敛' }
        : { stop: false, reason: `仍有 ${fresh.length} 条新批评` };
    }

    case 'no-new-question': {
      if (iteration <= 1) return { stop: false, reason: '第 1 轮尚无对比基线' };
      const fresh = newCritiques(questions, prevQuestions);
      return fresh.length === 0
        ? { stop: true, reason: '主持人已无可追问的分歧点' }
        : { stop: false, reason: `主持人仍有 ${fresh.length} 个待追问点` };
    }

    case 'same-winner': {
      // 招标评审：连续两轮定标同一方案即收敛
      if (iteration <= 1) return { stop: false, reason: '第 1 轮尚无对比基线' };
      /* ★ 缺参告警（第五轮新增）：这一条曾经真实发生过 ——
       *   shell 调 shouldStop 时没传 winnerId，于是判据恒返回"尚无定标结果"，
       *   会议只能跑满 maxIterations。不报错、不崩溃，只是白烧钱（最难发现的一类故障）。
       *   现在缺输入会**显式说出来**，而不是装作"还没收敛"。 */
      if (winnerId == null) {
        return {
          stop: false,
          degraded: true,
          missingInput: ['winnerId'],
          reason: '★ 判据缺输入：未传入 winnerId（本轮定标结果）→ Borda 未接线，本判据无法生效，将跑满迭代上限',
        };
      }
      return tournamentStop({ winnerId, prevWinnerId, iteration });
    }

    case 'build-pass': {
      // 工程交付：集成通过即停；否则进修复回路（受 maxIterations 上限兜底）
      if (buildPass === null || buildPass === undefined) {
        return {
          stop: false,
          degraded: true,
          missingInput: ['buildPass'],
          reason: '★ 判据缺输入：未传入 buildPass（集成验证结果）→ 无法判断是否可交付，将跑满迭代上限',
        };
      }
      if (buildPass) return { stop: true, reason: '集成验证通过，软件可交付' };
      return { stop: false, reason: '集成未通过，进入修复回路' };
    }

    case 'single-pass':
    default:
      return { stop: true, reason: '单趟模式：阶段走完即结束' };
  }
}

/* ══════════════════════════════════════════════════════════════════
   名次表解析：把评标者的自然语言输出 → 结构化 ballots
   ══════════════════════════════════════════════════════════════════ */
/** 中文数字 → 阿拉伯数字（只到 99，够用） */
function cnToNum(s) {
  const D = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  if (s.length === 1) return D[s] || null;
  if (s[0] === '十') return 10 + (D[s[1]] || 0);
  if (s[1] === '十') return (D[s[0]] || 0) * 10 + (D[s[2]] || 0);
  return null;
}

/** 从一段"已剔除标签"的文本里抽名次数字 */
function pickRank(text) {
  const m = String(text).match(/(\d+)\s*(?:名|位)?/) ;
  if (m) return Number(m[1]);
  const cn = String(text).match(/([一二三四五六七八九十]{1,3})\s*(?:名|位)?/);
  if (cn) return cnToNum(cn[1]);
  return null;
}

/**
 * 解析评审者输出的名次表。
 *
 * ★ 为什么必须有这一层（第五轮审查发现的**贯通性缺口**）：
 *   模型输出的是自然语言，而 `bordaMeans` 要的是
 *   `[{ reviewer, ranks:[{proposal, rank}] }]`。
 *   中间的"解析层"没人写 → 策略函数全是**孤儿代码**（有测试、无生产调用）。
 *   同理适用于 CONTRACT 切片的契约结构。**没有这一层，判停与定标永远不会生效。**
 *
 * 支持四种常见写法（源自各模型实际输出习惯）：
 *   ① JSON 块： `{"方案A": 1, "方案B": 2}` 或 `[{"proposal":"方案A","rank":1}]`
 *   ② 序号前缀：`1. 方案A` / `2、方案B`
 *   ③ 标签后缀：`方案A 第 1 名` / `方案A：1` / `方案A - 2`
 *   ④ 表格行：  `| 方案A | 1 |`
 *
 * @param {Array<{reviewer:string, text:string}>} reviews 各评审者的原始回复
 * @param {object} opts
 *   - labels string[]  本轮合法标签（用于**防幻觉**：提到不存在的方案会被丢弃并告警）
 * @returns {{ ballots:Array, failed:Array, warnings:string[], coverage:Object }}
 *   - ballots  可喂给 bordaMeans 的结构化名次表（只含解析成功的）
 *   - failed   [{reviewer, reason}] 解析失败者（该票作废，**不猜**）
 *   - coverage { 方案A: 被排次数 } —— 用于识别"不完整排序"
 */
function parseBallots(reviews = [], { labels = [] } = {}) {
  const ballots = [];
  const failed = [];
  const warnings = [];
  const valid = new Set(labels);

  for (const rv of reviews) {
    const reviewer = rv.reviewer || '?';
    const text = String(rv.text || '');
    const got = new Map(); // label -> rank

    /* ① JSON 优先（最可靠，模型被要求输出 JSON 时命中） */
    const jsonBlob = (text.match(/\{[\s\S]*\}|\[[\s\S]*\]/) || [])[0];
    if (jsonBlob) {
      try {
        const parsed = JSON.parse(jsonBlob);
        const take = (proposal, rank) => {
          if (!proposal || typeof rank !== 'number' || !Number.isFinite(rank)) return;
          if (valid.size && !valid.has(proposal)) {
            warnings.push(`${reviewer} 提到不存在的方案「${proposal}」，已忽略`);
            return;
          }
          if (!got.has(proposal)) got.set(proposal, rank);
        };
        if (Array.isArray(parsed)) {
          for (const row of parsed) {
            if (row && typeof row === 'object') take(row.proposal || row.label || row.id, Number(row.rank));
          }
        } else if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            take(k, Number(typeof v === 'object' && v ? (v.rank ?? v.value) : v));
          }
        }
      } catch (e) { /* JSON 不合法 → 继续走文本解析 */ }
    }

    /* ②③④ 文本解析：按子句切，每子句配"最近的标签 + 该子句里的数字" */
    if (got.size < (valid.size || 1)) {
      const lines = text.split(/\n+/);
      for (const line of lines) {
        const clauses = line.split(/[，,；;、|]/);
        for (let ci = 0; ci < clauses.length; ci += 1) {
          const cl = clauses[ci];
          if (!cl.trim()) continue;
          // 找这一子句里出现的标签（多个时取第一个尚未记录的）
          const hit = valid.size ? [...valid].find((l) => cl.includes(l) && !got.has(l)) : null;
          if (!hit) continue;
          // 剔除标签文本后再抽数字 —— 否则 `1. 方案A` 的 "1" 会被标签污染
          const rest = cl.split(hit).join(' ');
          let rank = pickRank(rest);
          /* 表格/分隔写法会把标签与数字切到相邻子句：`| 方案A | 1 |`
           * → 子句 ["", "方案A", "1", ""]，标签那格没有数字，数字在下一格。
           * 若下一格不含任何标签，就认它是本标签的名次。 */
          if (rank == null) {
            const nxt = clauses[ci + 1] || '';
            if (nxt.trim() && !(valid.size && [...valid].some((l) => nxt.includes(l)))) rank = pickRank(nxt);
          }
          if (rank != null) got.set(hit, rank);
        }
      }
    }

    if (!got.size) {
      failed.push({ reviewer, reason: '未能从回复中解析出任何名次（该票作废，不猜）' });
      continue;
    }
    const ranks = [...got.entries()].map(([proposal, rank]) => ({ proposal, rank }));
    ballots.push({ reviewer, ranks });

    const missing = (labels.length ? labels.filter((l) => !got.has(l)) : []);
    if (missing.length) {
      warnings.push(`${reviewer} 漏排了 ${missing.length} 份（${missing.join('、')}）→ 不完整排序`);
    }
  }

  const coverage = {};
  for (const b of ballots) for (const r of b.ranks) coverage[r.proposal] = (coverage[r.proposal] || 0) + 1;

  return { ballots, failed, warnings, coverage };
}

/**
 * 招标评审（tournament）专用：Borda 名次均值 + 收敛判据。
 *
 * ★ 为什么用名次不用分数：
 *   不同 AI 的打分尺度不可比（一个给 3 分，一个给 8 分），
 *   名次（1..N）是**相对量**，跨评审者天然可比。
 *   Borda 计数：每个方案在 M 个评审者处的名次取均值，均值最低者胜。
 *   这是经典方法（阿拉伯数学 Borda 计数），一行代码，无黑盒。
 *
 * ★ 为什么不用 pairwise/Elo：
 *   N 份方案要 N×(N-1)/2 次两两对比，9 份 = 36 次调用，成本爆炸。
 *
 * @param {Array<{ reviewer:string, ranks:Array<{ proposal:string, rank:number }> }>} ballots
 *   每个评审者的名次表。ranks 的 rank 1 = 该评审者认为最好。
 * @returns {{ winnerId:string, runnerUpId:string, means:object, ballots:object, converged:boolean }}
 *   - winnerId    胜出方案
 *   - runnerUpId  备选（第二名，给"定标"阶段当 fallback）
 *   - means       { proposalId: 名次均值 }（越小越好）
 *   - ballots     { proposalId: 各评审者给的名次 }（审计用）
 */
function bordaMeans(ballots = []) {
  const means = {};
  const ballotsByProposal = {};
  for (const b of ballots) {
    if (!b || !Array.isArray(b.ranks)) continue;
    for (const r of b.ranks) {
      if (!r || !r.proposal || typeof r.rank !== 'number') continue;
      means[r.proposal] = (means[r.proposal] || 0) + r.rank;
      (ballotsByProposal[r.proposal] = ballotsByProposal[r.proposal] || []).push({
        reviewer: b.reviewer || '?', rank: r.rank,
      });
    }
  }
  for (const pid of Object.keys(means)) {
    const n = ballotsByProposal[pid].length || 1;
    means[pid] = means[pid] / n; // 均值（该方案被几个评审者排了名）
  }

  /* ★ 可比性检查（第五轮新增）：
   *   Borda 均值只有在**所有方案被排次数相同**时才能横向比较。
   *   若某个评审者漏排了方案（不完整排序），被排次数就不同，
   *   分母不同 → 均值不可比 → 结论会系统性偏向"被排次数多"的方案。
   *   这里不静默修复（那会引入黑盒），而是**显式标记**，由上层决定是否采信。 */
  const covList = Object.values(ballotsByProposal).map((v) => v.length);
  const maxCov = covList.length ? Math.max(...covList) : 0;
  const minCov = covList.length ? Math.min(...covList) : 0;
  const comparable = covList.length === 0 || maxCov === minCov;

  const sorted = Object.entries(means).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const tie = sorted.length > 1 && sorted[0][1] === sorted[1][1];

  return {
    winnerId: sorted.length ? sorted[0][0] : null,
    runnerUpId: sorted.length > 1 ? sorted[1][0] : null,
    means,
    ballots: ballotsByProposal,
    coverage: Object.fromEntries(Object.entries(ballotsByProposal).map(([k, v]) => [k, v.length])),
    comparable,
    tie,
    reviewers: new Set(ballots.filter((b) => b && b.reviewer).map((b) => b.reviewer)).size,
    warning: comparable ? null
      : `名次表不完整：各方案被排次数 ${minCov}~${maxCov} 不等，Borda 均值不可横向比较`
        + `（应让所有评审者排同样的方案集合）`,
  };
}

/**
 * 招标评审的收敛判据（shouldStop 的 'same-winner' 分支会调到这里）。
 *
 * ★ 可计算、不空转的判据：
 *   本轮定标的 winnerId 与上一轮的 winnerId 相同 → 视为收敛。
 *   即"改进后的方案没有让定标结果翻转"，再迭代也不会更好。
 *
 * @param {string} winnerId       本轮定标结果
 * @param {string} prevWinnerId   上一轮定标结果
 * @param {number} iteration      当前轮
 * @returns {{ stop:boolean, reason:string }}
 */
function tournamentStop({ winnerId = null, prevWinnerId = null, iteration = 1 } = {}) {
  if (iteration <= 1) return { stop: false, reason: '第 1 轮尚无对比基线' };
  if (winnerId && winnerId === prevWinnerId) {
    return { stop: true, reason: `连续两轮定标同一方案（${winnerId}），视为收敛` };
  }
  return { stop: false, reason: winnerId !== prevWinnerId ? `定标翻转为 ${winnerId}（上轮 ${prevWinnerId}），继续改进` : '尚无定标结果' };
}

/**
 * 求「本轮新增的批评」——文本规范化后求集合差。
 *
 * 规范化必须做，否则同一句批评换个标点就被算成"新问题"，
 * 反复修正模式会永远停不下来（这是这类系统最典型的失控方式）。
 */
function newCritiques(current = [], previous = []) {
  const norm = (s) => String(s || '')
    .replace(/\s+/g, '')          // 去所有空白
    .replace(/[。，、；：！？.,;:!?"'""''（）()【】\[\]「」…—-]/g, '') // 去标点
    .slice(0, 60);                // 只看前 60 字（防尾部措辞差异干扰）
  const seen = new Set(previous.map(norm).filter(Boolean));
  const out = [];
  const local = new Set();
  for (const c of current) {
    const k = norm(c);
    if (!k || seen.has(k) || local.has(k)) continue;
    local.add(k);
    out.push(c);
  }
  return out;
}

module.exports = {
  SPEAK,
  SLICE,
  MODES,
  MODE_IDS,
  getMode,
  listModes,
  resolveSeat,
  selectSlice,
  planPhases,
  shouldStop,
  newCritiques,
  bordaMeans,
  tournamentStop,
  // ── 第五轮新增（评标防锚定/防跟票 + 名次解析 + 成本估算）──
  anonymizeCandidates,   // 候选匿名化 + 确定性定序（CANDIDATES 切片的基石）
  anonLabel,             // 0→方案A、25→方案Z、26→方案AA
  fnv1a,                 // 内容哈希（用于定序，非安全用途）
  parseBallots,          // 评标自然语言 → 结构化名次表（原"贯通性缺口"的解析层）
  estimateCost,          // 单模式成本估算（调用次数 + 上下文注入量）
  costOverview,          // 全模式成本档位一览
  judgeBuildPass,        // 集成结果判定（不对称设计：承认失败可信，"通过"不采信）
  buildVerdictPrompt,    // 定标阶段 prompt 组装（喂 Borda 均值表，不让 AI 拍板）
};
