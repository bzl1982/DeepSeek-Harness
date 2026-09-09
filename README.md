# DeepSeek Harness Desktop

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（官方 Web UI 版）封装为
**Windows / macOS 原生桌面应用**的单仓库工程。一套代码，双平台构建。

无需安装 Node.js、无需打开浏览器，**双击即用**：应用自带官方 Node.js 22 运行时与 dsh 完整依赖，
本地自动启停服务，数据仅存本机。

---

## 界面预览

**蓝色主题（默认 · 品牌蓝鲸）**

![蓝色主题主界面](docs/screenshots/01-home-blue.png)

**字体颜色设置（设置 → 通用设置 → 外观）**

![字体颜色设置](docs/screenshots/02-settings-fontcolor.png)

**黑色主题**

![黑色主题主界面](docs/screenshots/03-home-black.png)

> 主界面标题「探索未至之境」、徽章「预览版」、侧边栏鲸鱼 logo 会随
> 「字体颜色」选择在 **品牌蓝 `#4D6BFE`** 与 **黑色** 之间即时切换，下次启动保持。

---

## 快速上手

1. 下载对应平台安装包（见「构建产物」或 GitHub Releases）
2. Windows：双击 `setup-x64.exe` 安装，或运行 `portable-x64.exe` 便携版
   macOS：双击 dmg 将 App 拖入「应用程序」，首次打开右键 → 打开 → 仍要打开
3. 启动后约 20–30 秒加载完成（dsh 需加载 200+ 插件，期间为加载态，属正常）
4. 首次进入点击 **Continue**（官方 Internal Testing Notice）→ 选择**工作区** →
   选择 **Agent 预设**（默认「标准模式」）→ 输入指令 → 发送
5. 右上角**设置**可配置：模型 API、权限模式、语言、外观、**字体颜色**、字号、对话显示、Enter 键行为等

## 新功能：字体颜色（蓝色 / 黑色）

桌面版在「设置 → 通用设置 → 外观」新增 **字体颜色** 二选一：

| 选项 | 效果 |
|---|---|
| **蓝色字体**（默认） | 品牌蓝鲸主题：鲸鱼 logo、标题「探索未至之境」、「预览版」徽章为官方品牌蓝 `#4D6BFE`，与 DeepSeek 移动端一致 |
| **黑色字体** | 官方 Harness 原生黑鲸风格 |

- 选择**即时生效**并持久化记忆，下次启动保持
- 与「外观」的浅色 / 深色 / 跟随系统**互相独立**，可自由组合

## 仓库结构

```
dsh-desktop/
├── .gitignore                    # 排除构建产物与依赖（node_modules/dist/resources 等）
├── README.md                     # 本文件
├── .github/
│   └── workflows/
│       └── build-desktop.yml     # CI：Windows job + macOS job 自动产出安装包
└── desktop/                      # Electron 封装工程（双平台共用）
    ├── package.json              # 版本号 / 依赖 / 构建命令
    ├── electron-builder.yml      # 打包配置：win 段 + mac 段 + 通用段
    ├── src/
    │   └── main.js               # 主进程：拉起 dsh 本地服务 + 原生窗口（含平台分支）
    ├── build/
    │   └── icon.png              # 应用图标源文件（ico/icns 由脚本生成）
    ├── docs/screenshots/         # Release 使用截图
    └── scripts/
        ├── prepare-runtime.ps1   # Windows：装 dsh 依赖 + 下载 Node + 生成 icon.ico
        ├── patch-dsh-theme.js    # 幂等补丁：注入「字体颜色」设置 + 品牌蓝皮肤
        └── build-mac.sh          # macOS：装 dsh 依赖 + 下载 Node + 生成 icon.icns + 打包
```

> `resources/`（dsh-runtime、node-runtime）为构建时生成的中间产物，已 gitignore。

## 工作原理

桌面应用 = Electron 外壳 + 捆绑的 dsh 运行时：

1. 启动时用**捆绑的官方 Node.js** 运行 `dsh web --port 0`（随机空闲端口，避免冲突）
2. 解析服务输出的带 token 访问地址（如 `http://127.0.0.1:51771/?token=...`）
3. 在原生窗口（BrowserWindow）中加载该地址——**无需安装 Node，无需开浏览器**
4. 关闭窗口即退出，并完整清理服务进程树

```
DeepSeek Harness.app
 ├─ Electron 主进程 ── 启动时 spawn
 ├─ 捆绑 Node.js 22 (node-runtime)
 │    └─ 运行 dsh web --port 0（随机端口，带 token 鉴权）
 └─ BrowserWindow ── 加载 http://127.0.0.1:<port>/?token=...
```

