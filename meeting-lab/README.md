# meeting-lab —— 通辽会议 Phase 0 独立测试台

> **本目录与 DSH 客户端完全隔离**：不 require `desktop/` 下任何文件，不修改客户端一行代码。
> 目的：在动客户端之前，先把三个"不确定性"验证掉。

---

## 为什么要有这个目录

通辽会议现在的形态是 **Broadcast-Led**：你发一条消息/文件，9 个网页 AI 同时收到，各自回答。

但它缺三样地基（详见 `../微软多人交流咨询/评审与定案-20260922.md` §3.2）：

| 缺口 | 现状 | 后果 |
|---|---|---|
| **回复完成检测** | 完全没有 | 不知道 AI 答完没有 |
| **附件握手** | 上传后固定 `sleep(3000ms)` 就发 | **这就是"9 个人偶尔收不到文件"的根因** |
| **per-AI 状态机** | 只有"加载中……" | 卡住无法定位、无法单独重试 |

先在这三件事上拿到确定性，再谈引入编排框架。

---

## 怎么跑

### 1. 跑测试（不需要浏览器、不需要真 AI）

```bash
cd "D:\DeepSeek Harness\meeting-lab"
node --test test/*.test.js
```

当前：**85 个用例全部通过**。覆盖——

- `completion.test.js` —— 完成检测：信号不足不误判、流式短暂稳定不误判、超时收敛
- `stream-tracker.test.js` —— ★ **streamEnd（CDP 网络层）**：宽限期内不早判、流在飞不判完、多流并行、跨轮清零回归
- `web-adapter.test.js` —— ★ **两个真 bug 的回归保险**（空回复误判完成 / streamEnd 跨轮闩锁）
- `context-strategy.test.js` —— ★ **分歧 #1 落地**：角色分化（防 9 个复读机）+ Hy4 注入公式 + KIMI 触发条件（超阈值才压缩 / 跑偏才单点重置）
- `summarizer.test.js` —— ★ **盲点 C 落地**：轮纪要 ≤300 字 / 每 5 轮全局压缩 / 压缩器失败优雅降级
- `attachment-bus.test.js` —— 附件门闩：有任何一个没 ACK 就绝不放行、失败降级、超时降级
- `orchestrator.test.js` —— 编排：9 并发、**单点失败隔离**、**超时不锁死会议**、单点重试
- `meeting-model.test.js` —— 会议模型 + per-AI 状态机（含"禁止状态倒退"）

### 2. 跑演示（终端看完整时序）

```bash
node demo/run-demo.js
```

会打印三轮时序：广播 → 带附件（一个上传失败降级、一个出验证码被隔离）→ 单点重试恢复。

### 3. 开可视化壳（真实网页 AI）

```bash
# 独立模式（干净 userData，需自行登录）
..\desktop\node_modules\electron\dist\electron.exe .

# 复用客户端已登录的账号（★ 需先关闭 DSH 客户端，避免 userData 被占用）
..\desktop\node_modules\electron\dist\electron.exe . --reuse-login
```

`--reuse-login` 会把 userData 指向
`D:\Users\Admin\AppData\Roaming\DeepSeek Harness`，
从而直接复用 `Partitions/agent-*` 里那 9 个已登录账号——**不用重新扫码**。

---

## 目录结构

```
meeting-lab/
├── core/                       # 纯 Node，可 node --test（无 GUI 依赖）
│   ├── meeting-model.js        # 会议消息 / 轮次 / per-AI 状态机
│   ├── completion.js           # ★ 完成检测器（5 信号联合）
│   ├── attachment-bus.js       # ★ 附件总线（ACK 门闩）
│   ├── speaker.js              # 发言策略：broadcast / round_robin / llm_selector / manual
│   └── orchestrator.js         # ★ 会议编排：两阶段（先握手后发言）+ 失败隔离
├── adapters/
│   ├── contract.js             # 统一契约 + 校验（含 withGuards）
│   ├── web-adapter.js          # 通用工厂 + 页面侧信号采集探针
│   ├── deepseek-web.js         # DeepSeek 选择器 profile（特化）
│   └── generic-web.js          # 通用选择器 profile（宽松兜底）
├── test/                       # node --test
├── demo/run-demo.js            # 终端演示
└── shell/                      # 最小 Electron 壳（3 个 webview 可视化验证）
```

