#!/usr/bin/env node
'use strict';
/**
 * tools/build-modes-page.js —— 生成「模式速查页」
 *
 * 为什么要有这个：
 *   用户原话「你这个模式我没看懂」——测试台里一个下拉框一次只能看一个模式，
 *   要理解"8 个模式分别在什么时候用"得一个个点，看不到全貌。
 *   本脚本把 modes/models/roles 三个模块的真实数据抽出来，
 *   生成一页 HTML，一屏看全：8 个模式的场景 + 模型要求 + 真实选角结果。
 *
 * ★ 关键设计：页面里的每一个数字都不是手写的，全部来自 core/ 模块实时计算。
 *   源码改了重新跑一次即可，不会出现"文档说一套、代码做一套"。
 *
 * 用法：node tools/build-modes-page.js [输出路径]
 */

const fs = require('fs');
const path = require('path');

const { listModes, getMode, planPhases, estimateCost, costOverview } = require('../core/modes');
const { listModels, getModel, fitScore } = require('../core/models');
const { listRoleSets, ROLE_REQ, ROLE_CATALOG } = require('../core/roles');
const { castRoles } = require('../core/casting');

const OUT = process.argv[2] || path.join(__dirname, '..', 'modes.html');

/* 演示用种子：固定住，保证每次生成结果一致（不是随机刷新） */
const DEMO_SEED = 'demo-1';

/* 决策向导：把每个模式的 when 压成一句"我要…"（人工提炼，仅作入口导航） */
const WIZARD = [
  { id: 'broadcast', ask: '同一件事，我想同时听好几个不同角度的看法' },
  { id: 'review', ask: '我有一份材料（文档/代码/方案），想让它被挑毛病' },
  { id: 'assist', ask: '我要一份能直接照着做的方案，不想听讨论' },
  { id: 'iterate', ask: '我已经写了一版，想改到挑不出新问题' },
  { id: 'debate', ask: '两个方案难分高下，想看它们正面对撞' },
  { id: 'panel', ask: '问题很复杂，想要后一个人接着前一个人往深挖' },
  { id: 'chairman', ask: '我想要个主持人抓着分歧点追问到底' },
  { id: 'divide', ask: '任务是能拆开的，想分头做再汇总' },
  { id: 'tournament', ask: '我还没有满意的答案，想要几份候选再客观挑一份' },
  { id: 'build', ask: '我有个想法，想变成真能跑起来的软件' },
];

/* 成本档位的中文标签（给用户看的，不是内部枚举） */
const TIER_CN = { light: '轻', medium: '中', heavy: '重' };
const TIER_CLS = { light: 't-light', medium: 't-medium', heavy: 't-heavy' };

const DIM_CN = {
  reasoning: '推理', chinese: '中文', structure: '结构化', speed: '速度',
  longOutput: '长文', multimodal: '多模态', search: '检索', stability: '稳定性',
};
const ROLE_CN = {
  architect: '架构师', 'red-team': '红队', 'fact-check': '事实核查', clerk: '书记员',
  executor: '执行者', 'chair-assistant': '主持助理', retriever: '检索员',
  reverse: '反方', compliance: '合规官', 'user-advocate': '用户代言',
  pm: '产品经理', newcomer: '新人视角', 'data-analyst': '数据分析',
  generalist: '通才', 'cost-analyst': '成本分析师',
};

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const md = (s) => esc(String(s || '').replace(/\*\*/g, ''));

/* ---------- 1) 拉全部数据 ---------- */

const modes = listModes();
const models = listModels();
const sets = listRoleSets();
const ALL_MODEL_IDS = models.map((m) => m.id);

