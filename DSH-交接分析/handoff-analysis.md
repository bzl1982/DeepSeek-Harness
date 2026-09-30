# DSH 桌面端 · 交接分析（接手首日核实）

> 接手日期：2026-09-22
> 分析人：新任 technical lead（AI）
> 项目根目录：`D:\DeepSeek Harness`
> 自定义源码位置：`desktop/src/`（主进程 + 注入脚本）、`desktop/agent/`（通辽会议窗口 + 智能体运行时）

---

## 一、接手确认与代码地图

Electron 主工程在 `desktop/`，自定义逻辑集中在：

| 文件 | 职责 |
|---|---|
| `desktop/src/main.js` | Electron 主进程。① 拉起 dsh 本地服务 ② 主窗口 `dom-ready` 注入三套脚本：`SKIN_JS`（品牌蓝皮肤）、`MEET_BTN_JS`（通辽会议按钮）、`MODEL_UI_JS`（模型 UI，**当前是调试 dumper**）③ 创建通辽会议窗口 + 独立登录浏览器窗口 |
| `desktop/src/agentCatalog.js` | **网页版智能体唯一配置源**：9 个 provider（命名/URL/partition/登录检测），三处界面共用 |
| `desktop/src/preload.js` | 主窗口 `window.dshAgent` 桥（供 dsh Web UI 的模型选择器/设置页通信） |
| `desktop/agent/meeting.html` | 通辽会议窗口 UI：按 catalog 创建 9 个 `<webview partition="persist:agent-${m.id}">` |
| `desktop/agent/meeting-preload.js` | 会议窗口 `window.meetingBridge` 桥 |
| `desktop/agent/main.js` | `createAgentRuntime`（智能体"大脑"，常驻 127.0.0.1:17321） |

`desktop/src/main.js.bak-current` 是上一版备份，用于对照。

---

## 二、对照交接报告的现状核实

### ✅ 已确认完成（与报告一致）

1. **Webview partition 统一（报告待办 1）**
   - 通辽会议窗口 `meeting.html:179` → `wv.setAttribute('partition', 'persist:agent-' + m.id)`
   - 独立登录浏览器窗口 `main.js` `meeting:openBrowser` → `partition: 'persist:agent-' + providerId`
   - 两者都从 `AGENT_CATALOG` 遍历，**9 个 provider（含新增「谷歌-搜索」「百度-文心」）分区自动正确传入**。✅

2. **预设 provider 补齐 9 个（报告待办 2）**
   - `agentCatalog.js` 已是 9 个：`deepseek-web / chatgpt-web / kimi-web / doubao-web / tongyi-web / yuanbao-web / gemini-web / google-search / wenxin-web`。✅

### ⚠️ 关键发现：模型 UI 注入已被清空

- 当前 `src/main.js` 的 `MODEL_UI_JS`（dom-ready 第三处注入）**只做 DOM dump 调试**，把模型面板结构写到 `%TEMP%/dsh-model-ui-dump.json`，**没有任何排序/显隐/子菜单逻辑**。
- `main.js.bak-current` 里同一处是空壳 `(function(){})();`。
- 结论：**报告里的「待办 3/4/5」以及「设置页打开并登录」按钮，在当前代码里并未实现**，是要按报告的"正确姿势"重新写，而不是修一个还在跑的 bug。
- 这同时解释了报告 Bug1（API 模型被隐藏）：那是在 V10/V11 注入还活跃时的症状；现在注入清空后，主页模型弹窗是原生 dsh UI，**Bug1 本身在当前代码已不再复现**，但它是一条"重新实现时千万别再引入"的红线。

### ❌ 真正的缺口：设置页「打开并登录」webview 不存在

- 全仓（`desktop/src`、`desktop/agent`）搜索「打开并登录」**无命中**（仅 `main.js` 注释里提到）。
- 即：设置页里给每个网页智能体提供"打开并登录"入口、并复用 `persist:agent-{providerId}` 分区的功能**尚未写**。这是 Bug3「待验证」两新增 provider partition 是否正确的真正意义所在——会议/登录窗口路径已对，设置页路径缺失。

---

## 三、四项待办逐项方案

### 待办 6 · 通辽会议按钮选择器（Bug6）—— 已修复 ✅（待 GUI 验证）

**根因**：旧 `MEET_BTN_JS` 第一段选择器优先侧边栏，但 fallback `button[aria-label*="设置"]` 会命中右上角头部齿轮（其 aria-label 也含"设置"），随后 `parent.insertBefore` 把克隆按钮插进头部，跑到右上角。

