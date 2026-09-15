#!/usr/bin/env node
/**
 * 桌面版功能补丁（双平台共用，构建时对 resources/dsh-runtime 执行）：
 *
 * 1) 模型列表：在 dsh-llm-deepseek 的 DEFAULT_MODELS 头部加入
 *    deepseek-flash（DeepSeek-V4.1-Flash，2026-09-10 发布，1M 上下文 + 原生多模态），
 *    保留 deepseek-v4-pro / deepseek-v4-flash / deepseek-v4-flash-vision-exp 全部选项。
 *
 * 2) 会话用量与费用（dsh-client-ui-chat）：
 *    a. 「本轮用量」面板新增「费用估算」行：金额 + 高峰/闲时标记 + 模型名；
 *    b. 会话消息流末尾新增「本次会话结算」卡片（会话完成后显示）：
 *       模型、插件/工具调用、Token 用量（输入/缓存命中/缓存写入/输出/推理）、
 *       缓存命中率、费用估算（按官方价格表 × 峰谷时段）。
 *
 * 幂等：任一文件已含 [dsh-session-cost] 标记则跳过。
 *
 * 用法: node scripts/patch-dsh-cost.js <dsh-runtime/node_modules 根路径>
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARK = '[dsh-session-cost]';

/* ---------- 注入到 client.js 的辅助代码（费用计算 + 会话结算卡片） ---------- */
const HELPERS = `
/** [dsh-session-cost] DeepSeek 官方价格（元/百万 tokens，2026-09-10 起）。数组 = [闲时, 高峰]。 */
const DS_PRICES = {
  "deepseek-flash": { inCache: [0.02, 0.04], inMiss: [1, 2], out: [4, 8] },
  "deepseek-v4-flash": { inCache: [0.02, 0.04], inMiss: [1, 2], out: [4, 8] },
  "deepseek-v4-flash-vision-exp": { inCache: [0.02, 0.04], inMiss: [1, 2], out: [4, 8] },
  "deepseek-v4-pro": { inCache: [0.15, 0.30], inMiss: [4.5, 9], out: [13.5, 27] }
};
const DS_MODEL_NAMES = {
  "deepseek-flash": "DeepSeek-V4.1-Flash",
  "deepseek-v4-flash": "DeepSeek-V4-Flash",
  "deepseek-v4-flash-vision-exp": "DeepSeek-V4-Flash-Vision-Exp",
  "deepseek-v4-pro": "DeepSeek-V4-Pro"
};
/** 返回 1=高峰 / 0=闲时（北京时间周一至五 9-12、14-18 为高峰）。 */
function dsPriceBand() {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short", hour: "numeric", hour12: false }).formatToParts(new Date()).map((p) => [p.type, p.value]));
    const h = Number(parts.hour) % 24;
    const wd = parts.weekday;
    return wd !== "Sat" && wd !== "Sun" && (h >= 9 && h < 12 || h >= 14 && h < 18) ? 1 : 0;
  } catch (e) {
    const h = new Date().getHours();
    return h >= 9 && h < 12 || h >= 14 && h < 18 ? 1 : 0;
  }
}
/** 单个 usage 的估算费用（元）与计价信息。 */
function dsCostFor(usage) {
  if (!usage) return null;
  const band = dsPriceBand();
  const modelId = usage.routes && usage.routes[0] ? usage.routes[0].model : "deepseek-flash";
  const p = DS_PRICES[modelId] || DS_PRICES["deepseek-flash"];
  const yuan = (usage.uncachedInputTokens || 0) / 1e6 * p.inMiss[band] + ((usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)) / 1e6 * p.inCache[band] + (usage.outputTokens || 0) / 1e6 * p.out[band];
  return { yuan, band: band === 1 ? "高峰" : "闲时", modelId };
}
function dsModelLabel(id) { return DS_MODEL_NAMES[id] || id; }
function dsFormatYuan(yuan) { return yuan >= 0.01 ? yuan.toFixed(2) : yuan.toFixed(4); }
`;