/** 每个模式的真实编制：用推荐角色组 + 全部可用模型作为候选池 */
const modeData = modes.map((mode) => {
  const set = (mode.modelFit && mode.modelFit.recommendSet) || 'trio';
  const validSet = sets.some((s) => s.id === set) ? set : 'trio';
  const cast = castRoles(ALL_MODEL_IDS, { set: validSet, seed: DEMO_SEED });
  /* ★ 用**实际编制人数**当参会者，不用全部 12 个模型：
   *   - 页面展示的"每阶段谁发言"才是真实规模的会（不然 seat:'all' 会渲染成 12 人）
   *   - 成本估算也才对得上（成本随人数平方增长，用 12 人算会严重虚高） */
  const partIds = cast.assignment.map((a) => a.providerId);
  let plan = [];
  try {
    plan = planPhases(mode.id, { participants: partIds, assignment: cast.assignment });
  } catch (e) { plan = []; }
  const cost = estimateCost(mode.id, { participants: partIds, assignment: cast.assignment });
  return { mode, set: validSet, cast, plan, cost, partIds };
});

/** 同一角色组、不同种子的编制差异（证明"随机"是真的，且不会错配） */
const castVariants = ['demo-1', 'demo-2', 'demo-3'].map((seed) => ({
  seed,
  cast: castRoles(ALL_MODEL_IDS, { set: 'product-9', seed }),
}));

/* ---------- 2) 渲染 ---------- */

function bar(v, max = 5) {
  const pct = (v / max) * 100;
  const color = v >= 5 ? '#4ade80' : v >= 4 ? '#7fd8a0' : v >= 3 ? '#ffd479' : v >= 2 ? '#ff9f6b' : '#ff8080';
  return `<span class="bar"><i style="width:${pct}%;background:${color}"></i><b>${v}</b></span>`;
}

function traitsRow(traits) {
  return `<div class="traits">${Object.entries(DIM_CN).map(([k, cn]) =>
    `<span class="tr"><em>${cn}</em>${bar(traits[k] || 0)}</span>`).join('')}</div>`;
}