## 平台差异（仅 4 处，其余 95% 共享）

| 差异点 | Windows | macOS |
|---|---|---|
| `main.js` 平台分支 | `node.exe` + `taskkill /T` | `node` + 进程组杀 |
| 打包目标 | NSIS 安装版 + 便携版（.exe） | dmg + zip |
| 构建脚本 | `prepare-runtime.ps1` | `build-mac.sh` |
| 图标 / Node 运行时 | icon.ico / win-x64 | icon.icns / darwin-arm64+x64 |

## 品牌定制（蓝鲸主题）

桌面版采用 DeepSeek 官方品牌视觉（与移动端 App 一致）：

- **应用图标**：官方 App 图标（白底蓝鲸），源文件 `desktop/build/icon.png`（1024×1024），
  Windows 的 `.ico` / macOS 的 `.icns` 由构建脚本自动生成
- **品牌蓝**：`#4D6BFE`（DeepSeek 官网 CSS 变量 `--ds-color-brand` 官方定义）
- **字体颜色二选一**：`scripts/patch-dsh-theme.js` 以幂等方式改写 dsh 前端
  `AppearanceRow` 组件，在设置面板原生渲染「字体颜色」（蓝色字体/黑色字体），
  持久化到 localStorage（`dsh-desktop-skin`），蓝色主题将鲸鱼 logo、
  首页标题「探索未至之境」、徽章「预览版」渲染为品牌蓝

> 说明：DeepSeek Harness 官方 UI 使用黑色鲸鱼标识（与模型产品线区隔）；
> 本桌面版按用户要求默认统一为 DeepSeek 主品牌蓝色鲸鱼，并可在设置中随时切回黑色。

## 构建产物

| 平台 | 产物 |
|---|---|
| Windows x64 | `DeepSeek Harness-0.1.2-setup-x64.exe`、`-portable-x64.exe` |
| macOS arm64 | `DeepSeek Harness-0.1.2-arm64.dmg`、`.zip` |
| macOS x64 | `DeepSeek Harness-0.1.2-x64.dmg`、`.zip` |

## 本机构建

前置：Node.js ≥ 22（dsh 依赖 Node 22+ 的 zstd / Promise.withResolvers API）。

**Windows：**
```powershell
cd desktop
npm install
npm run dist:win      # 自动：准备运行时 + electron-builder --win
```

**macOS：**
```bash
cd desktop
./scripts/build-mac.sh                     # arm64（Apple Silicon）
BUILD_ARCH="arm64 x64" ./scripts/build-mac.sh   # 双架构
# 系统 Node < 22 时: NODE22_BIN=/path/to/node22 ./scripts/build-mac.sh
```

> 构建脚本会自动执行 `patch-dsh-theme.js` 主题补丁（幂等，可重复运行），
> 并对 `resources/dsh-runtime/` 与 `_dev_runtime/` 各打一次。

## 一键构建（GitHub Actions）

推送本仓库到 GitHub 后，手动运行 **Build Desktop Apps** 工作流（或打 `v*` tag），
自动产出安装包：

- Windows job：`windows-latest` runner → NSIS 安装版 + 便携版（x64）
- macOS job：`macos-latest`（Intel）runner → x64 的 dmg/zip
- **arm64（Apple Silicon）包**：GitHub 免费托管暂无 arm64 公共 runner，
  请在 Apple Silicon 本机运行 `BUILD_ARCH="arm64 x64" ./scripts/build-mac.sh` 构建

## 版本升级

- dsh 版本：改 `scripts/prepare-runtime.ps1` 与 `scripts/build-mac.sh` 顶部的 `DSH_VERSION`
- Node 版本：改两脚本顶部 `NODE_VER`（需兼容 dsh 要求的 Node-API 版本）

## 已验证（2026-09-09 实测）

- **Windows 11**：安装版与便携版启动 → 捆绑 Node 运行 dsh 服务 → 窗口正常渲染；
  「字体颜色」蓝色/黑色切换均实测生效并持久化
- **macOS 26.6 (arm64)**：arm64 版实机验证（窗口加载页面完整渲染）；x64 版 Rosetta 下验证通过
- 双架构包内原生二进制与目标架构匹配（node / koffi / node-addon-require-builtin）

## 许可证

封装工程 MIT；DeepSeek Harness 本体 MIT（见官方仓库）。
