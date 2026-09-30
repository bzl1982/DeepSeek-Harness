完善版方案（Hy4 Preview 修订稿 v2）

先说明：文档1评审的“Hy4 Preview”就是我上一版「Web2API 网关 + M1–M5」方案。我接受评审的三条核心裁决，并按“官方源头核实”要求修正了其中几处事实与工程错误。下面是完善后的落地方案。



一、先用官方源把地基核实清楚（含对文档1的一处重要修正）

1.1 AutoGen 确已维护模式 —— 文档1正确

官方 github.com/microsoft/autogen README 原文（已核实）：



⚠️ Maintenance Mode：AutoGen is now in maintenance mode. It will not receive new features or enhancements and is community managed going forward. New users should start with Microsoft Agent Framework. Existing users are encouraged to migrate using the AutoGen → Microsoft Agent Framework migration guide. Microsoft Agent Framework (MAF) is the enterprise-ready successor to AutoGen.



MAF 已 GA：Microsoft Dev Blogs《Microsoft Agent Framework Version 1.0》（2026-04-03）写明 1.0 GA 于 2026-04-02/03，.NET + Python，稳定 API + LTS，由 AutoGen + Semantic Kernel 合并而来。



所以我上一版方案基于 AutoGen 0.2/0.4 是前提过期，整体废弃，不再引入 AutoGen 作为依赖。



1.2 修正文档1的一个事实：MAF 1.0 并没有删掉 Group Chat

文档1说“MAF 把 GroupChat 设计掉了（retired it on purpose）”。我核了官方迁移指南，这一条需要修正：



Microsoft Learn《AutoGen 到 Microsoft Agent Framework 迁移指南》目录明确列出多代理映射包含：



群组聊天模式

RoundRobinGroupChat 模式

MagenticOneGroupChat 模式

Dev Blogs 也写明 1.0 稳定编排模式含 Sequential / Group Chat / Magentic-One。

真正变化的是底层运行时：从 AutoGen 0.2/0.4 的 ConversableAgent + GroupChatManager（涌现式会话）换成 MAF 的 graph-based Workflow + 上述高层编排模式（带 checkpointing、request\_info 人工介入、确定性路由）。Group Chat 作为能力仍在，只是实现方式变了。



因此“不引入 MAF”的理由要改写（结论不变，理由更硬） ：



原文档1理由	完善后理由

MAF 不能表达 9 人会话式会议	❌ 不成立；MAF 有 GroupChat / RoundRobinGroupChat / MagenticOneGroupChat，能表达

——	✅ 真正理由1：项目铁律是纯 Node.js CommonJS、无编译、不分发 Python 运行时；MAF 是 Python/.NET，引入= sidecar + 进程管理 + 打包 Python，违反 PROTOCOL.md

——	✅ 真正理由2：你的 9 个 Adapter、Electron webview、Partitions/ 登录态、CDP uploadFileToWebview() 全在 Node/Electron 侧；改用 MAF 要用 Python 重写执行层，是重复造轮子+倒退

——	✅ 真正理由3：Phase 0 要验证的“完成检测 / 附件握手 / 并发失败隔离”\*\* 没有一个需要编排框架\*\*

——	✅ 保留升级路径：协议隔离后，未来若愿接受 Python sidecar，可把编排内核换成 MAF 的 GroupChat/RoundRobinGroupChat/MagenticOneGroupChat 或它的 durable checkpointing，Adapter/Electron/UI 都不动

1.3 AG2 是什么（回应文档1 §6 问题4）

原 AutoGen 作者 Chi Wang / Qingyun Wu 离开微软后，于 2024-11 fork 出 AG2（ag2ai 组织，Apache 2.0），继承 autogen / pyautogen PyPI 包，向后兼容 AutoGen 0.2 架构与 API（ConversableAgent / GroupChat），目前活跃开发中（\~4.7k stars，AG2 Beta 增加流式/事件驱动架构）。

