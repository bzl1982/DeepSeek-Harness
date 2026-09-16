#!/usr/bin/env node
/**
 * 在设置面板左侧导航「Agent 预设」之后新增一个独立页签「关于本软件」，
 * 显示桌面版版本号、所打包的官方 dsh 内核版本、以及桌面版相对官方的改动清单。
 *
 * 通过 settings-general 模块的 slots.inject("settings.section", ...) 注册新 section，
 * 与官方各 tab（general / models / plugins / agent-presets）同一机制。
 * 幂等：已打过 [dsh-about-tab] 标记则跳过。
 *
 * 用法: node scripts/patch-dsh-about.js <dsh-client-ui-settings-general/lib/client.js 路径>
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APP_VERSION = '0.1.5-rc.2';

function patch(clientPath) {
  let src = fs.readFileSync(clientPath, 'utf8');

  if (src.includes('[dsh-about-tab]')) {
    console.log(`[patch-dsh-about] 已打过补丁，跳过: ${clientPath}`);
    return true;
  }

  // 读官方 dsh 内核版本
  let officialVersion = '0.1.5-rc.2';
  try {
    const dshPkg = path.join(clientPath, '..', '..', '..', '..', '@deepseek-ai', 'dsh', 'package.json');
    officialVersion = JSON.parse(fs.readFileSync(dshPkg, 'utf8')).version || officialVersion;
  } catch (e) { /* 用默认 */ }

  const lines = [
    '桌面版 v' + APP_VERSION + '（打包自官方 deepseek-ai/dsh v' + officialVersion + '）',
    '',
    '本版本相对官方 dsh 的改动：',
    '· 将官方 Web UI 封装为 Windows / macOS 原生桌面应用（Electron 壳 + 捆绑 Node）',
    '· 品牌蓝鲸主题 #4D6BFE，与移动端 App 图标鲸鱼同色',
    '· 设置 → 外观：字体颜色「蓝色 / 黑色」二选一',
    '· 模型显示名修正为 DeepSeek-V4.1-Flash',
    '· 会话结束显示模型 / 工具 / Token / 缓存命中 / 费用结算卡',
    '',
    '仓库: github.com/bzl1982/DeepSeek-Harness',
  ];

  // 锚点：general section 注册块结尾（实际缩进：children 行 4 tab，kind/scope 5 tab，收尾 3 tab）
  const anchor =
    '\t\t\t\tchildren: { "settings.general.item": {\n' +
    '\t\t\t\t\tkind: "list",\n' +
    '\t\t\t\t\tscope: "root"\n' +
    '\t\t\t\t} }\n' +
    '\t\t\t}, GeneralSection));';
  if (!src.includes(anchor)) throw new Error('锚点缺失（general section 结尾）');

  const inject =
    anchor +
    '\n\n' +
    '\t\t\t// [dsh-about-tab] 桌面版「关于本软件」独立设置页（order 最大，排在 Agent 预设之后）\n' +
    '\t\t\tconst ABOUT_LINES = ' + JSON.stringify(lines) + ';\n' +
    '\t\t\tfunction AboutSection() {\n' +
    '\t\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {\n' +
    '\t\t\t\tstyle: { maxWidth: 640, paddingTop: 4 },\n' +
    '\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("h2", {\n' +
    '\t\t\t\t\tstyle: { fontSize: 18, fontWeight: 600, marginBottom: 16, color: "var(--dsw-alias-label-primary)" },\n' +
    '\t\t\t\t\tchildren: "关于本软件"\n' +
    '\t\t\t\t}), (0, react_jsx_runtime.jsx)("div", {\n' +
    '\t\t\t\t\tstyle: { fontSize: 13, lineHeight: 1.9, color: "var(--dsw-alias-label-secondary)", whiteSpace: "pre-wrap" },\n' +
    '\t\t\t\t\tchildren: ABOUT_LINES.join(String.fromCharCode(10))\n' +
    '\t\t\t\t})]\n' +
    '\t\t\t});\n' +
    '\t\t\t}\n' +
    '\t\t\tctx.slots.inject("settings.section", () => ctx.slots.register({\n' +
    '\t\t\t\tname: "settings.section",\n' +
    '\t\t\t\tid: "about",\n' +
    '\t\t\t\torder: 100,\n' +
    '\t\t\t\tlabel: "关于本软件",\n' +
    '\t\t\t\tchildren: {}\n' +
    '\t\t\t}, AboutSection));';

  src = src.replace(anchor, inject);
  fs.writeFileSync(clientPath, src, 'utf8');
  console.log(`[patch-dsh-about] 补丁已写入: ${clientPath}`);
  return true;
}

if (process.argv.length !== 3) {
  console.error('用法: node patch-dsh-about.js <settings-general/lib/client.js 路径>');
  process.exit(1);
}
try {
  patch(process.argv[2]);
} catch (e) {
  console.error(`[patch-dsh-about] 失败: ${e.message}`);
  process.exit(1);
}
