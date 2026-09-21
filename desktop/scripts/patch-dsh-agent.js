#!/usr/bin/env node
/**
 * scripts/patch-dsh-agent.js —— 桌面版「网页版智能体」前端补丁（构建时对 resources/dsh-runtime 执行）。
 *
 * 1) dsh-client-ui-model-selection/lib/client.js：
 *    在模型选择器菜单末尾追加「网页版智能体」分组（provider 来自主进程 window.dshAgent），
 *    点击某模型 → window.dshAgent.openAgent(id) 打开智能体窗口。
 *
 * 2) dsh-client-ui-settings-models/lib/client.js：
 *    在设置-模型页面顶部追加「网页版智能体」区块：
 *      一行一个网页模型（名称 + 登录按钮 + 自定义删除），
 *      支持「添加自定义网页模型」（名称 + URL）。
 *    登录 = 在主进程智能体窗口打开该模型登录页（账号密码 / 二维码扫码由用户在网页完成）。
 *
 * 幂等：任一文件已含 [dsh-agent] 标记则跳过。
 *
 * 用法: node scripts/patch-dsh-agent.js <dsh-runtime/node_modules 根路径>
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARK = '[dsh-agent]';

/* ================= 1) 模型选择器 ================= */
const AGENT_GROUP_COMPONENT = `
/** ${MARK} 网页版智能体分组：读主进程 provider 列表，点击打开智能体窗口。 */
function AgentWebGroup() {
  const [providers, setProviders] = react.useState(null);
  react.useEffect(() => {
    let alive = true;
    try {
      if (typeof window.dshAgent !== "undefined" && window.dshAgent.listProviders) {
        window.dshAgent.listProviders().then((list) => {
          if (alive) setProviders(Array.isArray(list) ? list : []);
        }).catch(() => { if (alive) setProviders([]); });
      } else {
        setProviders([]);
      }
    } catch (e) { if (alive) setProviders([]); }
    return () => { alive = false; };
  }, []);
  if (providers === null || providers.length === 0) return null;
  return (0, react_jsx_runtime.jsxs)("section", {
    role: "group",
    className: ModelSelect_module_css_default.group,
    children: [
      (0, react_jsx_runtime.jsx)("div", {
        className: ModelSelect_module_css_default.groupTitle,
        children: "网页版智能体"
      }),
      providers.map((p) => (0, react_jsx_runtime.jsxs)("button", {
        type: "button",
        role: "menuitemradio",
        className: clsx(ModelSelect_module_css_default.option),
        title: p.url || "",
        onClick: () => {
          try { if (window.dshAgent && window.dshAgent.openAgent) window.dshAgent.openAgent(p.id); } catch (e) {}
        },
        children: [
          (0, react_jsx_runtime.jsx)("span", {
            className: ModelSelect_module_css_default.optionCopy,
            children: (0, react_jsx_runtime.jsx)("span", {
              className: ModelSelect_module_css_default.modelName,
              children: p.name
            })
          })
        ]
      }, p.id)),
      (0, react_jsx_runtime.jsx)("button", {
        type: "button",
        role: "menuitem",
        className: clsx(ModelSelect_module_css_default.option),
        onClick: () => {
          try { if (window.dshAgent && window.dshAgent.openMeeting) window.dshAgent.openMeeting(); } catch (e) {}
        },
        children: [
          (0, react_jsx_runtime.jsx)("span", {
            className: ModelSelect_module_css_default.optionCopy,
            children: (0, react_jsx_runtime.jsx)("span", {
              className: ModelSelect_module_css_default.modelName,
              children: "🎯 打开 AI 会议"
            })
          })
        ]
      })
    ]
  });
}
`;

function patchModelSelection(file) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARK)) {
    console.log(`[patch-dsh-agent] 模型选择器已打补丁，跳过: ${file}`);
    return true;
  }

  // a) 组件定义注入到 ModelSelect 之前
  const anchorDef = 'function ModelSelect({ locked, available, directory, load, select, t }) {';
  if (!src.includes(anchorDef)) throw new Error('模型选择器锚点（ModelSelect 定义）缺失');
  src = src.replace(anchorDef, AGENT_GROUP_COMPONENT + '\n\t\t' + anchorDef, 1);

  // b) 分组渲染：groups.map 之后、empty 之前（indexOf 定位，避免正则转义坑）
  const tailAnchor = 'state.status === "ready" && choices.length === 0 && (0, react_jsx_runtime.jsx)("div", {';
  const tailIdx = src.indexOf(tailAnchor);
  if (tailIdx === -1) throw new Error('模型选择器锚点（groups 渲染）缺失');
  const insertAt = src.lastIndexOf('}),', tailIdx);
  if (insertAt === -1 || insertAt < tailIdx - 200) throw new Error('模型选择器锚点（groups 结束）缺失');
  const after = src.slice(insertAt + 3, tailIdx); // 应全为空白/换行
  src = src.slice(0, insertAt + 3) + '\n' + after + '(0, react_jsx_runtime.jsx)(AgentWebGroup, {}),\n' + src.slice(tailIdx);

  fs.writeFileSync(file, src, 'utf8');
  console.log(`[patch-dsh-agent] 模型选择器补丁已写入: ${file}`);
  return true;
}

