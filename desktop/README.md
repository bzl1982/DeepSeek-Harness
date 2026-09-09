# DeepSeek Harness Desktop（macOS 版）

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（官方 Web UI 版）封装为 macOS 原生桌面应用。

## 工作原理

桌面应用 = Electron 外壳 + 捆绑的 dsh 运行时：

1. 启动时用**捆绑的官方 Node.js** 运行 `dsh web --port 0`（随机空闲端口，避免冲突）
2. 解析服务输出的带 token 访问地址（如 `http://127.0.0.1:51771/?token=...`）
3. 在原生窗口（BrowserWindow）中加载该地址——**无需安装 Node，无需开浏览器**
4. 关闭窗口即退出，并完整清理服务进程树

应用内首次使用时按界面引导配置模型 API（与官方 Web 版完全一致，数据只存本地）。

## 本机构建（macOS）

前置：Node.js ≥ 22（dsh 依赖 Node 22+ 的 zstd 与 `Promise.withResolvers` API）。

```bash
cd desktop
chmod +x scripts/build-mac.sh
./scripts/build-mac.sh                     # 构建 arm64（Apple Silicon）
BUILD_ARCH="arm64 x64" ./scripts/build-mac.sh   # 同时构建双架构
# 若系统 Node < 22: NODE22_BIN=/path/to/node22 ./scripts/build-mac.sh
```

产物在 `desktop/dist/`：
- `DeepSeek Harness-0.1.2-arm64.dmg` / `.zip`（Apple Silicon）
- `DeepSeek Harness-0.1.2-x64.dmg` / `.zip`（Intel，可选）

### 说明

- 产物**未签名、未公证**。首次打开时如被 Gatekeeper 拦截，请「右键 → 打开」，或在
  「系统设置 → 隐私与安全性」中允许。正式分发建议申请 Apple Developer 证书后签名。
- 构建脚本自动处理：dsh 生产依赖安装（Node 22）、双架构官方 Node 运行时下载与捆绑、
  icns 图标生成、electron-builder 打包。
- 版本升级：改脚本顶部 `DSH_VERSION`（dsh）与 `NODE_VER`（Node）即可。

## 一键构建（GitHub Actions）

本工程已带 `desktop/.github/workflows/build-desktop.yml`：推到 GitHub 后手动运行该工作流
或打 `v*` tag，即自动在 macOS 上产出 arm64 + x64 的全部安装包。

## 开发调试

```bash
cd desktop
npm start   # 开发模式：需本机 Node ≥ 22，且先在 ../app 安装 dsh（npm i @deepseek-ai/dsh）
```

## 已验证（2026-09-09，macOS 26.6 arm64 实测）

- dsh 0.1.2-rc.1 在 Node 22 下完整启动（Node 20 会因缺少 zstd / Promise.withResolvers 失败）
- **arm64 版**：打包后启动 → 捆绑 Node 运行 dsh 服务（随机端口监听、HTTP 响应正常）→
  窗口加载本地服务地址，Web UI 页面完整渲染（官方 Internal Testing Notice 首屏可见）
- **x64 版**：在 Rosetta 下同流程验证通过（等价 Intel Mac 运行环境）
- 双架构包内原生二进制与目标架构匹配（node / koffi / node-addon-require-builtin 均为对应平台版本）

## 许可证

封装工程 MIT；DeepSeek Harness 本体 MIT（见官方仓库）。