★ = 三个要验证的核心

---

## 三个核心设计（对应评审文档 §4.4）

### 1. 完成检测：多信号联合，绝不固定 sleep

```
信号 A  stopGone      Stop generating 按钮消失
信号 B  sendReady     Send 按钮恢复可用
信号 C  domStable     回答内容连续 N ms 无变化（派生信号，需真正静默够久）
信号 D  streamEnd     流式请求结束（CDP Network 域，可选）
信号 E  genFlagGone   "生成中"标志位消失
```

满足 **≥ 2 个** → `COMPLETED`；超时 → `TIMEOUT`（标记"闭麦"，会议继续）。

> 为什么不用"连续 3 次文本相同"？流式输出段间会短暂稳定，照样误判。
> 为什么不用"消息节点数增加"？节点在生成中就会出现，会抓到半截回答。

### 2. 附件握手：先上传齐，再统一发送

```
用户拖文件
   ↓ 会议层统一接管（不让 9 个 webview 各自抢 DropEvent）
AttachmentBus 登记 → attachmentId + 落盘 + sha256
   ↓ Phase A：并发投递给每个 AI（CDP DOM.setFileInputFiles）
   ↓ 每个 AI 回报 ACK（页面真的出现附件卡片才算成功）
   ↓ Phase B：【门闩】等全部 ACK 到齐
   ↓   · 全齐 → PROCEED
   ↓   · 有失败/超时 → DEGRADE（仅该 AI 降级为文本投递，不阻塞整场）
   ↓ Phase C：统一放行 sendText()
```

> ⚠️ **踩过的坑（已修）**：v1 把顺序写反了——先开门闩等 ACK，上传却在门闩之后。
> 结果永远等不到 ACK，直接死锁。**必须"先投递、后等待"。**

### 3. 失败隔离：一个卡死，其余照常

- 每个 AI 一条独立 async 流水线，状态互不共享
- 全流程 `try/catch` 收敛为 per-AI 异常态（`CAPTCHA_REQUIRED` / `RATE_LIMIT` / `TIMEOUT` / …）
- `Promise.allSettled` 汇总，**对外永不 reject**
- 失败者进"闭麦"名单，可 `retryAgent()` **单独重试**，不重开整场会议

---

## 与客户端现有 adapter 的关系

客户端已有 `agent/adapters/{deepseek-web,generic-web}`，接口是：

```
detectMessage / readAssistantMessage / sendUserMessage / detectToolCall / injectResult
```

那是面向 **"工具调用闭环"** 的。本测试台的契约在其之上**补了 3 个会议必需能力**：

| 新增 | 作用 |
|---|---|
| `isReady()` | 开会前探测能力（借鉴 Magentic-UI） |
| `uploadFiles()` | 带 ACK 的文件上传 |
| **`waitForResponse()`** | **★ 完成检测（现在完全没有，是最大缺口）** |
| `cancel()` | 单点中止（闭麦） |

Phase 2 接客户端时，是**扩展现有 adapter**，不是推倒重来。

---

## 决策基线（8 条共识，来自第二轮评审，详见 ADR-001.md）

