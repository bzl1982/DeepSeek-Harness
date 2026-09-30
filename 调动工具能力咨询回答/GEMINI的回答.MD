将网页版模型与本地系统的 \*\*DeepSeek Harness\*\* 进行融合，本质上是将“云端/网页端大脑”接入到了一个具备时空可组合性（Spatiotemporal Composability）的本地 Runtime 执行引擎中。



DeepSeek Harness 基于 \*\*Cordis 插件内核\*\*，它把模型适配器（Model Adapter）、系统工具（Tools）、Session 状态和沙箱（Sandbox）全盘插件化。要把网页版能力与 Harness 及其 200+ 本地插件深度贯通，可以沿着以下这套\*\*分层落地技术路线\*\*进行拆解：



\---



\### 一、 核心架构：三层桥接设计



```

┌─────────────────────────────────────────────────────────┐

│               网页端 / 远程 AI 模型 (Brain)               │

└───────────────────────────┬─────────────────────────────┘

&#x20;                           │ SSE / WebSocket / API Bridge

┌───────────────────────────▼─────────────────────────────┐

│             DeepSeek Harness (Cordis Engine)            │

│  ┌───────────────────────────────────────────────────┐  │

│  │ Custom Remote Model Adapter (提供 ctx.llm 接口)      │  │

│  └────────────────────────┬──────────────────────────┘  │

│                           │                             │

│       Cordis Service Directory (路由 \& 状态追踪)          │

│                           │                             │

│  ┌────────────────────────┴──────────────────────────┐  │

│  │ 200+ Tool Plugins | Local Sandbox | Session Logs  │  │

│  └───────────────────────────────────────────────────┘  │

└─────────────────────────────────────────────────────────┘



```



\---



\### 二、 具体落地步骤与技术方案



\#### 1. 注册 Remote Model Adapter（通信桥梁）



DeepSeek Harness 将模型抽象为了一个独立的 Adapter 插件。



\* \*\*方案\*\*：在 Harness 中写一个轻量级的 `Remote-Web-Adapter` 替换默认的本地 LLM 模块。

\* \*\*通信机制\*\*：

\* \*\*请求侧\*\*：Harness 将本地构建好的 System Prompt、上下文和工具 Schema 格式化后，通过 WebSocket / Server-Sent Events (SSE) 实时发送给网页端。

\* \*\*响应侧\*\*：网页端输出 Stream，并解析出 Function Call 请求返回给 Harness。







\#### 2. 工具 Dynamic Mounting 与 Context 压缩（解决 200+ 插件风暴）



直接把 200 个插件的 JSON Schema 一口气注入上下文，极易造成 Prompt 污染和 Token 浪费（甚至超出上下文限制）。



\* \*\*按需挂载（Spatial Composability）\*\*：充分利用 Cordis 的“空间可组合”特性，采用 \*\*两阶段工具路由（Two-Stage Dispatch）\*\*：

\* \*\*阶段 1（Intent Router）\*\*：定义一个轻量级的 Meta-Tool（如 `search\_local\_tools(category, query)`），网页端模型只需判断意图并检索相关的子工具。

\* \*\*阶段 2（Dynamic Tool Injection）\*\*：Harness 接收到请求后，通过 Cordis 的 API 动态 Mount 具体的插件并更新下一轮的 Schema。







\#### 3. 混合模式匹配（Runtime Profile Selection）



根据任务场景在 Harness 的不同运行模式间自由切分：



\* \*\*PTC / Code Mode\*\*：涉及复杂的本地批处理时，不逐个调用工具，而是让网页端生成一小段 TypeScript / Python 代码，交由 Harness 的 Code SDK 在本地沙箱中\*\*一次性批处理\*\*。

\* \*\*Standard Mode\*\*：常规的对话与文件读写、单步工具调用。

\* \*\*Minimal Mode\*\*：受限环境下的纯 Bash + 文件编辑模式。



\#### 4. 安全沙箱与权限控制（Security \& Isolation）



让网页端操控本地工具存在安全风险（如误删系统文件、执行危险 Shell 指令）：



\* \*\*权限分层（Privilege Ring）\*\*：为 200 个插件打上安全标签（`Read-Only` / `Isolated Workdir` / `Full System`）。

\* \*\*Docker / OS Sandbox\*\*：Harness 的底层执行环境（尤其是 Shell 工具）需挂载在 Docker 或 OS-level 沙箱中，仅暴露出特定的挂载目录（Workspace）。

\* \*\*Human-in-the-Loop\*\*：高危插件（如敏感系统改动）触发 Cordis 的拦截事件，需要本地点击确认才能继续执行。



\#### 5. 状态同步与 Trajectory 回溯（Temporal Composability）



利用 Harness 自带的 \*\*Append-only Session Log\*\*（追加式日志机制）：



\* 本地工具执行的日志、截图、Terminal 输出，实时打包为 JSON Event 写入 Trajectory 数据流。

\* 网页端能够以增量的形式渲染本地执行状态（如执行进度条、Terminal 实时输出预览）。



\---