结论：如果将来你坚持“原汁原味 AutoGen 会话式 GroupChat”且愿意接受 Python，AG2 比 legacy AutoGen 更合适；但它仍是 Python，解决不了纯 Node 约束，所以当前不引。



1.4 Magentic-UI / MagenticLite 为什么不能当底座（一手材料补充）

官方 github.com/microsoft/magentic-ui 仓库描述：



MagenticLite is an experimental agent that works across the browser and local file system.



Microsoft 论文《Magentic-UI: Towards Human-in-the-loop Agentic Systems》说明：WebSurfer 的浏览器跑在 Docker 容器里，限制其访问用户文件系统与原生浏览器状态（sessions/history 等） 。

这从一手材料解释了文档1的判断：MagenticLite 的浏览器不是你 Partitions/agent-\* 里那 9 个已登录的 Electron webview，你已跑通的“CDP DOM.setFileInputFiles 到现有 9 个 webview”无法直接复用；且它是 research prototype（Docker 强依赖）。所以不拿它当底座是正确的（文档1引用的 limitations.md 我没能从官方 repo 直接打开，但上述官方描述+论文已足够支撑该结论）。



二、我上一版方案的错误清单与逐条修正

\#	我上一版（Hy4）的问题	文档1批评	完善后修正

1	基于 AutoGen 0.2/0.4	前提过期	不引入任何 AutoGen/MAF 运行时，只抄编排模型

2	Python FastAPI + Playwright 另起浏览器	产品倒退、丢 9 宫格、要重新登录 9 个 AI	完全废弃 Python/Playwright/HTTP 网关；改 Node CommonJS，复用 Electron Main 的 9 个 webview + 已有 CDP 上传

3	send\_and\_wait 在 async 端点里 time.sleep	会阻塞事件循环，9 并发卡死	Node 侧用真 async/await + Promise + 超时/AbortController；核心逻辑 node --test 可无 GUI 测

4	完成检测=“连续3次文本相同”	流式会误判	升级为5 信号联合检测器（见 §3.1）

5	set\_input\_files 后无 ACK，直接发	这就是“9 人偶尔收不到文件”的根因	新增 AttachmentBus + 全 ACK 门闩（见 §3.2）

6	deepseek-chat 指到本地网关	混淆网页版与 API 版	严格二分：网页 Agent 走 Adapter（无 API）；主席/选择器/纪要压缩走真实 API（DeepSeek 官方 API 或本地 OpenAI 兼容）

7	伪装成“Model”（Web2API）	状态控制权让出去，上下文双重叠加	改为 Agent 级接入：WebAIChatAgent 自己消化 messages（只取最近 K 轮 + 摘要），状态归 Meeting Core

8	缓存	cache\_seed=None 教训保留	Node 侧默认不缓存 web AI 回复；MeetingMessage 为唯一事实源，可回放/重启恢复

我上一版被夸的 M1–M5 里程碑、“网页 AI 不知道别人说了什么必须手动喂会议记录”、“调度器不要用网页版”三点保留，并合并进文档1的 Phase 0–5。



三、完善后的目标架构

txt

复制

┌──────────────────────────────────────────────────────────┐

│ 通辽会议 UI（meeting.html）9宫格·会议记录·附件条·状态灯      │

│  （修 charLimit 死代码 bug，见 §6）                        │

└───────────────┬──────────────────────────────────────────┘

&#x20;               │ Electron IPC（已有 agent-tool-v1，非 HTTP）

┌───────────────▼──────────────────────────────────────────┐

│              Meeting Core（Node CommonJS，新增）            │

│  MeetingModel（消息/轮次/状态，唯一事实源）                  │

│  SpeakerStrategy（broadcast / round\_robin / llm\_selector） │

│  TerminationPolicy（MaxRound / TextMention / AllSpoke 组合）│

│  AttachmentBus（附件登记 + 全 ACK 门闩）★                   │

│  CompletionDetector（5 信号联合）★                          │