| # | 基线 | 影响本目录 |
|---|---|---|
| 1 | 不引入 AutoGen 作运行时依赖 | 本目录是"抄其模型不引运行时"的实现 |
| 2 | Phase 0–3 不引入 MAF（工程边界理由，非能力理由） | 编排内核 = 本目录 `orchestrator.js`；将来可换 Port 实现 |
| 3 | Electron 拥有浏览器（不重开 Playwright） | `shell/` 用 Electron webview + CDP，不用 Playwright |
| 4 | 附件先齐后发（ACK 门闩），判据落到 DOM 附件卡片 | `attachment-bus.js` + `web-adapter.uploadFiles` |
| 5 | 完成检测多信号联合，CDP 最稳、DOM 兜底，绝不固定 sleep | `completion.js` + `stream-tracker.js` |
| 6 | 主持人 / 选择器 / 纪要压缩走真实 API | `speaker.js` 的 `llm_selector` 策略 |
| 7 | MeetingModel 是唯一事实源，网页端上下文只是缓存 | `meeting-model.js` |
| 8 | Phase 0 验收三条：不误判 / 全 ACK / 单点不拖垮全局 | 本目录测试全部针对这三条 |

---

## 下一步（Phase 1+）

1. 把 `core/` 抽成客户端可复用的模块（仍不碰 `meeting.html` 的现有逻辑）
2. 把 `shell/` 的 driver 换成客户端 `meeting.html` 里那套（`wv.insertText` + `wv.debugger`）——**已在 shell 里预演过，可直接搬**
3. 客户端 `meeting.html` 接入：状态灯 + 附件握手 + 会议记录模型
4. 加 `SpeakerStrategy`（轮询 → 动态点名）+ 主持人（用 API，不用网页版）
5. 保留升级路径：Meeting Core 与编排层之间协议已隔离，将来可换成 Microsoft Agent Framework sidecar

---

## 已知限制

- ~~`streamEnd` 信号暂未接入~~ → **已接入**：见 `core/stream-tracker.js` + `shell/cdp-driver.js`
  （纯逻辑部分已 15 个用例覆盖；CDP 挂载需真实网页验证，见 `shell/cdp-driver.js` 注释）
- 访问真实网页 AI 需自行登录；各站点 ToS 禁止自动化，属内部研究，请限速使用
- `shell/` 用了 `nodeIntegration: true`（仅为本地测试台方便），**不可照搬到生产**

---

## 修订记录

### 第二轮（本轮）：分歧落地 + 客户端小改

| 项 | 改前 | 改后 |
|---|---|---|
| 分歧 #1（上下文重置） | 纸面建议（Hy4 公式 + KIMI 触发条件） | ✅ `core/context-strategy.js` 实现，9 用例锁死 |
| 盲点 A（同质化坍塌） | 未落地 | ✅ `composePrompt()` 角色分化 + 客户端 `AGENT_ROLES` 内联 |
| 盲点 C（纪要容量） | 未落地 | ✅ `core/summarizer.js` 轮纪要 ≤300 字 / 每 5 轮全局压缩，8 用例锁死 |
| P0（附件真实路径） | 客户端 `attachedFiles` 无 `localPath` | ✅ 客户端 3 处改动 + 主进程 `saveAttachment`（带安全校验） |
| P3-lite（charLimit） | `agentCatalog.js` 无此字段，9 个 AI 全硬编码 10000 | ✅ 每模型独立 charLimit，具名常量 `INLINE_MAX`/`DEFAULT_CHAR_LIMIT` |
| ADR-001 | 无 | ✅ 8 条共识冻结为 ADR |
| 用例数 | 68 | **85** |

### 第一轮

| 项 | v1 | 现在 |
|---|---|---|
| `streamEnd` 信号 | ❌ 布尔闩锁，且从未接 CDP（白占一个信号位） | ✅ `StreamTracker`，每轮 `arm()` 清零 |
| `streamEnd` 跨轮 | 🐛 **永久为真** → 第二轮瞬间误判完成 | ✅ 已修 + 回归测试锁死 |
| `domStable` | 🐛 起手即真 → 空回复被判完成（抓空气） | ✅ 要求先看到非空内容 |
| 用例数 | 45 | **85** |
