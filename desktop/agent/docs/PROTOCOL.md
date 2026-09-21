# AI Agent Browser × DeepSeek Harness — 冻结协议 v1.0

> 本文档是 **第一阶段 MVP 的唯一契约**。Browser 侧（Electron）与 Harness 侧（本地 Agent Runtime）
> 都以本文件为准；任何字段、状态码、端点、权限等级的变更都必须先改本文档，再改代码。
>
- 协议信封版本：`agent-tool-v1`
- 首个 Provider：DeepSeek Web（https://chat.deepseek.com/）
- 首个 Runtime：DeepSeek Harness（localhost）
- 目标平台：Windows 优先
- 技术栈：Electron（渲染层跑网页 AI）+ 纯 Node.js CommonJS（Harness），**无编译步骤**，`npm install && npm start` 即可运行。

---

## 0. 安全红线（不可妥协）

1. **网页 AI 永远不直接获得操作系统权限。** 调用链必须是：
   `Web Page → window.agent（preload 注入）→ IPC → Electron Main → localhost → Harness → Tool → OS`
2. **禁止**向网页暴露 `require` / `child_process` / `fs` / `process.binding`。preload 必须 `contextIsolation: true`、`nodeIntegration: false`。
3. 网页只能拿到有限的 `window.agent` API（见 §11），拿不到任何 Node 句柄。
4. 工具按域划分（filesystem/shell/git/process/browser/docker/adb），平台差异用 Adapter 隔离；AI 永远只看到 `shell.exec`，不知道底层是 PowerShell 还是 zsh。
5. 危险操作（写/删/执行 shell、ADMIN）走用户确认；开发期默认开启 **Dry Run**。
6. 每一次工具调用都落审计日志。

---

## 1. 传输层（Transport）

Browser 与 Harness 之间只用 **localhost**，不监听外网网卡。

| 通道 | 地址 | 用途 |
|------|------|------|
| HTTP（请求/响应） | `http://127.0.0.1:<PORT>/...` | 启动握手、拉取工具清单、一次性 tool.call |
| WebSocket（双向） | `ws://127.0.0.1:<PORT>/agent` | 实时任务、流式 stdout、执行进度、确认请求（confirmation） |

- `<PORT>`：默认 `17321`，可被环境变量 `HARNESS_PORT` 覆盖。
- 鉴权：仅本机回环 + 一个启动时生成的随机 token，放在请求头 `X-Agent-Token`。Electron 启动 Harness 时把 token 通过 stdio/配置文件拿给 Browser，不硬编码。
- **不用文件 watcher 作为正式通道**（白皮书 §19）；文件通信只允许调试。

### 1.1 HTTP 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET`  | `/agent/health` | 健康检查，返回 `{ "ok": true, "version": "agent-tool-v1", "dryRun": bool }` |
| `GET`  | `/agent/tools` | 返回当前会话可用的工具清单（含权限声明） |
| `POST` | `/agent/tool` | 同步执行一次 ToolCall（短期工具用；长时间工具走 WebSocket） |
| `POST` | `/agent/session` | 创建/恢复一个会话，返回 `sessionId` |
| `GET`  | `/agent/audit?sessionId=...` | 拉取该会话审计日志（调试/排查用） |

### 1.2 WebSocket 帧（JSON 文本帧，一帧一条消息）

Browser→Harness：`tool.call`、`session.hello`、`confirmation.respond`、`ping`
Harness→Browser：`tool.result`、`tool.progress`、`confirmation.request`、`task.start`、`task.end`、`pong`、`error`

帧统一包信封，见 §2。

---

## 2. 消息信封（Envelope）

所有跨进程消息（HTTP body、WS 帧）都必须是下列信封之一。**必填字段缺失即视为非法消息，直接拒绝。**

```jsonc
{
  "protocol": "agent-tool-v1",   // 固定，缺省/不匹配 = 拒绝
  "type": "tool.call",           // 消息类型，见 §3
  "requestId": "req-001",        // 幂等/关联键，一次工具意图一个唯一 id
  "sessionId": "sess-abc",       // 会话 id，同一次聊天窗口保持不变
  "timestamp": 1732000000000,    // Unix ms
  "payload": { }                 // 各 type 的载荷，见 §3
}
```

