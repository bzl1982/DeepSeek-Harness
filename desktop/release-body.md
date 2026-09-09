# DeepSeek Harness 桌面版 0.1.2

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（官方 Web UI 版）封装为
**Windows / macOS 原生桌面应用**：无需安装 Node.js、无需打开浏览器，双击即用。

![蓝色主题主界面](https://raw.githubusercontent.com/bzl1982/DeepSeek-Harness/main/desktop/docs/screenshots/01-home-blue.png)

> 内置捆绑 Node.js 22 运行时 + 官方 dsh 0.1.2-rc.1 完整依赖；本地服务自动启停，数据仅存本机。

---

## 📥 下载

| 平台 | 架构 | 文件 | 说明 |
|---|---|---|---|
| Windows | x64 | `DeepSeek-Harness-0.1.2-setup-x64.exe` | 安装版（NSIS，可选安装目录/快捷方式） |
| Windows | x64 | `DeepSeek-Harness-0.1.2-portable-x64.exe` | 便携版（解压即用，免安装） |
| macOS | Apple Silicon (arm64) | `DeepSeek-Harness-0.1.2-arm64.dmg` | 双击拖入「应用程序」 |
| macOS | Apple Silicon (arm64) | `DeepSeek-Harness-0.1.2-arm64.zip` | 备用分发格式 |
| macOS | Intel (x64) | `DeepSeek-Harness-0.1.2-x64.dmg` | 双击拖入「应用程序」 |
| macOS | Intel (x64) | `DeepSeek-Harness-0.1.2-x64.zip` | 备用分发格式 |

## 🚀 安装与首次打开

**Windows**
- 安装版：双击 `setup-x64.exe` → 按向导完成安装 → 桌面/开始菜单启动
- 便携版：双击 `portable-x64.exe` → 解压到任意目录 → 运行 `DeepSeek Harness.exe`

**macOS**（未签名版本，首次打开需放行一次）
1. 打开 dmg，将 `DeepSeek Harness.app` 拖入「应用程序」
2. 首次打开被拦截时：**右键 App → 打开 → 再次点击「打开」**；或「系统设置 → 隐私与安全性 → 仍要打开」
3. 仅首次需要放行，之后正常双击启动

## 🧭 使用说明

1. 启动后应用自动在本地启动服务（随机空闲端口，避免冲突），并打开原生窗口
2. 首次进入可见官方「Internal Testing Notice」开发者测试公告，点击 **Continue** 进入主界面
3. 主界面按官方 Web UI 使用：选择**工作区** → 选择 **Agent 预设**（默认「标准模式」）→ 输入指令 → 发送
4. 左侧会话列表可管理历史会话；右上角「设置」可配置模型 API 等
5. 关闭窗口即退出应用，服务进程自动完整清理，不残留后台进程

## 🎨 字体颜色（新功能：蓝色 / 黑色二选一）

桌面版在「**设置 → 通用设置 → 外观**」新增 **字体颜色** 二选一，即时生效、下次启动保持：

| 选项 | 效果 |
|---|---|
| **蓝色字体**（默认） | 品牌蓝鲸主题：鲸鱼 logo、首页标题「探索未至之境」、「预览版」徽章为官方品牌蓝 `#4D6BFE`，与 DeepSeek 移动端一致 |
| **黑色字体** | 官方 Harness 原生黑鲸风格 |

**蓝色主题（默认）**

![蓝色主题主界面](https://raw.githubusercontent.com/bzl1982/DeepSeek-Harness/main/desktop/docs/screenshots/01-home-blue.png)

**设置面板 · 字体颜色选项**

![字体颜色设置](https://raw.githubusercontent.com/bzl1982/DeepSeek-Harness/main/desktop/docs/screenshots/02-settings-fontcolor.png)

**黑色主题**

![黑色主题主界面](https://raw.githubusercontent.com/bzl1982/DeepSeek-Harness/main/desktop/docs/screenshots/03-home-black.png)

> 与「外观」的浅色 / 深色 / 跟随系统互相独立，可自由组合。

## 🐋 DeepSeek 品牌蓝鲸主题

- 应用图标为 DeepSeek 官方**蓝鲸图标**（与移动端一致）
- 默认**蓝色字体**主题：侧边栏鲸鱼 logo、首页标题「探索未至之境」、徽章「预览版」为官方品牌蓝 `#4D6BFE`
- 选择即时生效并记忆，下次启动保持

## ⚙️ 工作原理

```
DeepSeek Harness.app
 ├─ Electron 主进程 ── 启动时 spawn
 ├─ 捆绑 Node.js 22 (node-runtime)
 │    └─ 运行 dsh web --port 0（随机端口，带 token 鉴权）
 └─ BrowserWindow ── 加载 http://127.0.0.1:<port>/?token=...
```

- dsh 服务启动约 20–30 秒（加载 200+ 插件），期间窗口为加载态，属正常
- 服务仅监听 `127.0.0.1`，带 40 位随机 token 鉴权（HTTP 401 拦截无 token 访问）

## 📦 本次验证（2026-09-09）

- Windows 11：安装版与便携版均实测启动、服务拉起、页面渲染正常；「字体颜色」蓝色/黑色切换均实测生效并持久化
- macOS (Apple Silicon)：arm64 版实机验证通过；Intel (x64) 版由 GitHub Actions 构建并核验架构
- 包内原生二进制与目标架构匹配（Node / koffi / node-addon-require-builtin）

## 🧑‍💻 从源码构建

仓库已开源，含完整构建脚本与 GitHub Actions 工作流：

```bash
git clone https://github.com/bzl1982/DeepSeek-Harness.git
cd DeepSeek-Harness/desktop
# Windows（需 Node >= 22）
npm install && npm run dist:win
# macOS：./scripts/build-mac.sh（arm64） / BUILD_ARCH="arm64 x64" ./scripts/build-mac.sh（双架构）
```

## ⚠️ 已知限制

- 未签名、未公证（个人开发者分发限制）；正式分发需 Apple Developer 证书签名
- dsh 0.1.x 为开发者预览版，官方提示存在破坏性变更，升级请留意官方 Release
- macOS arm64 包在本机构建并上传；x64 包由 GitHub Actions（Intel runner）构建并上传，两架构均已核验

## 🔗 相关链接

- 上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 本仓库：[bzl1982/DeepSeek-Harness](https://github.com/bzl1982/DeepSeek-Harness)
