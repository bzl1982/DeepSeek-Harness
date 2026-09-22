#!/usr/bin/env node
'use strict';
/**
 * tools/verify-shell.js —— 测试台自检（CDP 无头驱动，不需要人肉点）
 *
 * 解决的问题：
 *   改 shell/index.html 后，"看起来没接线"和"脚本崩溃"在截图上一模一样。
 *   本项目就踩过：renderApiSeats() 里踩 TDZ，顶层抛异常 → 整个 renderer 一行不执行，
 *   表现却是"下拉为空、场景卡空白"，非常像没写完。
 *   所以每次改完测试台，跑这个脚本，它会自己重载页面并逐项断言。
 *
 * 用法：
 *   node tools/verify-shell.js [端口=9223] [--shot 输出png]
 *
 * 检查项：
 *   1. 渲染进程零异常（重载后收集 Runtime.exceptionThrown）
 *   2. 模式下拉 / 角色组下拉 option 数量正确且非空
 *   3. 场景卡渲染（含"什么时候用"等四要素）
 *   4. 流程条渲染
 *   5. API 席位行可见性 + 勾选器状态
 *   6. 连点「重排角色」3 次：徽章数量必须等于编制席位数，且无同名角色
 *      （这条是抓"落选席位徽章没清空 → 看着像两个架构师"的回归）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const PORT = argv.find((a) => /^\d+$/.test(a)) || '9223';
const shotIdx = argv.indexOf('--shot');
const SHOT = shotIdx >= 0 ? argv[shotIdx + 1] : null;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✔' : '  ✘'} ${name}${detail ? `\n      ${detail}` : ''}`);
}

function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

(async () => {
  let list;
  try {
    list = await get('/json/list');
  } catch (e) {
    console.error(`连不上 127.0.0.1:${PORT} —— 测试台没在跑？\n启动：与 desktop/node_modules 同级执行 electron . --remote-debugging-port=${PORT}`);
    process.exit(1);
  }
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) { console.error('没找到测试台页面（index.html）'); process.exit(1); }

  console.log(`目标：${page.title}`);
  console.log(`URL ：${decodeURIComponent(page.url)}\n`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const exceptions = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exceptions.push((d.exception && d.exception.description ? d.exception.description : d.text).split('\n').slice(0, 4).join(' / '));
    }
  };
  await new Promise((r) => ws.onopen = r);
  await send('Runtime.enable'); await send('Page.enable');

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      return { __err: r.result.exceptionDetails.exception.description };
    }
    return r.result.result.value;
  };
  const NL = 'String.fromCharCode(10)';

  console.log('── 重载页面（清空历史异常，看它自己能不能跑起来）──');
  await send('Page.bringToFront');          // 自检完把测试台窗口带到前台，方便肉眼复核
  await send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4500));

  /* 1. 零异常 */
  check('渲染进程零异常', exceptions.length === 0,
    exceptions.length ? exceptions.join('\n      ') : '重载后未抛出任何异常');

  /* 2. 下拉 */
  const modeOpts = await ev(`document.getElementById('sel-mode').children.length`);
  const setOpts = await ev(`document.getElementById('sel-set').children.length`);
  check('模式下拉已填充', modeOpts >= 8, `${modeOpts} 个模式`);
  check('角色组下拉已填充', setOpts >= 6, `${setOpts} 个角色组`);

  /* 3. 场景卡 */
  const scene = await ev(`document.getElementById('scene').innerText`);
  const sceneOk = typeof scene === 'string' && scene.includes('什么时候用') && scene.includes('产出');
  check('场景卡渲染完整', sceneOk,
    typeof scene === 'string' ? `首行：${scene.split('\n')[0].slice(0, 70)}` : String(scene));

  /* 4. 流程条 */
  const flow = await ev(`document.getElementById('flow').innerText`);
  check('流程条渲染', typeof flow === 'string' && flow.includes('流程：'),
    typeof flow === 'string' ? `阶段数：${flow.split('\n').length - 1}` : String(flow));

  /* 5. API 席位行 */
  const api = await ev(`(()=>{const e=document.getElementById('apirow');const cs=getComputedStyle(e);
    return {cls:e.className,display:cs.display,cells:e.querySelectorAll('.apicell').length,
    checks:Array.from(e.querySelectorAll('input[type=checkbox]')).map(i=>i.checked?1:0).join('')};})()`);
  const apiOk = api && typeof api === 'object' && (api.display === 'flex' ? api.cells > 0 : true);
  check('API 席位行状态自洽', apiOk,
    api && typeof api === 'object'
      ? `class="${api.cls}" display=${api.display} 席位=${api.cells} 勾选=[${api.checks}]`
      : String(api));

  /* 6. 徽章一致性（连点重排 3 次） */
  const badgeExpr = 'JSON.stringify(Array.from(document.querySelectorAll("[data-role]")).map(e=>e.textContent||"(空)"))';
  const asgExpr = 'JSON.stringify(assignment.map(a=>a.label))';
  /* 编制详情要带上"谁坐这把椅子"，否则三次输出全是"架构师/红队/主持助理"，
   * 看不出重排到底有没有换人（角色名是固定的，人才是变的）。 */
  const whoExpr = 'JSON.stringify(assignment.map(a=>a.label+" ← "+((getModel(a.providerId)||{}).label||a.providerId)))';
  let badgeOk = true; const badgeDetail = []; const casts = [];
  for (let i = 1; i <= 3; i++) {
    await ev('document.getElementById("btn-recast").click()');
    await new Promise((r) => setTimeout(r, 350));
    const b = JSON.parse(await ev(badgeExpr));
    const a = JSON.parse(await ev(asgExpr));
    const who = JSON.parse(await ev(whoExpr));
    casts.push(who.join(' | '));
    const nonEmpty = b.filter((x) => x !== '(空)');
    const dup = nonEmpty.length !== new Set(nonEmpty).size;
    const countOk = nonEmpty.length === a.length;
    const sameSet = [...nonEmpty].sort().join() === [...a].sort().join();
    if (dup || !countOk || !sameSet) {
      badgeOk = false;
      badgeDetail.push(`第${i}次：徽章[${nonEmpty.join(',')}] vs 编制[${a.join(',')}]`
        + `${dup ? ' ★有重复' : ''}${!countOk ? ` ★数量不符(${nonEmpty.length}≠${a.length})` : ''}`
        + `${!sameSet ? ' ★内容不符' : ''}`);
    } else {
      badgeDetail.push(`第${i}次：${who.join(' / ')}`);
    }
  }
  check('徽章与编制逐次一致（无残留、无重复）', badgeOk, badgeDetail.join('\n      '));

  /* 顺带报告：三次重排是否真的换过人（随机性活着没有） */
  const distinct = new Set(casts).size;
  check('重排角色真的会换人（随机性活着）', distinct > 1,
    distinct > 1 ? `3 次重排产生 ${distinct} 种不同编制` : `3 次重排编制完全相同 —— 随机可能失效（seed 没变？）`);

  /* 模式切换遍历 */
  const modeNames = JSON.parse(await ev(`JSON.stringify(Array.from(document.getElementById('sel-mode').options).map(o=>o.value))`));
  let modeOk = true; const modeDetail = [];
  for (const mid of modeNames) {
    await ev(`(()=>{const s=document.getElementById('sel-mode');s.value="${mid}";s.dispatchEvent(new Event("change"));return 1;})()`);
    await new Promise((r) => setTimeout(r, 220));
    const sc = await ev(`document.getElementById('scene').innerText`);
    const fl = await ev(`document.getElementById('flow').innerText`);
    const good = typeof sc === 'string' && sc.includes('什么时候用') && typeof fl === 'string' && fl.includes('流程：');
    if (!good) { modeOk = false; modeDetail.push(`「${mid}」渲染不全`); }
  }
  check(`全部 ${modeNames.length} 个模式切换后场景卡+流程条都正常`, modeOk,
    modeOk ? modeNames.join('、') : modeDetail.join('；'));

  /* 收尾：复位到第一个模式 + 截图 */
  await ev(`(()=>{const s=document.getElementById('sel-mode');s.value="${modeNames[0]}";s.dispatchEvent(new Event("change"));return 1;})()`);
  await new Promise((r) => setTimeout(r, 400));

  if (SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log(`\n截图已存 ${SHOT}`);
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`自检结果：${passed}/${results.length} 项通过`);
  console.log('═'.repeat(60));
  ws.close();
  process.exit(passed === results.length ? 0 : 2);
})().catch((e) => { console.error('自检脚本异常：', e); process.exit(1); });