**修复**（`src/main.js`）：新增 `findSidebarSettingsBtn()`——
1. 优先在 `[class*="sidebar"] / nav / aside` 容器内找设置按钮；
2. 兜底时收集所有「设置」按钮，**沿祖先链排除 `header/topbar/navbar/titlebar`**，取 `getBoundingClientRect().top` 最大的（最靠下的）那个。
这样稳定命中侧边栏底部设置按钮，永远不会落到右上角齿轮。

**验证方式**：GUI 启动后观察通辽会议按钮是否贴在左下角设置按钮下方，不再出现在右上角。

### 待办 3+4+5 · 模型 UI（排序 / API 可见 / hover 子菜单）—— 待运行时 DOM

这三项是"重新实现"，且都强依赖 **dsh Web UI 的真实 DOM 结构**（CSS Modules 哈希类名，如 `[class*="sidebar"]`、`[class*="setting"]`）。当前环境**无法运行 Electron GUI**（无显示器、Bash 工具链 PATH 缺失、`_dev_runtime` 不在），**我无法亲自抓到这些锚点**，所以不能盲写选择器——这正是报告反复警告的"误伤主页弹窗"雷区。

**已定方案（写代码前必须对齐的硬约束，来自报告 §四/§五）：**
- **页面路由判断**：DOM 排序/显隐脚本第一句必须是 `if (!document.querySelector('[text*="打开并登录"]')) return;`（报告原文），只在设置页执行，主页弹窗 DOM 一律不碰。
- **API 模型可见**：严禁任何全局 `max-height` / `overflow:scroll` / `display:none` 作用在模型弹窗；子菜单用 `position:absolute` 悬浮，**不移动原始 DOM 节点顺序**。
- **hover 飞出子菜单**：主列表只展示供应商/分组名，鼠标悬浮右侧弹出该供应商全部模型；**禁止滚动条、禁止点击折叠**（用户明确拒绝 V8 滚动、V9 折叠）。
- **CSS 污染清除**：重新实现前，主窗口必须 `webContents.reloadIgnoringCache()` 一次，确保没有任何历史注入样式残留。

**拿锚点的路径**（二选一，需用户在能跑 GUI 的机器上做）：
- 方案 A：当前 `MODEL_UI_JS` 的 dumper 已就绪，启动后把 `%TEMP%/dsh-model-ui-dump.json` 贴给我；
- 方案 B：截图主页模型弹窗 + 设置页模型列表，我据此定锚点。

锚点到手后，我会把方案落成具体注入代码，并自带页面路由守卫，绝不动主页弹窗。

### 待办 3（Bug3 缺口）· 设置页「打开并登录」webview

需在设置页模型列表里，给每个网页智能体注入一个"打开并登录"入口，点击后打开 `persist:agent-{providerId}` 分区的浏览器窗口（复用 `meeting:openBrowser` IPC 即可，分区逻辑已对）。同样依赖设置页 DOM 锚点，与上面一并处理。

---

## 四、环境限制（务必知悉）

- 本机 Bash 工具链 PATH 缺失（`ls`/`dirname` 等基本命令跑不起来），但我专用文件检索工具（Grep/Glob/Read）正常，代码勘察不受影响。
- 当前环境**无法启动 Electron GUI**（无显示、`_dev_runtime` 不在），因此不能由我亲自复现 Bug 或验证 UI 修复。所有 UI 改动的最终验证需要你在 Windows 上构建/启动一次。
- 代码改动均已落在 `desktop/src/main.js`，未触碰 dsh 运行时与 `node_modules`。

---

## 五、下一步动作建议

1. **你这边（能跑 GUI 的机器）**：启动 DSH，确认 ① 通辽会议按钮已正确落在左下角；② 把 `%TEMP%/dsh-model-ui-dump.json` 或主页/设置页截图发我。
2. **我这边**：拿到 DOM 锚点后，重写 `MODEL_UI_JS`（设置页排序 + 主页 API 可见 + hover 飞出子菜单 + 设置页打开并登录入口），严格带页面路由守卫，不碰主页弹窗 DOM。
3. 全部改完后，按你的惯例：部署 → 推 GitHub → 更新记忆 → 报告进度。

> 备注：本次仅动了 `src/main.js` 的 Bug6 选择器，其余为分析+规划，未引入任何可能"误伤"的注入。