/* ---------- 会话结算卡片组件（注入到 client.js） ---------- */
const SUMMARY_COMPONENT = `
/** [dsh-session-cost] 会话结算卡片：会话完成后在消息流末尾汇总模型/工具/用量/费用。 */
function SessionSummaryCard({ order, nodeStore, t }) {
  let total = 0, uncached = 0, cacheRead = 0, cacheWrite = 0, output = 0, reasoning = 0, toolCalls = 0, costYuan = 0;
  const models = /* @__PURE__ */ new Set();
  const tools = /* @__PURE__ */ new Set();
  if (nodeStore) {
    const keys = Array.isArray(order) ? order : [];
    for (const key of keys) {
      const node = nodeStore.get(key);
      if (node === void 0 || node === null || node.data === void 0) continue;
      const u = node.data.tokenUsage;
      if (u) {
        total += u.totalTokens || 0;
        uncached += u.uncachedInputTokens || 0;
        cacheRead += u.cacheReadTokens || 0;
        cacheWrite += u.cacheWriteTokens || 0;
        output += u.outputTokens || 0;
        reasoning += u.reasoningTokens || 0;
        const c = dsCostFor(u);
        if (c) costYuan += c.yuan;
        if (Array.isArray(u.routes)) for (const r of u.routes) if (r && r.model) models.add(dsModelLabel(r.model));
      }
      if (node.kind === "tool-call" && node.data.name) { toolCalls += 1; tools.add(node.data.name); }
      const blocks = node.data.blocks;
      if (Array.isArray(blocks)) for (const b of blocks) if (b && b.kind === "tool-call" && b.name) { toolCalls += 1; tools.add(b.name); }
    }
  }
  if (total === 0 && toolCalls === 0) return null;
  const band = dsPriceBand() === 1 ? "高峰时段（周一至五 9-12 / 14-18）" : "闲时时段";
  const hitPct = total - output > 0 ? Math.round(cacheRead / (total - output) * 100) : 0;
  const row = (label, value) => (0, react_jsx_runtime.jsxs)("div", {
    style: { display: "flex", justifyContent: "space-between", gap: "16px", padding: "5px 0", borderBottom: ".5px solid var(--dsw-alias-border-l2)", fontSize: "12px", lineHeight: "18px" },
    children: [(0, react_jsx_runtime.jsx)("span", { style: { color: "var(--dsw-alias-label-secondary)" }, children: label }), (0, react_jsx_runtime.jsx)("span", { style: { color: "var(--dsw-alias-label-primary)", textAlign: "right", wordBreak: "break-all" }, children: value })]
  }, label);
  return (0, react_jsx_runtime.jsx)("div", {
    "data-session-summary": true,
    style: { margin: "16px 12px 0", padding: "14px 16px", borderRadius: "10px", background: "var(--dsw-alias-bg-module-platform)", border: ".5px solid var(--dsw-alias-border-l2)" },
    children: [
      (0, react_jsx_runtime.jsx)("div", { style: { fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary)", marginBottom: "6px" }, children: "本次会话结算" }),
      row("调用模型", models.size > 0 ? Array.from(models).join("、") : "—"),
      row("插件 / 工具调用", toolCalls > 0 ? \`\${tools.size} 种（\${Array.from(tools).slice(0, 8).join("、")}\${tools.size > 8 ? " 等" : ""}），共 \${toolCalls} 次\` : "—"),
      row("Token 总量", \`\${total.toLocaleString()} tok\`),
      row("输入（未缓存）", \`\${uncached.toLocaleString()} tok\`),
      row("缓存读取 / 写入", \`\${cacheRead.toLocaleString()} / \${cacheWrite.toLocaleString()} tok\`),
      row("输出（含推理）", \`\${output.toLocaleString()} tok（推理 \${reasoning.toLocaleString()}）\`),
      row("缓存命中率", \`\${hitPct}%\`),
      row("费用估算", \`¥\${dsFormatYuan(costYuan)}\`),
      row("计价时段", band)
    ]
  });
}
`;

