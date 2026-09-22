'use strict';
/**
 * tools/verify-build-ui.js —— 在**真实测试台页面**里验证 build 模式的产物接线
 *
 * 核心逻辑（解析/落盘/真编译/判定）由这个脚本证明不了 —— 那是
 * tools/verify-build-artifacts.js（走真 orchestrator 全链路）与三个单测的职责。
 * 本脚本只管**页面这一层**：
 *   · ⓪ 窗口里跑的是不是**当前磁盘上的**代码（require 是加载时解析的，改了 core 不重载＝还在跑旧代码）
 *   · 产物验证档位下拉在 build 模式下出现、别的模式下隐藏（别的模式不产生文件，显示了只会误导）
 *   · 三个档位都在，默认是最安全的「语法 + 引用完整性」
 *   · 切到「会执行代码」那一档时，日志里有明确的风险提示（安全性质不同，必须让人看见）
 *   · build 模式的流程条能正常渲染出「分头实现 / 集成验证」这些产物阶段
 *   · 全程渲染进程零异常
 *
 * ★ 幂等：只读 DOM + 派发 change 事件，不改动页面状态以外的任何东西；跑完把模式复位。
 *
 * 用法：node tools/verify-build-ui.js 9223
 */

const http = require('http');

const PORT = Number(process.argv[2]) || 9223;

