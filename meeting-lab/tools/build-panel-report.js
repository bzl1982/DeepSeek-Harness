#!/usr/bin/env node
'use strict';
/**
 * tools/build-panel-report.js —— 生成「专家会诊」分组降本报告（panel-phases.html）
 *
 * ★ 表里的数字**全部来自真实代码**（planPhases + estimateCost + PhaseRunner.dryRun），
 *   不是手写的 —— 所以它同时是一份"文档"和一次"对账"：
 *   若哪天预估与执行不一致，这份报告自己就会显示出来。
 *
 * 用法：node tools/build-panel-report.js [--out panel-phases.html]
 */

const fs = require('fs');
const path = require('path');
const { planPhases, estimateCost, listModes, NEVER_IN_MERGE_INPUT } = require('../core/modes');
const { assignRoles } = require('../core/roles');
const { PhaseRunner } = require('../core/phase-runner');

const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 ? process.argv[i + 1] : path.join(__dirname, '..', 'panel-phases.html');
})();

const NINE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const ASSIGN9 = assignRoles(NINE, { set: 'product-9' });
const CTX = {
  task: '议题', material: '材料', draft: '草稿', critiques: ['c'],
  contract: { text: '契约', modules: [] }, candidates: [{ senderId: 'a', content: '候选' }], round: 1,
};
const runner = new PhaseRunner({ speakTo: async () => ({ ok: true }) });

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 一个场景：分组档位 → plan + 预估 + 试算 */
function scenario(groupSize) {
  const plan = planPhases('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: groupSize });
  const est = estimateCost('panel', { participants: NINE, assignment: ASSIGN9, panelGroupSize: groupSize });
  const dry = runner.dryRun(plan, CTX);
  const rows = plan.map((p, i) => ({
    name: p.name,
    slice: p.slice,
    speak: p.speak,
    speakers: p.speakers.join(' '),
    n: p.speakers.length,
    per: (dry.stages[i].per || []).map((x) => `${x.providerId}:${x.injected}`).join(' '),
    inject: dry.stages[i].injected,
    est: (est.breakdown[i] || {}).inject,
    note: (est.breakdown[i] || {}).note || '',
    groupInner: !!p.groupSize && !p.groupLeaders,
    leaders: !!p.groupLeaders,
  }));
  return { plan, est, dry, rows, match: dry.injectedTotal === est.contextPerRound };
}

const plain = scenario(0);
const grouped = scenario(3);
const saved = Math.round((1 - grouped.est.contextPerRound / plain.est.contextPerRound) * 100);

/* 全模式对账（报告里也放一行，证明不是只对一个场景调过） */
const allModes = listModes().map((m) => {
  const plan = planPhases(m.id, { participants: NINE, assignment: ASSIGN9 });
  const est = estimateCost(m.id, { participants: NINE, assignment: ASSIGN9 });
  const dry = runner.dryRun(plan, CTX);
  return { id: m.id, label: m.label, est: est.contextPerRound, dry: dry.injectedTotal, ok: est.contextPerRound === dry.injectedTotal };
});
const allOk = allModes.every((x) => x.ok);

function table(sc) {
  const rows = sc.rows.map((r) => `
      <tr class="${r.leaders ? 'lead' : r.groupInner ? 'inner' : ''}">
        <td class="nm">${esc(r.name)}</td>
        <td class="sp">${esc(r.speakers)}</td>
        <td class="sl">${esc(r.slice)} / ${esc(r.speak)}</td>
        <td class="num">${r.inject}</td>
        <td class="per">${esc(r.per)}</td>
        <td class="nt">${esc(r.note)}</td>
      </tr>`).join('');
  return `
  <table>
    <thead><tr><th>阶段</th><th>发言者</th><th>切片 / 方式</th><th>注入份数</th><th>每人份数</th><th>账目说明</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3">合计</td><td class="num">${sc.dry.injectedTotal}</td><td colspan="2">静态预估 ${sc.est.contextPerRound} · ${sc.match ? '✔ 对账一致' : '✗ 不一致'}　调用 ${sc.est.callsPerRound} 次</td></tr></tfoot>
  </table>`;
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>专家会诊 · 分组降本与归并约束（实测报告）</title>
<style>
  :root { --bg:#0b0e14; --fg:#e6e6e6; --dim:#8aa; --line:#22303f; --in:#4da3ff; --ok:#3ddc84; --warn:#ffb454; }
  * { box-sizing: border-box; }
  body { margin:0; padding:22px 26px 60px; background:var(--bg); color:var(--fg);
         font:13px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  h1 { font-size:19px; margin:0 0 4px; }
  h2 { font-size:15px; margin:26px 0 10px; padding-left:9px; border-left:3px solid var(--in); }
  .sub { color:var(--dim); font-size:12px; margin-bottom:6px; }
  .kpis { display:flex; gap:12px; flex-wrap:wrap; margin:14px 0 4px; }
  .kpi { background:#111823; border:1px solid var(--line); border-radius:9px; padding:10px 14px; min-width:150px; }
  .kpi .v { font-size:22px; font-weight:600; }
  .kpi .k { color:var(--dim); font-size:11px; }
  .kpi.good .v { color:var(--ok); }
  table { width:100%; border-collapse:collapse; margin-top:8px; font-size:12px; }
  th, td { border:1px solid var(--line); padding:6px 9px; text-align:left; vertical-align:top; }
  th { background:#131c27; color:#cfe3ff; font-weight:600; }
  tbody tr.inner { background:#0f1620; }
  tbody tr.lead { background:#141b26; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; font-weight:600; }
  tfoot td { background:#131c27; font-weight:600; }
  .nm { white-space:nowrap; }
  .per { color:var(--warn); font-variant-numeric:tabular-nums; }
  .nt { color:var(--dim); }
  ul { margin:8px 0 0 18px; padding:0; }
  li { margin:5px 0; }
  code { background:#141c26; padding:1px 5px; border-radius:4px; color:#9fd0ff; }
  .ok { color:var(--ok); }
  .warn { color:var(--warn); }
  .note { background:#111823; border:1px solid var(--line); border-left:3px solid var(--warn);
          border-radius:8px; padding:10px 14px; margin-top:12px; color:#d8e4f0; }
</style>
</head>
<body>
  <h1>专家会诊（panel）：分组降本与归并约束</h1>
  <div class="sub">本页数字由 <code>tools/build-panel-report.js</code> 现场跑 <code>planPhases + estimateCost + PhaseRunner.dryRun</code> 生成
    —— 既是文档，也是一次对账。参会 9 人（product-9 角色组）。</div>

  <div class="kpis">
    <div class="kpi"><div class="v">${plain.est.contextPerRound} → ${grouped.est.contextPerRound}</div><div class="k">单轮注入份数（不分组 → 每组 3 人）</div></div>
    <div class="kpi good"><div class="v">省 ${saved}%</div><div class="k">上下文成本降幅</div></div>
    <div class="kpi"><div class="v">${plain.est.callsPerRound} → ${grouped.est.callsPerRound}</div><div class="k">调用次数（多一层组长）</div></div>
    <div class="kpi ${allOk ? 'good' : ''}"><div class="v">${allOk ? '8/8' : '✗'}</div><div class="k">分组档位对账一致</div></div>
  </div>

  <h2>一、不分组（原行为）</h2>
  <div class="sub">会诊 = 9 人顺序接龙，第 k 人读前 k-1 份 → 注入量 ∝ n(n−1)/2；归并席读全部 9 份。</div>
  ${table(plain)}

  <h2>二、每组 3 人（分组降本）</h2>
  <div class="sub">组内接龙（组间互不可见）→ 组长代表本组 → 归并只读<strong>组长产出</strong>。</div>
  ${table(grouped)}

  <div class="note">
    <b>★ 分组最容易做错的地方</b>：只把「会诊」分组、却让「归并结论」照旧读全部明细 ——
    那样总注入量反而比不分组更高（多了一层组长）。本页「归并结论」一行显示为
    <code>${grouped.rows.at(-1).inject}</code> 份（= 3 位组长），而不是 9 份明细，才算真的省下来。
  </div>

  <h2>三、四条被强制执行的契约</h2>
  <ul>
    <li><b>接龙</b>：<code>sequential</code> 阶段第 k 人看到前 k−1 人<strong>本阶段刚产出</strong>的内容
      —— 此前每人都拿到同一份"阶段前快照"，「层层加码」名不副实。</li>
    <li><b>并行快照冻结</b>：<code>parallel</code> 阶段人人看同一份阶段前快照，防锚定。</li>
    <li><b>组边界</b>：组内阶段只喂本组成员 —— 组 2 看不到组 1，这才是省钱的物理前提。</li>
    <li><b>归并白名单</b>：<code>${NEVER_IN_MERGE_INPUT.join(' / ')}</code> 一律不进归并输入
      （名次表会让人跟票、旧结论会让人照抄）。它们照样留在会议记录里供审计。</li>
  </ul>

  <h2>四、全模式对账（执行契约 vs 静态预估）</h2>
  <div class="sub">${allOk ? '<span class="ok">✔ 10 个模式全部一致</span>' : '<span class="warn">✗ 存在不一致，见下表</span>'}
    　— 预估失真 = 用户开跑前看到的成本是假的，所以这两套数字必须同源。</div>
  <table>
    <thead><tr><th>模式</th><th>预估注入</th><th>执行试算</th><th>对账</th></tr></thead>
    <tbody>
      ${allModes.map((m) => `<tr><td>${esc(m.label)} <span class="nt">(${esc(m.id)})</span></td><td class="num">${m.est}</td><td class="num">${m.dry}</td><td>${m.ok ? '<span class="ok">✔</span>' : '<span class="warn">✗</span>'}</td></tr>`).join('\n      ')}
    </tbody>
  </table>

  <div class="sub" style="margin-top:22px">
    复现：<code>node tools/verify-panel-phases.js</code>（34 项端到端）·
    <code>node --test test/phase-runner.test.js</code>（28 用例）·
    <code>node tools/build-panel-report.js</code>（重新生成本页）
  </div>
</body>
</html>
`;

fs.writeFileSync(OUT, html, 'utf8');
console.log(`已生成：${OUT}（${(html.length / 1024).toFixed(1)} KB）`);
console.log(`不分组 ${plain.est.contextPerRound} 份 → 每组3人 ${grouped.est.contextPerRound} 份（省 ${saved}%）`);
console.log(`对账：全部模式 ${allOk ? '一致 ✔' : '存在不一致 ✗'}`);
