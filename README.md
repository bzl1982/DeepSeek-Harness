# DeepSeek Harness Desktop

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（官方 Web UI 版）封装为
**Windows / macOS 原生桌面应用**的单仓库工程。一套代码，双平台构建。

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
        └── build-mac.sh          # macOS：装 dsh 依赖 + 下载 Node + 生成 icon.icns + 打包
```

> `resources/`（dsh-runtime、node-runtime）为构建时生成的中间产物，已 gitignore。

## 工作原理

桌面应用 = Electron 外壳 + 捆绑的 dsh 运行时：

1. 启动时用**捆绑的官方 Node.js** 运行 `dsh web --port 0`（随机空闲端口，避免冲突）
2. 解析服务输出的带 token 访问地址（如 `http://127.0.0.1:51771/?token=...`）
3. 在原生窗口（BrowserWindow）中加载该地址——**无需安装 Node，无需开浏览器**
4. 关闭窗口即退出，并完整清理服务进程树

## 平台差异（仅 4 处，其余 95% 共享）

| 差异点 | Windows | macOS |
|---|---|---|
| `main.js` 平台分支 | `node.exe` + `taskkill /T` | `node` + 进程组杀 |
| 打包目标 | NSIS 安装版 + 便携版（.exe） | dmg + zip |
| 构建脚本 | `prepare-runtime.ps1` | `build-mac.sh` |
| 图标 / Node 运行时 | icon.ico / win-x64 | icon.icns / darwin-arm64+x64 |

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

- **Windows 11**：安装版与便携版启动 → 捆绑 Node 运行 dsh 服务 → 窗口正常渲染
- **macOS 26.6 (arm64)**：arm64 版实机验证（窗口加载页面完整渲染）；x64 版 Rosetta 下验证通过
- 双架构包内原生二进制与目标架构匹配（node / koffi / node-addon-require-builtin）

## 许可证

封装工程 MIT；DeepSeek Harness 本体 MIT（见官方仓库）。