/* ---------- 1) 模型列表补丁：dsh-llm-deepseek ---------- */
function patchModels(file) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARK)) { console.log(`[patch-dsh-cost] 模型列表已打补丁，跳过: ${file}`); return true; }
  // 0.1.5-rc.2 起官方已内置 deepseek-flash（DeepSeek-V4.1-Flash）为首个模型，无需再插
  if (src.includes('id: "deepseek-flash"')) {
    console.log(`[patch-dsh-cost] 模型列表已含 deepseek-flash（官方内置），跳过: ${file}`);
    return true;
  }
  const re = /const DEFAULT_MODELS = \[[\r\n]+[ \t]*\{\s*id: "deepseek-v4-flash",/;
  const m = src.match(re);
  if (!m) throw new Error('模型列表锚点缺失: ' + file);
  const insert =
    'const DEFAULT_MODELS = [\n' +
    '\t{\n' +
    '\t\tid: "deepseek-flash",\n' +
    '\t\tname: "DeepSeek-V4.1-Flash",\n' +
    '\t\tdescription: "[dsh-session-cost] Latest V4.1 architecture: native multimodal, 1M context; exceeds V4 Pro at Flash pricing (2026-09-10).",\n' +
    '\t\tcontextWindow: DEFAULT_CONTEXT_WINDOW,\n' +
    '\t\tinputModalities: ["text", "image"],\n' +
    '\t\timagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET\n' +
    '\t},\n' +
    '\t{\n' +
    '\t\tid: "deepseek-v4-flash",';
  src = src.replace(m[0], insert);
  fs.writeFileSync(file, src, 'utf8');
  console.log(`[patch-dsh-cost] 模型列表补丁已写入: ${file}`);
  return true;
}

/* ---------- 2) 前端补丁：dsh-client-ui-chat ---------- */
function patchChatClient(file) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARK)) { console.log(`[patch-dsh-cost] 前端已打补丁，跳过: ${file}`); return true; }

  // a) ChatNodeList 之后注入 HELPERS + SessionSummaryCard
  const reA = /const ChatNodeList = \(0, react\.memo\)\(function ChatNodeList\(\{ order, \.\.\.seatProps \}\) \{\s*return order\.map\(\(nodeKey\) => \(0, react_jsx_runtime\.jsx\)\(ChatNodeSeat, \{\s*nodeKey,\s*\.\.\.seatProps\s*\}, nodeKey\)\);\s*\}\);/;
  const mA = src.match(reA);
  if (!mA) throw new Error('锚点A（ChatNodeList）缺失');
  src = src.replace(mA[0], mA[0] + HELPERS + SUMMARY_COMPONENT);

  // b) TurnUsagePanel：routes 计算后加 cost
  const reB = /const routes = usage\.routes\?\.map\(\(route\) => `\$\{route\.provider\}\/\$\{route\.model\}`\)\.join\(", "\) \?\? "";/;
  const mB = src.match(reB);
  if (!mB) throw new Error('锚点B（routes）缺失');
  src = src.replace(mB[0], mB[0] + '\n\t\t\t\tconst cost = dsCostFor(usage);');

  // c) TurnUsagePanel：dl 内「费用估算」行（output 行之后）
  const reC = /\(0, react_jsx_runtime\.jsx\)\("dt", \{ children: t\("message\.turnUsage\.output"\) \}\),\s*\(0, react_jsx_runtime\.jsxs\)\("dd", \{ children: \[formatExactCount\(usage\.outputTokens, t\), usage\.reasoningTokens !== void 0 && \(0, react_jsx_runtime\.jsx\)\("span", \{\s*className: \w+_module_css_default\.reasoning,\s*children: t\("message\.turnUsage\.reasoning", \{ tokens: formatExactCount\(usage\.reasoningTokens, t\) \}\)\s*\}\)\] \}\)/;
  const mC = src.match(reC);
  if (!mC) throw new Error('锚点C（TurnUsagePanel 输出行）缺失');
  const costRow =
    mC[0] + ',\n' +
    '\t\t\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("dt", { children: "费用估算" }),\n' +
    '\t\t\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("dd", { children: cost === null ? "—" : `¥${dsFormatYuan(cost.yuan)}（${cost.band}价 · ${dsModelLabel(cost.modelId)}）` })';
  src = src.replace(mC[0], costRow);

  // d) ChatView：消息流末尾注入 SessionSummaryCard（会话完成时显示）
  const reD = /renderSlot,\s*t\s*\}\),\s*running && \(0, react_jsx_runtime\.jsx\)\(TurnStatus, \{/;
  const mD = src.match(reD);
  if (!mD) throw new Error('锚点D（ChatView TurnStatus）缺失');
  const injectD =
    'renderSlot,\n' +
    '\t\t\t\t\t\t\t\t\t\tt\n' +
    '\t\t\t\t\t\t\t\t\t}),\n' +
    '\t\t\t\t\t\t\t\t\t!running && (0, react_jsx_runtime.jsx)(SessionSummaryCard, {\n' +
    '\t\t\t\t\t\t\t\t\t\torder,\n' +
    '\t\t\t\t\t\t\t\t\t\tnodeStore,\n' +
    '\t\t\t\t\t\t\t\t\t\tt\n' +
    '\t\t\t\t\t\t\t\t\t}),\n' +
    '\t\t\t\t\t\t\t\t\trunning && (0, react_jsx_runtime.jsx)(TurnStatus, {';
  src = src.replace(mD[0], injectD);

  fs.writeFileSync(file, src, 'utf8');
  console.log(`[patch-dsh-cost] 前端补丁已写入: ${file}`);
  return true;
}

const root = process.argv[2];
if (!root) { console.error('用法: node patch-dsh-cost.js <dsh-runtime/node_modules 根路径>'); process.exit(1); }

try {
  patchModels(path.join(root, '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js'));
  patchChatClient(path.join(root, '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js'));
} catch (e) {
  console.error(`[patch-dsh-cost] 失败: ${e.message}`);
  process.exit(1);
}