let pass = 0; let fail = 0; const failed = [];
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✔ ${name}${detail ? `　${detail}` : ''}`); }
  else { fail += 1; failed.push(name); console.log(`  ✗ ${name}${detail ? `　${detail}` : ''}`); }
}
function section(t) { console.log(''); console.log(`── ${t} ──`); }

const get = (p) => new Promise((res, rej) => http.get(
  { host: '127.0.0.1', port: PORT, path: p },
  (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(JSON.parse(d))); },
).on('error', rej));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await get('/json/list');
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('没找到测试台页面（index.html）—— 测试台在跑吗？');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; setTimeout(() => j(new Error('ws 连接超时')), 8000); });

  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params) => new Promise((r) => {
    const i = ++id; pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); r({ __timeout: true }); } }, 15000);
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.__timeout) return '【评估超时】';
    if (r.result && r.result.exceptionDetails) {
      return `【异常】${((r.result.exceptionDetails.exception || {}).description || '').slice(0, 200)}`;
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  console.log('build 模式 UI 接线验证（真实测试台页面，端口 ' + PORT + '）');

  section('⓪ 窗口里跑的是不是**当前磁盘上的**代码');

  /* ★ 为什么要有这一节：
   *   require 是**加载时**解析的。改了 core/ 下的文件而没重载页面，窗口里跑的还是旧代码 ——
   *   "看着改了、其实没生效"极容易被带沟里（本轮就撞上过：修好解析器后跑着的窗口仍用旧解析器）。
   *   所以拿页面上的 __coreStamp（各核心文件的 sha256 前 12 位）跟磁盘对一遍。
   *   不一致就自动重载一次再对 —— 顺带证明「重载真的会重新 require 核心代码」（不只是重取 HTML）。 */
  const crypto = require('crypto');
  const fs = require('fs');
  const nodePath = require('path');
  const diskHash = {};
  for (const rel of ['artifact-bus', 'build-verify', 'build-loop', 'phase-runner', 'modes', 'orchestrator']) {
    const p = nodePath.join(__dirname, '..', 'core', `${rel}.js`);
    diskHash[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
  }
  const readStamp = async () => {
    const s = await ev('JSON.stringify(window.__coreStamp||{})');
    try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
  };
  const waitReady = async () => {
    for (let i = 0; i < 20; i += 1) {
      await sleep(300);
      const ok = await ev("!!document.getElementById('sel-mode')");
      if (ok === true) return true;
    }
    return false;
  };
  const diffOf = (stamp) => Object.keys(diskHash).filter((k) => stamp[k] !== diskHash[k]);

  let stamp = await readStamp();
  let stale = diffOf(stamp);
  let reloaded = false;
  if (stale.length) {
    await send('Page.reload', { ignoreCache: true });
    await waitReady();
    stamp = await readStamp();
    stale = diffOf(stamp);
    reloaded = true;
  }
  check('页面就绪（发现陈旧代码时会自动重载 —— 重载是让 core 改动生效的唯一办法）',
    await ev("!!document.getElementById('sel-mode')") === true,
    reloaded ? '本次发生过重载' : '本次本来就一致，未重载');
  check('★ 窗口里的核心模块与磁盘完全一致（require 真的会重新解析，不是只重取 HTML）',
    stale.length === 0, stale.length ? `不一致：${stale.join('、')} —— 请重载页面` : `${Object.keys(diskHash).length} 个文件指纹全等`);
  check('指纹机制本身可用（不是全都 undefined 造成的假通过）',
    !stamp.__error && Object.keys(stamp).length === Object.keys(diskHash).length,
    stamp.__error ? `采集出错：${stamp.__error}` : `采到 ${Object.keys(stamp).length} 个`);

  /* ---------- ① 先记下当前模式，用于跑完复位 ---------- */
  const originalMode = await ev("document.getElementById('sel-mode').value");

  const setMode = async (m) => {
    await ev(`(()=>{const s=document.getElementById('sel-mode');s.value=${JSON.stringify(m)};s.dispatchEvent(new Event('change'));return 1;})()`);
    await sleep(400);
  };

  section('① 档位下拉：build 模式显示，别的模式隐藏');

  await setMode('broadcast');
  const dispBroadcast = await ev("document.getElementById('lbl-buildlevel').style.display");
  check('非 build 模式下档位下拉隐藏（别的模式不产生文件，显示了只会误导）',
    dispBroadcast === 'none', `display=${dispBroadcast}`);

  await setMode('build');
  const dispBuild = await ev("document.getElementById('lbl-buildlevel').style.display");
  check('★ build 模式下档位下拉出现', dispBuild !== 'none' && dispBuild !== undefined, `display="${dispBuild}"`);

  const opts = await ev("JSON.stringify(Array.from(document.getElementById('sel-buildlevel').options).map(o=>[o.value,o.textContent]))");
  const parsed = JSON.parse(opts || '[]');
  check('三个档位都在（仅语法 / 语法+引用 / 再跑构建）', parsed.length === 3, parsed.map((x) => x[0]).join(' · '));
  check('★ 默认档位是「语法 + 引用完整性」（最安全的那一档）',
    await ev("document.getElementById('sel-buildlevel').value") === 'static');
  check('「会执行代码」那一档在文案上就标了风险（★ 前缀）',
    /★/.test((parsed.find((x) => x[0] === 'build') || [])[1] || ''));

  section('② 切到「会执行代码」档 → 必须给出明确风险提示');

  await ev("document.getElementById('btn-clear').click()");
  await ev(`(()=>{const s=document.getElementById('sel-buildlevel');s.value='build';s.dispatchEvent(new Event('change'));return 1;})()`);
  await sleep(300);
  const logAfter = String(await ev("document.getElementById('log').innerText"));
  check('★ 明确告知"会在本机执行 AI 写的代码"',
    /执行.*AI.*写的代码|执行 AI 写的代码|在本机执行 AI 写的代码/.test(logAfter),
    (logAfter.split('\n').find((l) => /执行/.test(l)) || '').slice(0, 60));
  check('同时提示"前两档是纯静态检查、日常建议用它们"',
    /纯静态|不执行任何/.test(logAfter));

  // 复位到默认档
  await ev(`(()=>{const s=document.getElementById('sel-buildlevel');s.value='static';s.dispatchEvent(new Event('change'));return 1;})()`);
  await sleep(200);
  const logStatic = String(await ev("document.getElementById('log').innerText"));
  check('切回静态档也有对应提示（不执行 AI 写的代码）',
    /纯静态|不执行任何/.test(logStatic));

  section('③ build 模式的流程条能渲染出产物阶段');

  const flow = String(await ev("document.getElementById('flow').innerText"));
  check('流程条含「分头实现」（产物阶段）', flow.includes('分头实现'));
  check('流程条含「集成验证」', flow.includes('集成验证'));
  check('流程条含「冻结契约」', flow.includes('冻结契约'));
  const scene = String(await ev("document.getElementById('scene').innerText"));
  check('场景卡把"产物是文件而不是文本"讲清楚了',
    /产物|文件/.test(scene), scene.split('\n').find((l) => /产物/.test(l)) ? '有产物说明' : '');

  section('④ 渲染进程零异常');

  const errs = await ev("JSON.stringify(window.__errs || [])");
  check('重载至今没有未捕获异常', String(errs) === '[]' || String(errs) === 'undefined', String(errs).slice(0, 120));

  /* ══════════════════════════════════════════════════════════════════
     ⑤ --live：真的启动一次 build 会议，看工作区建在哪儿
     ★ 这一步验证的是本轮**最需要防的事故**：
       工作区一旦配成项目目录，AI 吐的 index.html / package.json 会直接
       覆盖 meeting-lab 自己的源码。所以只读日志不够，要看到真实路径。
     ★ 有副作用（会真的给网页 AI 发一条消息），所以默认不跑，要 --live。
        验证完立刻 reload 页面中断整场会议。
     ══════════════════════════════════════════════════════════════════ */
  if (process.argv.includes('--live')) {
    section('⑤ 真实启动 build 会议：工作区建在系统临时目录（不是项目目录）');

    await setMode('build');
    await ev("document.getElementById('btn-clear').click()");
    await ev("document.getElementById('btn-run').click()");
    await sleep(2000);   // 建工作区 + 打日志是同步的，2 秒足够

    const liveLog = String(await ev("document.getElementById('log').innerText"));
    const m = liveLog.match(/\[产物工作区\]\s*(.+)/);
    check('★ 启动后真的建了产物工作区', !!m, m ? m[1].trim() : '日志里没找到');
    const p = m ? m[1].trim() : '';
    check('★ 路径在系统临时目录下（绝不在项目目录里）',
      /temp|tmp/i.test(p) && !/DeepSeek Harness/i.test(p), p || '(空)');
    check('路径带 dsh-build- 前缀（一眼能认出来是开会产物，不会跟别的东西混）',
      /dsh-build-/.test(p));
    check('档位提示也打出来了（让用户知道这次会不会执行代码）',
      /验证档位/.test(liveLog));

    /* ★ 立刻中断整场会议：reload 会终止 renderer 的 JS 执行 */
    await send('Page.reload', { ignoreCache: true });
    console.log('     （已 reload 页面中断会议）');

    /* reload 之后没人会去清理刚建的工作区（开会正常结束时也不会自动删 ——
     * 那是留给用户看产物的），所以这里顺手清掉，免得每跑一次 --live 留一个空目录。 */
    if (p) {
      try {
        require('fs').rmSync(p, { recursive: true, force: true });
        console.log('     （已清理临时工作区）');
      } catch (e) { /* 清不掉也无妨，它就是个临时目录 */ }
    }
  } else {
    section('⑤ 真实启动（跳过）');
    console.log('     加 --live 才会真的开一场 build 会议（会发消息给网页 AI），日常不必跑');
  }

  /* ---------- 复位：别把页面留在 build 模式 ---------- */
  const live = process.argv.includes('--live');
  if (!live) {
    await setMode(originalMode || 'broadcast');
    await ev("document.getElementById('btn-clear').click()");
  }
  console.log('');
  console.log('═'.repeat(64));
  console.log(`检查结果：${pass} 通过 / ${fail} 失败`);
  if (fail) failed.forEach((n) => console.log(`  · ${n}`));
  ws.close();
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.log('脚本异常：' + (e && e.stack));
  process.exitCode = 2;
});
