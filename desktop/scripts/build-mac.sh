#!/usr/bin/env bash
# build-mac.sh — 在 macOS 上构建 DeepSeek Harness 桌面版（逐架构独立打包）
#
# 前置条件:
#   - Node.js >= 22 可用（dsh 依赖 Node 22+ 的 zstd / Promise.withResolvers）。
#     若系统 node < 22，可设置 NODE22_BIN 指向 Node 22 的二进制，脚本会自动使用。
#   - 构建 x64 需要 Rosetta（Apple Silicon 上）；arm64 无需。
#   - 产物未签名；首次打开请右键 -> 打开，或在「系统设置 -> 隐私与安全性」中允许。
#
# 用法:
#   ./scripts/build-mac.sh                # 构建 arm64（Apple Silicon）
#   BUILD_ARCH="arm64 x64" ./scripts/build-mac.sh   # 同时构建双架构
#   NODE22_BIN=/path/to/node ./scripts/build-mac.sh # 指定 Node 22 二进制
#
# 说明:
#   - 每个架构独立安装 dsh 生产依赖，确保原生模块（koffi、node-addon-require-builtin、
#     node-pty 等）与目标架构匹配：arm64 原生安装；x64 在 Rosetta 下用 x64 Node 安装。
#   - 每个架构捆绑对应平台的官方 Node.js。
#
# 产物: dist/DeepSeek Harness-<version>-<arch>.dmg / .zip

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RES="$ROOT/resources"
CACHE="${NODE_CACHE_DIR:-$ROOT/../.build-cache}"
DSH_VERSION="${DSH_VERSION:-0.1.5-rc.2}"
NODE_VER="${NODE_VER:-v22.23.2}"
BUILD_ARCH="${BUILD_ARCH:-arm64}"

# ---------- 1. 解析 Node 22 ----------
echo "[1/6] 检查 Node 22 环境 ..."
NODE_BIN="${NODE22_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
    NODE_BIN="$(command -v node)"
  elif [ -x "$CACHE/node-${NODE_VER}-darwin-arm64/bin/node" ]; then
    NODE_BIN="$CACHE/node-${NODE_VER}-darwin-arm64/bin/node"
  else
    echo "错误: 需要 Node.js >= 22（dsh 依赖 Node 22+ API）。" >&2
    echo "  方式一: 安装 Node 22 后重试；" >&2
    echo "  方式二: NODE22_BIN=/path/to/node ./scripts/build-mac.sh" >&2
    exit 1
  fi
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "错误: NODE22_BIN 指向 Node $NODE_MAJOR，需要 >= 22" >&2; exit 1; }
NPM_BIN="$(dirname "$NODE_BIN")/npm"
echo "使用 Node: $NODE_BIN ($("$NODE_BIN" -v))"
export PATH="$(dirname "$NODE_BIN"):$PATH"

# ---------- 2. 下载各架构官方 Node 运行时 ----------
echo "[2/6] 准备官方 Node.js 运行时 (${NODE_VER}) ..."
mkdir -p "$CACHE" "$RES"
for arch in $BUILD_ARCH; do
  PLATFORM="darwin-${arch}"
  EXTRACT="$CACHE/node-${NODE_VER}-${PLATFORM}"
  if [ ! -x "$EXTRACT/bin/node" ]; then
    URL="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-${PLATFORM}.tar.gz"
    TGZ="$CACHE/node-${NODE_VER}-${PLATFORM}.tar.gz"
    echo "下载 $URL ..."
    [ -f "$TGZ" ] || curl -sL -o "$TGZ" "$URL"
    tar -xzf "$TGZ" -C "$CACHE"
    chmod +x "$EXTRACT/bin/node"
  fi
done

# ---------- 3. 生成 icon.icns ----------
echo "[3/6] 生成 icon.icns ..."
ICONSET="$RES/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for SIZE in 16 32 128 256 512; do
  sips -z $SIZE $SIZE "$ROOT/build/icon.png" --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
  D=$((SIZE * 2))
  sips -z $D $D "$ROOT/build/icon.png" --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$ROOT/build/icon.icns"
rm -rf "$ICONSET"

# ---------- 4. 安装构建依赖 ----------
echo "[4/6] 安装 electron-builder 构建依赖 ..."
cd "$ROOT"
"$NODE_BIN" "$NPM_BIN" install --no-audit --no-fund

# ---------- 5-6. 逐架构：装 dsh 依赖 -> 捆绑 node -> 打包 ----------
echo "[5/6] 逐架构构建 (arch: ${BUILD_ARCH}) ..."
for arch in $BUILD_ARCH; do
  echo ""
  echo "======== 构建 ${arch} ========"
  PLATFORM="darwin-${arch}"
  ARCH_NODE="$CACHE/node-${NODE_VER}-${PLATFORM}/bin/node"
  ARCH_NPM="$(dirname "$ARCH_NODE")/npm"

  # 5a. 该架构独立的 dsh 生产依赖
  echo "[${arch}] 安装 dsh 生产依赖 (v${DSH_VERSION}) ..."
  STAGING="$(mktemp -d)/dsh-runtime-${arch}"
  mkdir -p "$STAGING"
  (
    cd "$STAGING"
    npm init -y >/dev/null
    if [ "$arch" = "x64" ]; then
      # Rosetta + x64 Node：PATH 前置 x64 node 目录，确保 postinstall 里的 node 也是 x64
      arch -x86_64 env PATH="$(dirname "$ARCH_NODE"):$PATH" "$ARCH_NODE" "$ARCH_NPM" install "@deepseek-ai/dsh@${DSH_VERSION}" --omit=dev --no-audit --no-fund
    else
      "$ARCH_NODE" "$ARCH_NPM" install "@deepseek-ai/dsh@${DSH_VERSION}" --omit=dev --no-audit --no-fund
    fi
  )
  test -f "$STAGING/node_modules/@deepseek-ai/dsh/lib/bin.js" || { echo "错误: ${arch} dsh 安装不完整" >&2; exit 1; }
  rm -rf "$RES/dsh-runtime"
  cp -R "$STAGING" "$RES/dsh-runtime"
  rm -rf "$(dirname "$STAGING")"

  # 5a2. 应用蓝鲸主题补丁（「字体颜色」二选一选项原生渲染进设置面板，
  #       由 scripts/patch-dsh-theme.js 幂等写入 dsh-client-ui-theme）
  echo "[${arch}] 应用蓝鲸主题补丁 ..."
  "$NODE_BIN" "$ROOT/scripts/patch-dsh-theme.js" "$RES/dsh-runtime/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js"
  "$NODE_BIN" "$ROOT/scripts/patch-dsh-cost.js" "$RES/dsh-runtime/node_modules"

  # 5b. 该架构的官方 Node 运行时
  rm -rf "$RES/node-runtime"
  mkdir -p "$RES/node-runtime"
  cp "$ARCH_NODE" "$RES/node-runtime/node"
  cp "$CACHE/node-${NODE_VER}-${PLATFORM}/LICENSE" "$RES/node-runtime/LICENSE"

  # 5c. electron-builder 打包（CLI 指定架构）
  echo "[${arch}] electron-builder --mac --${arch} ..."
  if [ "$arch" = "x64" ]; then
    arch -x86_64 env PATH="$(dirname "$ARCH_NODE"):$PATH" npx electron-builder --mac --x64
  else
    npx electron-builder --mac --arm64
  fi
done

echo ""
echo "完成。产物位于 $ROOT/dist/"
ls -lh "$ROOT"/dist/*.dmg "$ROOT"/dist/*.zip 2>/dev/null || true