/* ================= 2) 设置-模型 ================= */
const AGENT_SETTINGS_COMPONENT = `
/** ${MARK} 设置-模型「网页版智能体」区块：一行一个模型，登录/删除，可添加自定义。 */
function AgentWebSection() {
  const [providers, setProviders] = react.useState(null);
  const [adding, setAdding] = react.useState(false);
  const [name, setName] = react.useState("");
  const [url, setUrl] = react.useState("");
  const [busy, setBusy] = react.useState(false);
  const [notice, setNotice] = react.useState("");
  const reload = () => {
    try {
      if (typeof window.dshAgent !== "undefined" && window.dshAgent.listProviders) {
        window.dshAgent.listProviders().then((list) => setProviders(Array.isArray(list) ? list : [])).catch(() => setProviders([]));
      } else setProviders([]);
    } catch (e) { setProviders([]); }
  };
  react.useEffect(() => { reload(); }, []);
  const rowStyle = { display: "flex", alignItems: "center", gap: "12px", padding: "10px 4px", borderBottom: ".5px solid var(--dsw-alias-border-l2)" };
  const btnStyle = { padding: "6px 14px", borderRadius: "16px", border: ".5px solid var(--dsw-alias-border-l4)", background: "transparent", color: "var(--dsw-alias-label-primary)", cursor: "pointer", fontSize: "12px" };
  const nameStyle = { flex: "1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-primary)", fontSize: "14px" };
  const subStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" };
  const inputStyle = { background: "var(--dsw-alias-bg-input)", border: ".5px solid var(--dsw-alias-border-l4)", borderRadius: "8px", padding: "7px 10px", color: "var(--dsw-alias-label-primary)", fontSize: "13px", minWidth: "120px", flex: "1" };
  const doAdd = () => {
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      if (window.dshAgent && window.dshAgent.addProvider) {
        window.dshAgent.addProvider({ name, url }).then((r) => {
          setBusy(false);
          if (r && r.ok) {
            setName(""); setUrl(""); setAdding(false);
            setNotice("已添加：可先在模型选择器里切换到该模型，再在智能体窗口登录。");
            reload();
          } else {
            setNotice((r && r.error) || "添加失败");
          }
        }).catch(() => { setBusy(false); setNotice("添加失败"); });
      } else { setBusy(false); setNotice("智能体桥未就绪（请确认桌面客户端已更新）"); }
    } catch (e) { setBusy(false); setNotice("添加失败"); }
  };
  const doRemove = (id) => {
    try {
      if (window.dshAgent && window.dshAgent.removeProvider) {
        window.dshAgent.removeProvider(id).then((r) => {
          if (r && r.ok) reload();
        });
      }
    } catch (e) {}
  };
  const doLogin = (p) => {
    try { if (window.dshAgent && window.dshAgent.openAgent) window.dshAgent.openAgent(p.id); } catch (e) {}
  };
  return (0, react_jsx_runtime.jsxs)("section", {
    "data-dsh-agent-section": true,
    style: { marginTop: "18px", padding: "14px 16px", borderRadius: "12px", border: ".5px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-module-platform)" },
    children: [
      (0, react_jsx_runtime.jsx)("div", { style: { fontSize: "15px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" }, children: "网页版智能体" }),
      (0, react_jsx_runtime.jsx)("div", { style: Object.assign({ marginTop: "4px" }, subStyle), children: "把网页版 AI 当作模型使用：先在下方选择网页模型并打开登录页完成登录（账号密码 / 二维码），登录态会被记住；之后在「模型选择」里切换到该模型即可让它操作本机（读取 / 写入 / 执行，均受底部权限开关约束）。" }),
      providers === null ? (0, react_jsx_runtime.jsx)("div", { style: Object.assign({ marginTop: "10px" }, subStyle), children: "加载中…" }) : (0, react_jsx_runtime.jsx)("div", { children: providers.map((p) => (0, react_jsx_runtime.jsxs)("div", {
        style: rowStyle,
        children: [
          (0, react_jsx_runtime.jsxs)("div", { style: { flex: "1", minWidth: 0 }, children: [
            (0, react_jsx_runtime.jsx)("div", { style: nameStyle, children: p.name }),
            (0, react_jsx_runtime.jsx)("div", { style: subStyle, children: (p.builtin ? "内置 · " : "自定义 · ") + (p.loginMode || "") })
          ]}),
          (0, react_jsx_runtime.jsx)("button", { type: "button", style: btnStyle, onClick: () => doLogin(p), children: "打开并登录" }),
          !p.builtin && (0, react_jsx_runtime.jsx)("button", { type: "button", style: Object.assign({}, btnStyle, { color: "var(--dsw-alias-state-error-primary)" }), onClick: () => doRemove(p.id), children: "删除" })
        ]
      }, p.id)) }),
      !adding ? (0, react_jsx_runtime.jsx)("button", { type: "button", style: Object.assign({ marginTop: "10px" }, btnStyle), onClick: () => setAdding(true), children: "＋ 添加自定义网页模型" }) : (0, react_jsx_runtime.jsxs)("div", {
        style: { marginTop: "10px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
        children: [
          (0, react_jsx_runtime.jsx)("input", { placeholder: "名称（如：某网页版）", value: name, onChange: (e) => setName(e.target.value), style: inputStyle }),
          (0, react_jsx_runtime.jsx)("input", { placeholder: "网址（如：https://example.com/chat）", value: url, onChange: (e) => setUrl(e.target.value), style: inputStyle }),
          (0, react_jsx_runtime.jsx)("button", { type: "button", style: btnStyle, disabled: busy, onClick: doAdd, children: "保存" }),
          (0, react_jsx_runtime.jsx)("button", { type: "button", style: btnStyle, onClick: () => { setAdding(false); setNotice(""); }, children: "取消" })
        ]
      }),
      notice !== "" && (0, react_jsx_runtime.jsx)("div", { style: Object.assign({ marginTop: "8px" }, subStyle), children: notice })
    ]
  });
}
`;

