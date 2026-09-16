#!/usr/bin/env node
/**
 * 为 dsh-client-ui-theme 设置面板「外观」区追加「字体颜色」二选一（蓝色字体 / 黑色字体）。
 *
 * 直接修改 React 组件源码（AppearanceRow），选项作为原生渲染内容，
 * 不会被 React 重渲染清除。幂等：已打过补丁（含 [dsh-font-skin] 标志）则跳过。
 * 两个平台共用：macOS 由 build-mac.sh 调用，Windows 由 prepare-runtime.ps1 调用。
 *
 * 用法: node scripts/patch-dsh-theme.js <dsh-client-ui-theme/lib/client.js 路径>
 */
'use strict';

const fs = require('node:fs');

function patch(clientPath) {
  let src = fs.readFileSync(clientPath, 'utf8');

  if (src.includes('[dsh-font-skin]')) {
    console.log(`[patch-dsh-theme] 已打过字体补丁，跳过: ${clientPath}`);
    return true;
  }

  // 1) 引入 react（useState）
  const a1 = 'let react_jsx_runtime = require("react/jsx-runtime");';
  if (!src.includes(a1)) throw new Error('锚点1缺失');
  src = src.replace(a1, a1 + '\n\t\tlet react = require("react");');

  // 2) CSS modules 映射追加新类
  const a2 = '\t\t\t"cubeRow": "_8HJdBW_cubeRow",\n\t\t\t"group": "_8HJdBW_group",\n\t\t\t"selected": "_8HJdBW_selected",\n\t\t\t"themeCube": "_8HJdBW_themeCube",\n\t\t\t"title": "_8HJdBW_title"';
  if (!src.includes(a2)) throw new Error('锚点2缺失');
  src = src.replace(
    a2,
    a2 + ',\n\t\t\t"fontRow": "_8HJdBW_fontRow",\n\t\t\t"fontTitle": "_8HJdBW_fontTitle",\n\t\t\t"fontBtns": "_8HJdBW_fontBtns",\n\t\t\t"fontBtn": "_8HJdBW_fontBtn",\n\t\t\t"fontSelected": "_8HJdBW_fontSelected"'
  );

  // 3) CSS 文本追加字体颜色行样式
  const a3 = '._8HJdBW_selected{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400)}"';
  if (!src.includes(a3)) throw new Error('锚点3缺失');
  const extra =
    '._8HJdBW_fontRow{border-bottom:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding:16px 0;display:flex}' +
    '._8HJdBW_fontTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}' +
    '._8HJdBW_fontBtns{flex-wrap:wrap;gap:8px;display:flex}' +
    '._8HJdBW_fontBtn{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border-radius:20px;justify-content:center;align-items:center;gap:4px;padding:8px 24px;font-size:14px;line-height:22px;display:flex}' +
    '._8HJdBW_fontBtn:hover:not(._8HJdBW_fontSelected){background:var(--dsw-alias-interactive-bg-hover)}' +
    '._8HJdBW_fontSelected{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400)}';
  src = src.replace(a3, a3.slice(0, -1) + extra + '"');

  // 4) AppearanceRow：helpers + useState
  const a4 = '\t\tfunction AppearanceRow({ t, setTheme, useStore }) {\n\t\t\tconst preference = useStore((s) => s.preference);';
  if (!src.includes(a4)) throw new Error('锚点4缺失');
  const helpers =
    '\t\t/** [dsh-font-skin] 桌面版「字体颜色」偏好（蓝色字体 = 品牌蓝鲸主题，黑色字体 = 官方原生）。 */\n' +
    '\t\tfunction getFontSkin() {\n' +
    '\t\t\ttry { return localStorage.getItem("dsh-desktop-skin") || "blue"; } catch (e) { return "blue"; }\n' +
    '\t\t}\n' +
    '\t\tfunction setFontSkin(id) {\n' +
    '\t\t\ttry { localStorage.setItem("dsh-desktop-skin", id); } catch (e) {}\n' +
    '\t\t\tif (id === "blue") { document.documentElement.setAttribute("data-ds-skin", "blue"); }\n' +
    '\t\t\telse { document.documentElement.removeAttribute("data-ds-skin"); }\n' +
    '\t\t}\n' +
    '\t\tconst FONT_OPTIONS = [\n' +
    '\t\t\t{ id: "blue", label: "蓝色字体" },\n' +
    '\t\t\t{ id: "black", label: "黑色字体" }\n' +
    '\t\t];\n' +
    '\t\tfunction AppearanceRow({ t, setTheme, useStore }) {\n' +
    '\t\t\tconst preference = useStore((s) => s.preference);\n' +
    '\t\t\tconst [fontSkin, setFontSkinState] = react.useState(getFontSkin);';
  src = src.replace(a4, helpers);

  // 5) cubeRow 之后追加字体颜色行
  const a5 =
    '\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(Icon, {}), t(labelKey)]\n' +
    '\t\t\t\t\t}, id))\n' +
    '\t\t\t\t})]\n' +
    '\t\t\t});\n' +
    '\t\t}';
  if (!src.includes(a5)) throw new Error('锚点5缺失');
  const fontrow =
    '\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(Icon, {}), t(labelKey)]\n' +
    '\t\t\t\t\t}, id))\n' +
    '\t\t\t\t}), (0, react_jsx_runtime.jsxs)("div", {\n' +
    '\t\t\t\t\tclassName: AppearanceRow_module_css_default.fontRow,\n' +
    '\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("div", {\n' +
    '\t\t\t\t\t\tclassName: AppearanceRow_module_css_default.fontTitle,\n' +
    '\t\t\t\t\t\tchildren: "字体颜色"\n' +
    '\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("div", {\n' +
    '\t\t\t\t\t\tclassName: AppearanceRow_module_css_default.fontBtns,\n' +
    '\t\t\t\t\t\tchildren: FONT_OPTIONS.map(({ id, label }) => (0, react_jsx_runtime.jsxs)("button", {\n' +
    '\t\t\t\t\t\t\ttype: "button",\n' +
    '\t\t\t\t\t\t\tclassName: clsx(AppearanceRow_module_css_default.fontBtn, fontSkin === id && AppearanceRow_module_css_default.fontSelected),\n' +
    '\t\t\t\t\t\t\t"aria-pressed": fontSkin === id,\n' +
    '\t\t\t\t\t\t\tonClick: () => {\n' +
    '\t\t\t\t\t\t\t\tsetFontSkin(id);\n' +
    '\t\t\t\t\t\t\t\tsetFontSkinState(id);\n' +
    '\t\t\t\t\t\t\t},\n' +
    '\t\t\t\t\t\t\tchildren: [label]\n' +
    '\t\t\t\t\t\t}, id))\n' +
    '\t\t\t\t\t})]\n' +
    '\t\t\t\t})]\n' +
    '\t\t\t});\n' +
    '\t\t}';
  src = src.replace(a5, fontrow);

  fs.writeFileSync(clientPath, src, 'utf8');
  console.log(`[patch-dsh-theme] 补丁已写入: ${clientPath}`);
  return true;
}

if (process.argv.length !== 3) {
  console.error('用法: node patch-dsh-theme.js <client.js 路径>');
  process.exit(1);
}
try {
  patch(process.argv[2]);
} catch (e) {
  console.error(`[patch-dsh-theme] 失败: ${e.message}`);
  process.exit(1);
}