关联规则：
- `requestId`：由发起方（Browser）生成，**全局唯一**（建议 `req-<时间戳>-<随机>`）。Harness 的 `tool.result` / `error` 必须原样带回同一个 `requestId`。
- `sessionId`：由 Harness 在 `session.hello` / `POST /agent/session` 时生成并下发；Browser 后续所有消息带上它。同浏览器标签/聊天窗口 = 一个 session。

---

## 3. 消息类型与载荷

### 3.1 `session.hello`（Browser→Harness）
```jsonc
{
  "type": "session.hello",
  "payload": {
    "provider": "deepseek-web",     // web adapter 名
    "userAgent": "ai-agent-browser/0.1.0",
    "dryRun": true,                 // Browser 请求 Dry Run 模式（Harness 最终决定）
    "taskContext": "project"        // 任务上下文，决定暴露哪些工具域，见 §9
  }
}
```
Harness 回 `session.ready`：
```jsonc
{
  "type": "session.ready",
  "payload": { "sessionId": "sess-abc", "dryRun": true, "availableTools": ["filesystem.list", "filesystem.read", "filesystem.search", "shell.exec", "git.status", "git.diff", "git.log"] }
}
```

### 3.2 `tool.call`（Browser→Harness）
```jsonc
{
  "type": "tool.call",
  "requestId": "req-001",
  "sessionId": "sess-abc",
  "payload": {
    "tool": "filesystem.read",
    "arguments": { "path": "D:\\MediaForge\\app\\tmdb.py" }
  }
}
```

### 3.3 `tool.result`（Harness→Browser，成功）
```jsonc
{
  "type": "tool.result",
  "requestId": "req-001",
  "sessionId": "sess-abc",
  "payload": {
    "status": "success",
    "dryRun": false,                // 是否实际未执行（Dry Run）
    "durationMs": 42,
    "result": {
      "content": "文件文本内容...",   // filesystem.read 返回
      "meta": { "size": 1024, "mtime": 1732000000000 }
    }
  }
}
```

### 3.4 `tool.result`（Harness→Browser，失败）
```jsonc
{
  "type": "tool.result",
  "requestId": "req-001",
  "sessionId": "sess-abc",
  "payload": {
    "status": "error",
    "durationMs": 12,
    "error": {
      "code": "PERMISSION_DENIED", // 见 §5 错误码表
      "message": "需要 ADMIN 权限且未获确认"
    }
  }
}
```

### 3.5 `tool.progress`（Harness→Browser，流式，仅长任务）
```jsonc
{
  "type": "tool.progress",
  "requestId": "req-009",
  "payload": { "stream": "stdout", "data": "正在安装...\n", "seq": 7 }
}
```

### 3.6 `confirmation.request`（Harness→Browser，需用户确认）
当工具声明的权限等级要求人工确认时，Harness **不执行**，先问：
```jsonc
{
  "type": "confirmation.request",
  "requestId": "req-010",
  "payload": {
    "confirmationId": "cf-001",
    "tool": "filesystem.write",
    "arguments": { "path": "D:\\MediaForge\\app\\tmdb.py", "...": "..." },
    "requiredPermission": "WRITE",
    "reason": "将覆写已有文件",
    "ttlMs": 60000
  }
}
```
Browser 必须弹出原生确认 UI（**不是网页里的 confirm()**），用户选择后回：
```jsonc
{
  "type": "confirmation.respond",
  "requestId": "req-010",
  "payload": { "confirmationId": "cf-001", "decision": "approve", "remember": false }
}
```
`decision`: `"approve"` | `"deny"`。超时未响应 = 视为 `deny`，回 `tool.result{status:error, code:CONFIRMATION_TIMEOUT}`。

---

## 4. 权限模型

### 4.1 权限等级（从低到高）

| 等级 | 含义 | 默认策略 |
|------|------|----------|
| `READ` | 只读本机数据（读文件、列目录、git status/diff/log） | 自动放行 |
| `WRITE` | 写文件、删文件、移动文件 | **需确认**（除非 Dry Run） |
| `EXECUTE` | 执行 shell / 进程 | **需确认** + 危险命令检测 |
| `NETWORK` | 发起网络请求 | 第一阶段不暴露 |
| `ADMIN` | 管理员级操作（sudo、改系统配置、ADB 写、Docker 写） | **必须确认**，默认拒绝 |