function patchSettingsModels(file) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARK)) {
    console.log(`[patch-dsh-agent] 设置-模型已打补丁，跳过: ${file}`);
    return true;
  }

  // a) 组件定义注入到 Loaded 之前
  const anchorDef = 'function Loaded({ injected, renderSlot }) {';
  if (!src.includes(anchorDef)) throw new Error('设置-模型锚点（Loaded 定义）缺失');
  src = src.replace(anchorDef, AGENT_SETTINGS_COMPONENT + '\n\t\t' + anchorDef, 1);

  // b) 区块渲染：intro 之后插入 AgentWebSection（indexOf 定位）
  const introAnchor = 'children: t("intro")';
  const introIdx = src.indexOf(introAnchor);
  if (introIdx === -1) throw new Error('设置-模型锚点（intro 渲染）缺失');
  // 找到该 p 元素结束的 "})"，其后通常紧跟数组分隔符 ","
  const closeIdx = src.indexOf('})', introIdx);
  if (closeIdx === -1 || closeIdx - introIdx > 200) throw new Error('设置-模型锚点（intro 元素结束）缺失');
  let cut = closeIdx + 2;
  let comma = '';
  if (src[cut] === ',') { comma = ','; cut += 1; }
  src = src.slice(0, closeIdx + 2) + comma + '\n\t\t\t\t\t(0, react_jsx_runtime.jsx)(AgentWebSection, {}),' + src.slice(cut);

  fs.writeFileSync(file, src, 'utf8');
  console.log(`[patch-dsh-agent] 设置-模型补丁已写入: ${file}`);
  return true;
}

/* ================= 入口 ================= */
const root = process.argv[2];
if (!root) {
  console.error('用法: node scripts/patch-dsh-agent.js <dsh-runtime/node_modules 根路径>');
  process.exit(1);
}

try {
  patchModelSelection(path.join(root, '@deepseek-ai', 'dsh-client-ui-model-selection', 'lib', 'client.js'));
  patchSettingsModels(path.join(root, '@deepseek-ai', 'dsh-client-ui-settings-models', 'lib', 'client.js'));
} catch (e) {
  console.error(`[patch-dsh-agent] 失败: ${e.message}`);
  process.exit(1);
}