function renderModeCard(d, idx) {
  const { mode, set, cast, plan, cost, partIds } = d;
  const mf = mode.modelFit || {};
  const sc = mode.scene || {};
  const need = Object.entries(mf.need || {})
    .map(([k, v]) => `<span class="need">${DIM_CN[k] || k} ≥ ${v}</span>`).join('');

  const flags = [
    mode.loop ? `<span class="flag loop">循环至收敛</span>` : '',
    mode.needsMaterial ? `<span class="flag">需要材料</span>` : '',
    mode.needsDraft ? `<span class="flag">需要草稿</span>` : '',
    mode.requiresChairman ? `<span class="flag api">主席必须走 API</span>` : '',
    /* ★ 成本档位（第五轮补）：用户的原始抱怨是"别瞎聊浪费 token"，
     *   所以"这个模式贵不贵"必须和"什么时候用它"一样显眼。 */
    `<span class="flag cost ${TIER_CLS[cost.tier]}">成本 ${TIER_CN[cost.tier]}`
      + `${cost.rounds > 1 ? `（最坏 ${cost.maxCalls} 次调用）` : `（${cost.callsPerRound} 次调用）`}</span>`,
  ].join('');

  /* 成本明细：把"贵在哪"摊开给用户看 —— 只说"贵"没用，要能指出砍哪一段 */
  const costRows = cost.breakdown.map((b) => `
    <tr><td>${esc(b.phase)}</td>
        <td class="num">${b.speakers}${b.estimated ? '<em title="由主持人动态点名，此处为预估">≈</em>' : ''}</td>
        <td class="num">${b.inject}</td>
        <td class="cnote">${esc(b.note)}</td></tr>`).join('');
  const costBlock = `
  <div class="costblock">
    <div class="costhead">
      <span class="costtier ${TIER_CLS[cost.tier]}">成本档位：${TIER_CN[cost.tier]}</span>
      <span class="costsum">参会 ${cost.participants} 人 ·
        单轮 <b>${cost.callsPerRound}</b> 次调用 / 注入 <b>${cost.contextPerRound}</b> 份 ·
        ${cost.rounds > 1 ? `上限 ${cost.rounds} 轮 → 最坏 <b>${cost.maxCalls}</b> 次 / ${cost.maxContext} 份` : `累计 <b>${cost.maxCalls}</b> 次 / ${cost.maxContext} 份`}</span>
    </div>
    <table class="costtable">
      <thead><tr><th>阶段</th><th class="num">发言人数</th><th class="num">注入份数</th><th>说明</th></tr></thead>
      <tbody>${costRows}</tbody>
    </table>
    <ul class="costadvice">${cost.advices.map((a) => `<li>${md(a)}</li>`).join('')}</ul>
  </div>`;

  const rawList = mode.phaseList || [];
  const stages = plan.map((p, i) => {
    /* 「主席点名」这类阶段的发言人是会中动态决定的，没有 picked 时解析结果为空。
     * 若照原样渲染成「（等人）」，用户会以为流程是空的 —— 所以单独识别出来说清楚。
     * 注意判据是 seat（席位选择器），不是 speak（顺序/并行）。 */
    const raw = rawList[i] || {};
    const isPicker = raw.seat === 'picker'
      || (Array.isArray(raw.seat) && raw.seat.includes('picker'));
    let who;
    if (p.speakers.length) {
      who = p.speakers.map((id) => {
        const m = getModel(id);
        return `<span class="who${m && m.channel === 'api' ? ' api' : ''}">${esc(m ? m.label : id)}</span>`;
      }).join('');
    } else if (isPicker) {
      who = '<span class="who picker">由主席按分歧点点名（会中动态决定）</span>';
    } else {
      who = '<span class="who none">（等人）</span>';
    }
    return `<li>
      <span class="stn">${p.index + 1}. ${esc(p.name)}</span>
      <span class="stsp">${who}</span>
      <span class="stsl">${esc(SLICE_CN[p.slice] || p.slice)}</span>
      ${p.degraded ? '<span class="stdeg" title="席位不够，已降级">⚠ 降级</span>' : ''}
    </li>`;
  }).join('');

  const seats = cast.assignment.map((a) => {
    const m = getModel(a.providerId);
    return `<div class="seat">
      <span class="sr">${esc(a.label)}</span>
      <span class="sm${m && m.channel === 'api' ? ' api' : ''}">${esc(m ? m.label : a.providerId)}</span>
      <span class="sf">${a.fitScore}<em>分</em></span>
      <span class="swhy">${esc(a.reason)}</span>
    </div>`;
  }).join('');

  const losers = ALL_MODEL_IDS.filter((id) => !cast.assignment.some((a) => a.providerId === id));

  return `
<section class="mode" id="mode-${mode.id}">
  <header>
    <span class="idx">${String(idx + 1).padStart(2, '0')}</span>
    <h3>${esc(mode.label)}</h3>
    <span class="setname">推荐角色组：${esc(set)}（${(sets.find((s) => s.id === set) || {}).seats || '?'} 席）</span>
    ${flags}
  </header>

  <div class="when"><b>什么时候用</b>${md(sc.when)}</div>

  <div class="quad">
    <div><em>典型例子</em>${md(sc.example)}</div>
    <div class="neg"><em>什么时候别用</em>${md(sc.notFor)}</div>
    <div class="pos"><em>产出</em>${md(sc.output)}</div>
    <div class="flowcell"><em>阶段流程</em><ol class="stages">${stages || '<li class="empty">（无阶段）</li>'}</ol></div>
  </div>

  <div class="fitrow">
    <span class="fitlab">模型门槛</span>${need || '<span class="need">不限</span>'}
    <span class="fitlab">通道</span><span class="chan">${(mf.channels || []).map((c) =>
    `<i class="${c === 'api' ? 'c-api' : 'c-web'}">${c === 'api' ? 'API' : '网页版'}</i>`).join('')}</span>
  </div>

  ${mf.tips ? `<div class="tips">${md(mf.tips)}</div>` : ''}

  ${costBlock}

  <details class="castbox" open>
    <summary>这个模式下，${partIds.length} 个实际席位由谁坐（候选池 12 个模型，seed=${DEMO_SEED}，按能力择优）</summary>
    <div class="seats">${seats}</div>
    ${losers.length ? `<div class="losers">落选 ${losers.length} 个：${losers.map((id) => {
    const m = getModel(id);
    return esc(m ? m.label : id);
  }).join('、')}<span class="loswhy">（能力不满足这些席位，硬塞进来只会拖后腿）</span></div>` : ''}
  </details>
</section>`;
}