### 4.2 工具权限声明（工具注册时自带）
每个工具在 Registry 里声明所需等级，例如：
```jsonc
{ "tool": "filesystem.read", "permission": "READ" }
{ "tool": "filesystem.write", "permission": "WRITE" }
{ "tool": "shell.exec",       "permission": "EXECUTE" }
{ "tool": "git.commit",       "permission": "WRITE" }
```

### 4.3 危险命令检测（shell.exec，硬编码黑名单模式）
命中以下任一模式，即使 `EXECUTE` 已确认也按 `ADMIN` 处理并二次确认：
`rm -rf /`、`del /s`、`Format-Volume`、`mkfs`、`rmdir /s`、`git push --force`、`shutdown`、`Remove-Item -Recurse -Force C:\`、`reg delete`、`net user`、`choco uninstall`、`npm publish` 等。
具体规则在 `harness/tools/shell/hazard.js` 集中维护，**不要散落在各处**。

---

## 5. 错误码表（code，字符串，固定集合）

| code | 触发 |
|------|------|
| `BAD_ENVELOPE` | 信封缺字段 / protocol 不匹配 |
| `UNKNOWN_TOOL` | 工具未注册或不在当前会话可用清单 |
| `INVALID_ARGUMENTS` | 参数 schema 校验失败 |
| `PERMISSION_DENIED` | 权限不足且未确认 |
| `CONFIRMATION_REQUIRED` | 需要确认但未走确认流程 |
| `CONFIRMATION_TIMEOUT` | 确认超时 |
| `TOOL_TIMEOUT` | 工具执行超过 timeoutMs |
| `TOOL_CRASHED` | 子进程异常退出 / 非零退出码（shell 用） |
| `TOOL_NOT_FOUND` | 可执行文件不存在（如 git 未安装） |
| `FILE_NOT_FOUND` | filesystem 目标不存在 |
| `DRY_RUN` | Dry Run 模式下未实际执行（status 仍为 success，dryRun=true） |
| `INTERNAL_ERROR` | Harness 自身错误 |

---

## 6. Dry Run（干跑）

- 会话级开关。`session.hello.payload.dryRun` 请求；Harness 返回 `session.ready.payload.dryRun` 作为最终状态。
- Dry Run 开启时：所有 `WRITE`/`EXECUTE`/`ADMIN` 工具 **不真正执行**，返回：
```jsonc
{ "status": "success", "dryRun": true, "result": { "content": "[DRY RUN] 未实际执行 filesystem.write -> D:\\MediaForge\\app\\tmdb.py" } }
```
- `READ` 类工具正常执行（读不会改系统）。
- 第一阶段默认 `dryRun=true`；只有用户在 UI 里显式关闭才写盘。

---

## 7. 审计日志（Audit Log）

每次工具调用落一条 JSON 行（JSONL），文件：`harness/data/audit-<date>.jsonl`。字段：

```jsonc
{
  "ts": "2026-09-20T20:31:02.123+08:00",
  "sessionId": "sess-abc",
  "provider": "deepseek-web",
  "requestId": "req-001",
  "tool": "filesystem.read",
  "arguments": { "path": "D:\\MediaForge\\app\\tmdb.py" },
  "requiredPermission": "READ",
  "confirmation": "auto",          // auto | approved | denied | timeout
  "dryRun": false,
  "resultStatus": "success",       // success | error
  "errorCode": null,
  "durationMs": 42
}
```

---

## 8. 网页 AI 产生 ToolCall 的四级兼容

Browser 侧按优先级逐级降级检测，**越往下越不可靠**：

| 级别 | 方式 | 说明 |
|------|------|------|
| L1 | 原生结构化 | 网页直接吐 JSON（极少数情况），直接解析 |
| L2 | **约定式 Agent Markup（主路径）** | AI 按教程输出 `<agent>{...}</agent>`，DOM 正则提取 |
| L3 | 自然语言 Intent | 兜底：把"打开 D:\a.py"映射到工具 |
| L4 | 教程式命令序列 | 最兜底：解析 `cd / git status / 查看文件` 步骤 |

第一阶段以 **L2 为主路径**，L3 作为可选兜底（`agent/intent/`）。

### 8.1 Agent Markup 规范（L2，冻结）

AI 在对话里输出：
```
<agent>
{"tool":"filesystem.search","arguments":{"root":"D:\\MediaForge","query":"tmdb"}}
</agent>
```
- 标签必须是小写 `<agent>` / `</agent>`。
- 标签内必须是合法 JSON，符合 `tool.call` 的 `payload`（`tool` + `arguments`）。
- Browser 用 MutationObserver 监听渲染层 assistant 消息节点，发现新增 `<agent>...</agent>` 块即提取、剥离 UI 显示（替换为一个"🔧 已请求工具: filesystem.search"的只读卡片），然后发出 `tool.call`。
- **防重复**：每个 agent 块按内容 hash 去重，只触发一次。

---

## 9. 任务上下文与工具动态暴露（不要一次给 AI 全部工具）

`session.hello.payload.taskContext` 决定暴露哪些工具域：

| taskContext | 暴露工具 |
|-------------|----------|
| `read-only` | filesystem.list / read / search, git.status / diff / log |
| `project`（默认） | read-only + filesystem.write / mkdir, shell.exec, git.commit |
| `full`（第一阶段不提供） | 上述 + docker/adb 等 |

Harness 在 `session.ready.availableTools` 里下发白名单；不在清单里的 `tool.call` 一律回 `UNKNOWN_TOOL`。

---

## 10. 工具目录与签名（第一阶段实现集）

> 跨平台；AI 看到的参数不区分 OS。shell 在 Windows 走 PowerShell，其他平台走 zsh/bash（Adapter）。

### 10.1 filesystem
| 工具 | 参数 | 权限 | 返回 `result` |
|------|------|------|--------------|
| `filesystem.list` | `{ path }` | READ | `{ entries: [{name, type:"dir"|"file", size, mtime}] }` |
| `filesystem.read` | `{ path, maxBytes? }` | READ | `{ content, meta:{size,mtime} }` |
| `filesystem.search` | `{ root, query, glob? }` | READ | `{ matches: [path...] }` |
| `filesystem.write` | `{ path, content, append? }` | WRITE | `{ written: bytes, dryRun }` |
| `filesystem.mkdir` | `{ path }` | WRITE | `{ created: true, dryRun }` |

> 第一阶段**不实现** delete/move（白皮书 §25 Phase 5 明确先不开放删除）。

### 10.2 shell
| 工具 | 参数 | 权限 | 返回 `result`（**必须结构化**） |
|------|------|------|-------------------------------|
| `shell.exec` | `{ command, timeoutMs?, cwd? }` | EXECUTE | `{ exitCode, stdout, stderr, durationMs, timedOut }` |

`shell.exec` 硬要求：
- `timeoutMs` 默认 30000，最大 120000。
- 超时 → `timedOut:true`、`exitCode:null`、杀掉子进程。
- 非零退出码 **不** 等同于协议错误：`status:"success"`，但 `exitCode != 0` 且 `stderr` 带内容，由 AI 自己判断。只有进程起不来 / 超时 / 权限才回 `status:"error"`。
- Windows 下用 `powershell.exe -NoProfile -Command <command>` 执行。

### 10.3 git
| 工具 | 参数 | 权限 | 返回 |
|------|------|------|------|
| `git.status` | `{ cwd }` | READ | `{ branch, clean, changes:[...] }` |
| `git.diff` | `{ cwd, staged? }` | READ | `{ patch }` |
| `git.log` | `{ cwd, max? }` | READ | `{ commits:[{hash,msg,author,time}] }` |
| `git.commit` | `{ cwd, message, addAll? }` | WRITE | `{ committed: true, hash, dryRun }` |

> 未安装 git → `TOOL_NOT_FOUND`。

---

## 11. 网页侧 `window.agent` API（preload 暴露，白名单）

preload 通过 `contextBridge` 只暴露：
```js
window.agent = {
  // 由 Browser 主进程注入：把工具结果渲染回聊天框
  onToolCall(cb),          // cb(toolCallPayload)  —— 页面检测到 agent 块时回调
  sendResult(toolResult),  // 主进程把 harness 结果送回页面时调用
  hello(),                 // 建立 session
  listTools()
}
```
**绝不**暴露 `require`、`process`、`child_process`、`fs`、`ipcRenderer.send` 原始通道（用白名单 `ipcRenderer.invoke('agent:tool', ...)` 包装）。

---

## 12. Web Adapter 接口（每个 Provider 一个）

`adapters/deepseek-web/` 实现统一接口：

| 方法 | 作用 |
|------|------|
| `detectMessage(nodes)` | 从页面 DOM 找出 assistant 消息节点 |
| `readAssistantMessage(node)` | 读助手最新文本（用于 L3 兜底） |
| `sendUserMessage(text)` | 向聊天框发一条消息（用于把工具结果喂回 AI） |
| `injectResult(toolCall, toolResult)` | 把工具结果作为一条"系统/用户"消息发回对话，触发 AI 继续 |
| `detectToolCall(node)` | 在 assistant 文本里找 `<agent>...</agent>` 块，返回解析后的 tool.call payload |

**DOM 选择器不写死进 Harness**——全部隔离在 adapter 里。DeepSeek 改版只改这一个文件。

---

## 13. 目录结构（冻结）

```
new-chat-1/
├── docs/PROTOCOL.md            # 本文件（唯一契约）
├── shared/protocol.js          # 纯 JS、无依赖：信封构造/校验/错误码/权限常量（双方共用，只读引用）
├── package.json                # Electron 入口 + 脚本
├── main.js                     # Electron 主进程入口
├── preload.js                  # 预加载脚本（contextBridge）
├── index.html                  # 浏览器外壳 UI（地址栏/标签/导航/确认弹窗/审计侧栏）
├── renderer.js                 # 外壳 UI 逻辑
│
├── electron/main/              # 窗口/标签/会话/安全
├── electron/ipc/               # IPC handler 白名单
├── browser/navigation/         # 前进后退刷新
├── browser/session/            # Cookie/session 持久化（partition）
├── browser/page/               # webContents 封装
├── agent/parser/               # <agent> 块解析、去重
├── agent/intent/               # L3 自然语言兜底
├── adapters/deepseek-web/      # DeepSeek DOM adapter
│
├── harness/
│   ├── server/                 # http + ws 服务器
│   ├── registry/               # 工具注册
│   ├── permissions/            # 权限引擎 + 确认队列
│   ├── audit/                  # JSONL 审计
│   ├── tools/filesystem/
│   ├── tools/shell/            # exec + hazard 黑名单
│   ├── tools/git/
│   ├── adapters/               # platform adapter（windows/darwin/linux）
│   └── data/                   # 运行时生成（audit 日志、token）
│
└── test/                       # 协议/工具单元测试（node --test）
```

---

## 14. 端到端闭环（第一阶段验收标准，对应白皮书 §33）

```
① 启动 AI Browser（自动拉起 Harness）
② 用户在地址栏打开 https://chat.deepseek.com/ 并登录（需用户本人操作）
③ 用户输入："查看 D:\MediaForge 的项目结构"
④ DeepSeek 输出 <agent>{"tool":"filesystem.list","arguments":{"path":"D:\\MediaForge"}} ...</agent>
⑤ adapter.detectToolCall 捕获 → agent/parser 解析去重
⑥ preload → IPC → WebSocket → Harness：tool.call
⑦ Harness：权限判定(READ=auto) → 执行 → 审计落盘
⑧ Harness 回 tool.result {entries:[...]}
⑨ Browser 把结果通过 adapter.injectResult 发回 DeepSeek 对话
⑩ DeepSeek 基于结果继续推理，再次产出 <agent>
⑪ 多轮后用户得到最终结论
```

跑通 ①→⑪ 即第一阶段成功。登录 DeepSeek 与人工确认弹窗必须由用户本人操作；其余（健康检查、工具清单、filesystem.read、shell.exec Dry Run、审计落盘）须可自动验证。