│  AgentStateMachine（per-AI 状态，可单独重试/闭麦）            │

│  ContextManager（★新增：注入窗口 + 网页 session reset）      │

│  SessionResetPolicy（★新增：何时 new\_conversation）         │

└───────────────┬──────────────────────────────────────────┘

&#x20;               │ Adapter 统一接口（已有，补 waitForResponse/uploadACK）

┌───────────────▼──────────────────────────────────────────┐

│ WebAI Adapter 层（已有 deepseek-web / generic-web）         │

│  sendText · uploadFiles · waitForResponse(★) · read…        │

│  每个 adapter 增 completion 配置块（5 信号各自的 selector）   │

└───────────────┬──────────────────────────────────────────┘

&#x20;               │ webview / CDP（已有）

┌───────────────▼──────────────────────────────────────────┐

│ 9 个 Electron webview（persist:agent-\*）已登录              │

│ DeepSeek·ChatGPT·Kimi·豆包·通义·元宝·Gemini·谷歌搜索·文心  │

└──────────────────────────────────────────────────────────┘

不再有：Python、FastAPI、HTTP 网关、Playwright、AutoGen、MAF。



四、三个关键机制的完善落地（这是“完善”的核心增量）

4.1 完成检测器：5 信号联合（替代固定 sleep / 连续相同）

text

复制

信号 A：Stop generating 按钮消失

信号 B：Send 按钮恢复可用

信号 C：assistant 消息节点 DOM 稳定 ≥ N ms（默认 1500ms，可配）

信号 D：CDP Network 域：该对话的流式请求结束（loadingFinished / WS 无新帧）

信号 E：页面“生成中”标志位消失



判定：满足 ≥2 个信号 → COMPLETED

&#x20;    超过 timeout（默认 180s，可配）→ TIMEOUT，标记「闭麦」，会议继续

&#x20;    发生异常/反爬 → FAILED，单点隔离

Shadow DOM / iframe 站点（豆包、通义等）怎么办：

在每个 webview 的 preload 脚本里注入 MutationObserver，并递归观察 shadowRoot（observer.observe(node, {subtree:true, childList:true, characterData:true})，遇到 node.shadowRoot 继续 observe）；观察到变化后通过 IPC 把“DOM 稳定事件”报给 Core。不要靠父页面读 iframe（跨域读不到）。CDP Network 域信号优先，DOM 信号作兜底。



4.2 附件握手：先上传齐、再统一发送（解决“文件收不全”根因）

text

复制

用户拖文件

&#x20; ↓

【会议层统一接管】Meeting Drop Controller：宿主 document 只接一次 DropEvent

&#x20; ↓  （不让 9 个 webview 各自抢 DropEvent —— 这是结构性病因）

AttachmentBus 登记：attachmentId + 落盘 + sha256 + name/size/mime

&#x20; ↓ fan-out 到 9 个 Adapter

&#x20; ↓ 每个 AI 用已有 uploadFileToWebview() → CDP DOM.setFileInputFiles

&#x20; ↓ ★ 每个 AI 回报 ACK（附件卡片出现 / 上传进度 100%），带超时+最多1次重试

&#x20; ↓

【门闩】waitForAllUploadACK(timeout)

&#x20; ↓ 全部 ACK → 统一放行 sendText()

&#x20; ↓ 部分失败 → 该 AI 降级为“文件名+文本摘要”并标 degraded，会议不卡住

&#x20; ↓

9 个 AI 同时开始回答

AttachmentRef 结构沿用文档1 §4.4（一个文件一个 attachmentId，9 个 AI 共用）。



4.3 上下文边界与压缩（回答文档1 §6 问题1 \& 问题3）

状态边界定义（文档1盲点2的正面答案） ：



唯一事实源 = MeetingModel（MeetingMessage 列表）。网页端上下文只是单个 AI 的短期记忆，不是会议状态。

注入公式（每个 WebAgent 每轮）：

txt

复制

prompt = 角色system

&#x20;       + \[本轮任务]