function renderModelRow(m) {
  const best = (m.bestRoles || []).map((r) => `<span class="tag best">${esc(ROLE_CN[r] || r)}</span>`).join('');
  const avoid = (m.avoidRoles || []).map((r) => `<span class="tag avoid">${esc(ROLE_CN[r] || r)}</span>`).join('');
  return `<tr>
    <td class="mname">
      <b>${esc(m.label)}</b>
      <i class="${m.channel === 'api' ? 'c-api' : 'c-web'}">${m.channel === 'api' ? 'API' : '网页版'}</i>
    </td>
    <td>${traitsRow(m.traits)}</td>
    <td class="pros">${(m.strengths || []).map((s) => `<div class="p">+ ${esc(s)}</div>`).join('')}
        ${(m.weaknesses || []).map((s) => `<div class="c">− ${esc(s)}</div>`).join('')}</td>
    <td class="roles">${best}${avoid ? `<div class="avoidline">回避：${avoid}</div>` : ''}</td>
    <td class="note">${esc(m.meetingNote || '')}</td>
  </tr>`;
}

function renderSetCard(s) {
  const seats = s.roles.map((rid) => {
    const req = ROLE_REQ[rid] || {};
    const floor = Object.entries(req.floors || {})
      .map(([k, v]) => `${DIM_CN[k] || k}≥${v}`).join(' ');
    const w = Object.entries(req.weights || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([k, v]) => `${DIM_CN[k] || k}×${v}`).join(' ');
    return `<li><b>${esc(ROLE_CN[rid] || rid)}</b>
      <span class="floor">门槛 ${floor || '无'}</span>
      <span class="wgt">看重 ${w || '—'}</span></li>`;
  }).join('');
  return `<div class="setcard">
    <h4>${esc(s.label)} <span class="cnt">${s.seats} 席</span></h4>
    <ul class="setlist">${seats}</ul>
  </div>`;
}

const SLICE_CN = {
  task: '只看本轮任务', material: '只看待审材料', others: '只看别人发言',
  all: '看全部发言', critiques: '只看批评清单', draft: '只看当前草稿', none: '不带上下文',
};

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>通辽会议 · 8 个模式速查 + 12 个模型能力档案</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0b0e14;color:#dbe4ee;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;
       font-size:14px;line-height:1.7;padding:26px 30px 70px;max-width:1500px;margin:0 auto}
  h1{font-size:23px;color:#4da3ff;margin-bottom:6px}
  .sub{color:#7f93a8;font-size:13px;margin-bottom:4px}
  .src{color:#5d7285;font-size:12px;font-family:Consolas,monospace;margin-bottom:22px}
  h2{font-size:17px;color:#4da3ff;margin:38px 0 14px;padding-bottom:8px;border-bottom:1px solid #24303e}
  h2 small{color:#6b8098;font-weight:400;font-size:12px;margin-left:8px}

  /* 决策向导 */
  .wizard{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px}
  .wiz{background:#121a24;border:1px solid #24303e;border-left:3px solid #4da3ff;border-radius:7px;
       padding:11px 14px;text-decoration:none;color:#dbe4ee;transition:.15s;display:block}
  .wiz:hover{background:#16202c;border-left-color:#4ade80;transform:translateX(3px)}
  .wiz b{display:block;color:#8fc7ff;font-size:13px;margin-bottom:3px}
  .wiz span{color:#93a7bb;font-size:12.5px}

  /* 模式卡 */
  .mode{background:#111820;border:1px solid #24303e;border-radius:10px;padding:0;margin-bottom:16px;overflow:hidden}
  .mode header{display:flex;align-items:center;gap:10px;padding:12px 16px;background:#16202c;
               border-bottom:1px solid #24303e;flex-wrap:wrap}
  .mode .idx{font-family:Consolas,monospace;font-size:19px;color:#31445a;font-weight:700}
  .mode h3{font-size:16.5px;color:#e8f1fb}
  .mode .setname{font-size:12px;color:#7f93a8;font-family:Consolas,monospace}
  .flag{font-size:11px;padding:2px 8px;border-radius:20px;background:#1c2a38;color:#8fc7ff;border:1px solid #2a3a4a}
  .flag.loop{color:#ffd479;border-color:#4a3f2a}
  .flag.api{color:#4ade80;border-color:#2a4a38}

  .when{padding:11px 16px;background:#0e1a26;border-bottom:1px solid #1e2836;font-size:13.5px;color:#cfe0f0}
  .when b{color:#4da3ff;margin-right:9px}

  .quad{padding:0;display:grid;grid-template-columns:1fr 1fr}
  .quad > div{padding:11px 16px;border-bottom:1px solid #1a2432;border-right:1px solid #1a2432;font-size:12.8px;color:#a9bccd}
  .quad > div:nth-child(2n){border-right:none}
  .quad em{display:block;color:#6b8098;font-style:normal;font-size:11.5px;margin-bottom:3px}
  .quad .neg{color:#e3a2a2}
  .quad .pos{color:#8fd8a8}
  .quad .flowcell{grid-column:1/-1;border-right:none;background:#0d141d}

  ol.stages{list-style:none;margin-top:5px}
  ol.stages li{display:flex;align-items:center;gap:9px;padding:4px 0;flex-wrap:wrap;font-size:12.5px}
  .stn{color:#4da3ff;font-weight:600;min-width:118px}
  .stsp{display:flex;gap:5px;flex-wrap:wrap}
  .who{background:#1b2836;border:1px solid #2a3a4a;border-radius:4px;padding:1px 7px;color:#8fd8a8;font-size:12px}
  .who.api{color:#4ade80;border-color:#2a4a38;background:#12241c}
  .who.none{color:#667}
  .who.picker{color:#ffd479;border-color:#4a3f2a;background:#1a1508}
  .stsl{color:#7f93a8;font-size:11.5px}
  .stdeg{color:#ffd479;font-size:11px}
  li.empty{color:#667}

  .fitrow{display:flex;align-items:center;gap:8px;padding:10px 16px;flex-wrap:wrap;border-bottom:1px solid #1a2432}
  .fitlab{color:#6b8098;font-size:11.5px}
  .need{background:#1a2432;border:1px solid #2a3a4a;border-radius:4px;padding:2px 9px;font-size:12px;color:#ffd479;
        font-family:Consolas,monospace}
  .chan i{font-style:normal;font-size:11.5px;padding:2px 9px;border-radius:4px;margin-right:5px;font-family:Consolas,monospace}
  .c-api{background:#12241c;color:#4ade80;border:1px solid #2a4a38}
  .c-web{background:#101d2b;color:#8fc7ff;border:1px solid #2a3a4a}

  .tips{padding:10px 16px;background:#1a1508;color:#ffd479;font-size:12.5px;border-bottom:1px solid #2a2410}

  /* ── 成本区块（第五轮补：让"贵不贵"和"什么时候用"一样显眼）── */
  .flag.cost{background:#1a2430;color:#cfd8e3;border-color:#33455a}
  .flag.cost.t-light{background:#0f2417;color:#7fd8a0;border-color:#1e4030}
  .flag.cost.t-medium{background:#241f0c;color:#ffd479;border-color:#4a3d18}
  .flag.cost.t-heavy{background:#2a1214;color:#ff8f8f;border-color:#5a2226}
  .costblock{background:#0b1118;border-bottom:1px solid #1a2430;padding:10px 16px}
  .costhead{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px}
  .costtier{font-size:12px;font-weight:700;padding:2px 10px;border-radius:4px}
  .costtier.t-light{background:#0f2417;color:#7fd8a0}
  .costtier.t-medium{background:#241f0c;color:#ffd479}
  .costtier.t-heavy{background:#2a1214;color:#ff8f8f}
  .costsum{font-size:12px;color:#9fb0c0}
  .costsum b{color:#e8eef5}
  table.costtable{width:100%;border-collapse:collapse;font-size:12px}
  table.costtable th{text-align:left;color:#7c8b9a;font-weight:400;padding:3px 8px 3px 0;border-bottom:1px solid #1a2430}
  table.costtable td{padding:3px 8px 3px 0;color:#c6d2de;border-bottom:1px solid #131c26}
  table.costtable td.num{text-align:right;font-variant-numeric:tabular-nums;color:#8fc7ff}
  table.costtable td.cnote{color:#7c8b9a}
  table.costtable td.num em{color:#ffd479;font-style:normal;margin-left:2px}
  .costadvice{margin:8px 0 0;padding-left:18px;color:#ffd479;font-size:12px}
  .costadvice li{margin:3px 0}

  /* ── 成本对照表 ── */
  table.costoverview{width:100%;border-collapse:collapse;font-size:13px;background:#0d141d;
    border:1px solid #1a2430;border-radius:8px;overflow:hidden}
  table.costoverview th{text-align:left;padding:9px 12px;background:#111a24;color:#9fb0c0;font-weight:500;font-size:12px}
  table.costoverview td{padding:9px 12px;border-top:1px solid #1a2430;color:#c6d2de}
  table.costoverview td.num{text-align:right;font-variant-numeric:tabular-nums}
  table.costoverview tr.hi td{background:#160f14}
  table.costoverview .mini{width:60px;height:7px;border-radius:4px;background:#1a2430;overflow:hidden}
  table.costoverview .mini i{display:block;height:100%}

  details.castbox{background:#0d141d}
  details.castbox summary{padding:10px 16px;cursor:pointer;color:#8fc7ff;font-size:12.5px;user-select:none}
  details.castbox summary:hover{background:#111a24}
  .seats{display:grid;grid-template-columns:repeat(auto-fill,minmax(430px,1fr));gap:5px;padding:2px 16px 12px}
  .seat{display:flex;align-items:baseline;gap:9px;padding:5px 10px;background:#121a24;border-radius:5px;
        border-left:2px solid #4da3ff;font-size:12.5px}
  .sr{color:#ffd479;min-width:74px}
  .sm{color:#8fd8a8;flex:1}
  .sm.api{color:#4ade80}
  .sf{font-family:Consolas,monospace;color:#4da3ff;font-weight:700}
  .sf em{font-style:normal;font-size:10.5px;color:#5d7285;margin-left:1px}
  .swhy{color:#6b8098;font-size:11.5px;flex-basis:100%;padding-left:83px;margin-top:-2px}
  .losers{padding:8px 16px 14px;color:#7f93a8;font-size:12px}
  .loswhy{color:#5d7285;margin-left:6px}

  /* 模型表 */
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th,td{padding:9px 11px;border-bottom:1px solid #1e2836;vertical-align:top;text-align:left}
  th{background:#16202c;color:#8fc7ff;font-size:12px;font-weight:600;position:sticky;top:0}
  tr:hover td{background:#101720}
  .mname{white-space:nowrap}
  .mname b{color:#e8f1fb;display:block;margin-bottom:3px}
  .traits{display:grid;grid-template-columns:1fr 1fr;gap:1px 12px;min-width:250px}
  .tr{display:flex;align-items:center;gap:6px;font-size:11px}
  .tr em{color:#6b8098;font-style:normal;width:48px;text-align:right;flex-shrink:0}
  .bar{position:relative;display:inline-flex;align-items:center;width:62px;height:11px;background:#1a2432;border-radius:3px;overflow:hidden}
  .bar i{position:absolute;left:0;top:0;bottom:0;border-radius:3px;opacity:.75}
  .bar b{position:relative;font-size:10px;color:#dbe4ee;margin-left:auto;padding-right:3px;font-family:Consolas,monospace}
  .pros .p{color:#8fd8a8}
  .pros .c{color:#e3a2a2}
  .tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:4px;margin:0 3px 3px 0}
  .tag.best{background:#12241c;color:#4ade80;border:1px solid #2a4a38}
  .tag.avoid{background:#2a1416;color:#ff8080;border:1px solid #4a2a2c}
  .avoidline{color:#a3737a;font-size:11.5px;margin-top:3px}
  .note{color:#93a7bb;font-size:12px}

  /* 角色组 */
  .sets{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:12px}
  .setcard{background:#111820;border:1px solid #24303e;border-radius:9px;padding:13px 15px}
  .setcard h4{font-size:13.5px;color:#8fc7ff;margin-bottom:9px}
  .cnt{font-size:11px;color:#6b8098;font-family:Consolas,monospace;font-weight:400}
  ul.setlist{list-style:none}
  ul.setlist li{display:flex;gap:9px;align-items:baseline;padding:3px 0;font-size:12.3px;border-bottom:1px solid #16202c;flex-wrap:wrap}
  ul.setlist li b{color:#ffd479;min-width:78px}
  .floor{color:#e3a2a2;font-size:11.5px;font-family:Consolas,monospace}
  .wgt{color:#6b8098;font-size:11.5px}

  /* 编制变体 */
  .variants{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .var{background:#111820;border:1px solid #24303e;border-radius:9px;padding:12px 14px}
  .var h5{font-size:12.5px;color:#4da3ff;font-family:Consolas,monospace;margin-bottom:8px}
  .var .vr{display:flex;justify-content:space-between;gap:8px;font-size:12.3px;padding:2px 0}
  .var .vr span:first-child{color:#ffd479}
  .var .vr span:last-child{color:#8fd8a8;text-align:right}
  .varnote{color:#7f93a8;font-size:12.5px;margin-top:14px;line-height:1.8}
  .costnote{color:#9fb0c0;font-size:12.5px;line-height:1.9;background:#0d141d;border:1px solid #1a2430;
    border-left:3px solid #33455a;border-radius:6px;padding:12px 16px;margin-bottom:14px}
  .costnote b{color:#e8eef5}
  .mlink{color:#8fc7ff;text-decoration:none}
  .mlink:hover{text-decoration:underline}
  .varnote b{color:#4ade80}
</style>
</head>
<body>

<h1>通辽会议 · 8 个模式速查 &amp; 12 个模型能力档案</h1>
<div class="sub">先挑「我要干什么」，再挑模型——每个模式需要什么能力的模型、实际会选到谁，这一页全说完。</div>
<div class="src">数据来源：core/modes.js · core/models.js · core/roles.js · core/casting.js 实时计算生成
（选角种子 ${DEMO_SEED}，页面里每个分数都是引擎真跑出来的）</div>

<h2>第一步：我要干什么？<small>点一条直接跳到对应模式</small></h2>
<div class="wizard">
${WIZARD.map((w) => {
  const m = modes.find((x) => x.id === w.id);
  return `<a class="wiz" href="#mode-${w.id}"><b>${esc(m ? m.label : w.id)}</b><span>${esc(w.ask)}</span></a>`;
}).join('')}
</div>

<h2>第二步：${modes.length} 个模式，分别在什么时候用<small>含真实编制、阶段流程与成本</small></h2>
${modeData.map((d, i) => renderModeCard(d, i)).join('')}

<h2>第三步：这场会要烧多少？<small>点"开始会议"之前就该知道</small></h2>
<div class="costnote">
  两个指标都要看，缺一个就会误判：<br>
  · <b>调用次数</b> = 花在"次数"上的钱。<br>
  · <b>上下文注入份数</b> = 花在"字"上的钱 —— <b>这才是 O(N²) 的体现</b>：<br>
  　顺序接龙时第 k 个人要读前 k−1 份发言，人数翻倍、代价四倍。<br>
  <b>例：9 人的「专家会诊」只有 9 次调用（看着便宜），但注入 36 份 —— 它才是贵的那个。</b><br>
  下表按<b>各模式推荐角色组的实际席位数</b>估算（不是按 12 个模型全上）。
</div>
${(() => {
    const rows = modeData.map((d) => {
      const c = d.cost;
      const w = Math.min(100, Math.round((c.maxContext / 200) * 100));
      const color = c.tier === 'heavy' ? '#ff8080' : c.tier === 'medium' ? '#ffd479' : '#7fd8a0';
      return `<tr class="${c.tier === 'heavy' ? 'hi' : ''}">
        <td><a class="mlink" href="#mode-${d.mode.id}">${esc(d.mode.label)}</a></td>
        <td class="num">${c.participants}</td>
        <td class="num">${c.callsPerRound}</td>
        <td class="num">${c.rounds}</td>
        <td class="num"><b>${c.maxCalls}</b></td>
        <td class="num">${c.maxContext}<div class="mini"><i style="width:${w}%;background:${color}"></i></div></td>
        <td><span class="costtier ${TIER_CLS[c.tier]}">${TIER_CN[c.tier]}</span></td>
        <td class="cnote">${esc(c.advices[0])}</td>
      </tr>`;
    }).join('');
    return `<table class="costoverview">
      <thead><tr><th>模式</th><th class="num">席位</th><th class="num">单轮调用</th>
        <th class="num">轮数上限</th><th class="num">最坏调用</th><th class="num">最坏注入份数</th>
        <th>档位</th><th>主要开销 / 建议</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  })()}
<div class="varnote">
  <b>想省钱，按这个顺序动手</b>（从最有效到最笨）：<br>
  ① <b>减人</b> —— panel / debate 的成本随人数<b>平方</b>增长，9 人砍到 6 人比换模型有用得多。<br>
  ② <b>用 panelGroupSize 分组</b> —— 9 人分 3 组，会诊阶段的注入量从 36 份降到 9 份。<br>
  ③ <b>换轻档模式</b> —— 同样的问题，「协助」（15 次）比「招标评审」（75 次）便宜 5 倍。<br>
  ④ <b>别硬顶轮数上限</b> —— 循环模式的判据生效时会提前停；判据若"降级"（缺输入）才会跑满，界面上会红字告警。<br>
  ⚠ <b>「验证过了吗」不能算成 0 成本</b>：文本层判据（judgeBuildPass）只用来"承认失败"，
  自称"通过"一律不采信 —— 真判据必须来自真实编译/运行结果。
</div>

<h2>随机是假的吗？<small>同一角色组 product-9，三个不同种子</small></h2>
<div class="variants">
${castVariants.map((v) => `<div class="var">
  <h5>seed = ${esc(v.seed)}</h5>
  ${v.cast.assignment.map((a) => `<div class="vr"><span>${esc(a.label)}</span><span>${esc((getModel(a.providerId) || {}).label || a.providerId)}</span></div>`).join('')}
</div>`).join('')}
</div>
<div class="varnote">
  三套编制各不相同 —— 说明「随机」是真的在随机。<br>
  但<b>没有任何一套违反能力门槛</b>：红队位永远给推理≥4的、书记员位永远给速度≥4的。<br>
  机制是「<b>先按能力门槛一票否决，再在够格的人里按适配分加权随机</b>」——所以随机只发生在"够格的人之间"，不会出现错配。
</div>

<h2>第四步：12 个模型各自强在哪、弱在哪<small>八维能力是选角的唯一依据</small></h2>
<table>
  <thead><tr>
    <th style="width:170px">模型</th>
    <th style="width:290px">八维能力（1–5）</th>
    <th style="width:290px">优势 / 缺点</th>
    <th style="width:230px">最合适 / 要回避的角色</th>
    <th>会上注意事项</th>
  </tr></thead>
  <tbody>
  ${models.map(renderModelRow).join('')}
  </tbody>
</table>

<h2>第五步：角色组里每把椅子要什么能力<small>这是"门槛"的来源</small></h2>
<div class="sets">${sets.map(renderSetCard).join('')}</div>

</body>
</html>
`;

fs.writeFileSync(OUT, html, 'utf8');
console.log(`✔ 已生成 ${OUT}`);
console.log(`  模式 ${modes.length} 个 · 模型 ${models.length} 个 · 角色组 ${sets.length} 个 · 角色 ${Object.keys(ROLE_CATALOG).length} 个`);
console.log(`  文件大小 ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