&#x20;       + \[最近 N 轮原文]        ← 默认 N=2，可配

&#x20;       + \[更早历史压缩摘要]      ← ContextManager 产出的 rolling summary

绝不把全量会议历史无脑塞进网页 AI（否则网页端自有上下文 + 你注入的历史 = 双重叠加，上下文窗口加速膨胀）。

网页端重置策略：ContextManager 监控“累计注入 token”或“轮次”。超阈值（如累计注入 >6k token，或 round % 3 == 0，或用户显式点“新议题”）→ 对该 AI 调 new\_conversation() / reset\_session 清空网页端；下一条消息带上压缩摘要续接，保证连续性又不膨胀。

压缩模型：用真实 API 模型（DeepSeek 官方 API 最划算、中文好；或本地 Ollama/Qwen 的 OpenAI 兼容端点），绝不用网页 AI 做压缩（慢、占额度、还添乱）。压缩时机：每轮结束产“轮纪要” + 超阈值触发滚动压缩（保留最近 1 轮原文 + 历史摘要）。

五、对文档1 §6 五个开放问题的答复（完善增量）

Q1｜上下文边界：见 §4.3。不要只靠“摘要注入”土办法；正解是 “Meeting Core 权威状态 + 定期 reset 网页 session + 摘要续接” 三者组合。



Q2｜9 个 AI 的完成检测信号怎么取：见 §4.1。统一 5 信号；iframe/Shadow DOM 靠 preload 注入 + 递归 shadowRoot；CDP Network 域最稳，优先为每个 AI 配 network 信号，DOM 信号兜底。每个 adapter 增一个 completion: {aSel, bSel, cStableMs, dNetworkPattern, eFlagSel} 配置块，site-specific 但不写死进编排层。



Q3｜会议记录压缩策略与时机：见 §4.3。模型 = DeepSeek-Chat API（或本地 OpenAI 兼容）；时机 = 每轮结束 + 阈值 6k token 滚动压缩。



Q4｜MAF 能否表达动态点名 / AG2 怎么看：



MAF 能：它 1.0 有 GroupChat / RoundRobinGroupChat / MagenticOneGroupChat；动态点名在 MAF 里可用 llm\_selector 思想在 Workflow 状态中路由，或用条件边 + ctx 表达，只是比 AutoGen 的 GroupChatManager 显式、样板多。

但你当前不引 MAF，理由是纯 Node 铁律 + 执行层已在 Electron（见 §1.2），不是因为它不能开会。

AG2 是原 AutoGen 0.2 的社区延续（Apache 2.0、活跃、兼容 GroupChat）。若将来接受 Python 且要“会话式群聊”，AG2 优于 legacy AutoGen；当前同样不引。

Q5｜反爬与限速工程实践：



沿用 Partitions/ 里真实已登录指纹：headless:false、不伪造指纹、不无头跑（这正是 GPT 方案“Electron 拥有浏览器”的最大价值）。

错峰：每个 AI 随机 300–1500ms 延迟提交；轮次间 cooling ≥20–30s。

削峰：广播轮可微错峰；若某轮并发太高，限制“同时处于生成中”的 AI 数（如 ≤3），其余排队，避免 9 个同时打同 IP。

风控即闭麦：出现验证码/风控/连续超时 → 该 AI 立即 FAILED/闭麦，通知用户人工处理，不自动重试风暴、不绕过验证码。

合规：网页自动化仅内部研究/低频；正式能力优先走官方 API——9 家里有 API 的（如 DeepSeek）尽量走 API，只有无 API 的网页版走 Adapter。绝不推荐账号轮换/指纹伪造。

六、Phase 0 测试台的完善（对齐文档1 §5，并补我的修正）

目录沿用 meeting-lab/，不碰 desktop/ 一行代码；补两个我新增的模块：



txt

复制

core/

&#x20; meeting-model.js

&#x20; completion.js          # 5 信号联合（可注入 mock 信号）

&#x20; attachment-bus.js      # ACK 门闩 + 降级

&#x20; speaker.js             # broadcast / round\_robin / llm\_selector

&#x20; orchestrator.js        # Promise.allSettled 扇出 + 单点隔离

&#x20; context-manager.js     # ★新增：注入窗口 + rolling summary

&#x20; session-reset.js       # ★新增：reset\_session 策略

adapters/

&#x20; contract.js

&#x20; deepseek-web.js        # 增 completion 配置块

&#x20; generic-web.js

test/                    # node --test，无 GUI

&#x20; completion.test.js

&#x20; attachment-bus.test.js

&#x20; orchestrator.test.js

&#x20; context-manager.test.js

shell/                   # 最小 Electron 壳，--user-data-dir 指向

&#x20;                        # D:\\Users\\Admin\\AppData\\Roaming\\DeepSeek Harness

&#x20;                        # 复用 9 个已登录 partition

验收标准（在原三条基础上加两条） ：



完成检测对短答/长答/流式答都不误判、不漏判（mock 信号驱动状态机）；

附件 ACK 全到齐才发；单 AI 上传失败能单独重试/降级，不拖垮会议；

一个 AI 卡死/掉线，其余 8 个照常完成（单点隔离）；

★上下文不双重叠加：同一 turn 网页端收到的 prompt 中，不出现“自身已说过内容”的重复注入；

★reset 后续接正确：reset\_session 后新会话第一条消息带摘要，AI 能延续议题。

顺手修的现成 bug：meeting.html:672 用了 model.charLimit，但 agentCatalog.js 无此字段 → 恒 undefined → fullText.length > undefined 恒 false → “超长分批”是死代码。建议在 agentCatalog.js 给 9 个 provider 补 charLimit 字段（默认 4000，和现有“>4000 字转 .md”逻辑对齐） ，而不是删分支。



七、完善后的分期路线

阶段	目标	交付	碰客户端?

Phase 0	meeting-lab 验证三不确定性 + 上下文管理单测	Node 模块 + node --test 结果	❌

Phase 1	Meeting Core 抽为独立 Node 模块（含 ContextManager/SessionReset）	可 require 的模块	❌（只增目录）

Phase 2	meeting.html 接入“广播 + ACK 附件 + 状态机 + 完成检测”；修 charLimit	客户端小步改动	✅

Phase 3	SpeakerStrategy 升级 llm\_selector（主席 API）→ 动态点名/交叉辩论；ContextManager 压缩+reset；出会议纪要	会议真升级	✅

Phase 4（可选）	协议隔离下，把编排内核换成 MAF（GroupChat/RoundRobinGroupChat/MagenticOneGroupChat）或 AG2 sidecar	编排替换，Adapter/Electron/UI 不动	❌

Phase 5（可选）	视觉兜底：AX Tree + 截图 + CDP Network 自愈，改版自愈	抗网页改版	✅

八、一句话定案（完善版）

Electron 拥有浏览器（手和眼睛：9 个已登录 webview + CDP 文件注入），Node Meeting Core 拥有会议规则（脑：消息模型、发言策略、终止条件、附件 ACK 门闩、5 信号完成检测、上下文边界与压缩），Adapter 做 DOM↔统一消息翻译。编排模型抄 AutoGen（round\_robin / selector / 终止组合），但运行时零依赖——不引 AutoGen、不引 MAF、不引 Playwright、不引 Python/HTTP 网关。Phase 0 先在 meeting-lab 用 node --test 把“完成检测、附件 ACK 门闩、并发单点失败隔离”三件事验证掉，再回客户端；MAF/AG2 仅作为协议隔离后的可选升级路径。



如果你要，我下一步可以直接产出：① completion.js 的 5 信号状态机实现（带 mock 测试）；② attachment-bus.js 的 ACK 门闩 + 降级实现；③ context-manager.js 的注入/压缩/reset 接口定义——这三块是 Phase 0 真正要先跑通的代码。

