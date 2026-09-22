/**
 * 验证第五轮接线在**渲染进程**里真的可用（不只是 Node 端单测通过）。
 *
 * 检查：
 *   ① 新函数是否都 import 成功（parseBallots / bordaMeans / estimateCost / anonymizeCandidates / judgeBuildPass / buildVerdictPrompt）
 *   ② 在页面里跑一遍**完整评审链路**：候选 → 匿名 → 模拟评标文本 → 解析 → Borda → 胜出
 *   ③ 成本预估在真实席位列表下能算出数
 */
const http = require('http');

const PORT = process.argv[2] || '9223';

function getJson(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

(async () => {
  const list = await getJson('/json/list');
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return `ERR: ${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`;
    return r.result.result.value;
  };

  let pass = 0; let fail = 0;
  const check = (name, ok, detail) => {
    if (ok) pass += 1; else fail += 1;
    console.log(`  ${ok ? '✔' : '✗'} ${name}`);
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
  };

  /* ① 新函数是否都挂上了（在页面上下文里 require 一次，路径按页面文件解析） */
  console.log('── ① 渲染进程里新函数可用性 ──');
  const api = await ev(`(() => {
    try {
      const m = require('D:/DeepSeek Harness/meeting-lab/core/modes');
      const need = ['parseBallots','bordaMeans','estimateCost','anonymizeCandidates','judgeBuildPass','buildVerdictPrompt','costOverview','anonLabel','fnv1a','SLICE'];
      const miss = need.filter(k => m[k] === undefined);
      return { ok: miss.length === 0, miss, sliceCandidates: m.SLICE && m.SLICE.CANDIDATES };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);
  check('modes.js 的第五轮新函数全部导出', api && api.ok,
    api && api.ok ? `SLICE.CANDIDATES = "${api.sliceCandidates}"` : JSON.stringify(api));

  /* ② 在页面里跑完整评审链路（纯函数，不发请求） */
  console.log('\n── ② 页面内跑完整评审链路（候选→匿名→解析→Borda）──');
  const pipeline = await ev(`(() => {
    const m = require('D:/DeepSeek Harness/meeting-lab/core/modes');
    // 模拟三名出标者产出的候选（已带 kind）
    const msgs = [
      { senderId: 'deepseek-web', content: '方案甲：用进程内反向代理，复用现有 http 服务', kind: 'candidate' },
      { senderId: 'gemini-web',   content: '方案乙：起独立容器做网关，配置更清晰', kind: 'candidate' },
      { senderId: 'chatgpt-web',  content: '方案丙：改成插件中间件，随主进程加载', kind: 'candidate' },
    ];
    const a = m.selectSlice(m.SLICE.CANDIDATES, { messages: msgs, selfId: 'deepseek-web' });
    const b = m.selectSlice(m.SLICE.CANDIDATES, { messages: msgs, selfId: 'gemini-web' });
    // 两名评审者（一人用列表格式、一人用 JSON；排的是**匿名标签**，不是候选正文里的"方案甲"）
    const parsed = m.parseBallots([
      { reviewer: 'r1', text: '1. 方案A\\n2. 方案C\\n3. 方案B' },
      { reviewer: 'r2', text: '{"方案A": 1, "方案B": 3, "方案C": 2}' },
    ], { labels: a.included });
    const borda = m.bordaMeans(parsed.ballots);
    return {
      // 关键断言：不同评审者看到同一份候选包
      sameForBoth: a.text === b.text,
      labels: a.included.join('/'),
      noRealNames: !a.text.includes('deepseek-web') && !a.text.includes('gemini-web'),
      parsedOk: parsed.ballots.length,
      coverage: JSON.stringify(borda.coverage),
      comparable: borda.comparable,
      winner: borda.winnerId,
      winnerAuthor: a.map[borda.winnerId],
      warning: borda.warning,
    };
  })()`);
  if (pipeline && !pipeline.startsWith && pipeline.labels) {
    check('所有评审者看到同一份匿名候选包', pipeline.sameForBoth, `标签：${pipeline.labels}`);
    check('候选包不含真实模型名（匿名有效）', pipeline.noRealNames);
    check('两份名次表都解析成功', pipeline.parsedOk === 2, `coverage=${pipeline.coverage}`);
    check('完整排序 → Borda 可比', pipeline.comparable === true && !pipeline.warning);
    /* ★ 这里不能断言"方案A 是哪家" —— 标签按**内容哈希**排序，与作者无关，
     *   这正是匿名有效性的证明。只断言"能映射回一个真实作者且映射不暴露在 prompt 里"。 */
    check('胜出者能映射回真实作者（供跨轮比较，且标签无法反推作者）',
      !!pipeline.winnerAuthor && ['deepseek-web', 'gemini-web', 'chatgpt-web'].includes(pipeline.winnerAuthor),
      `${pipeline.winner} → ${pipeline.winnerAuthor}（标签由内容哈希定序，与作者无关 → 匿名有效）`);
  } else {
    check('页面内跑完整评审链路', false, JSON.stringify(pipeline));
  }

  /* ③ 定标 prompt 与成本预估 */
  console.log('\n── ③ 定标 prompt + 成本预估 ──');
  const extras = await ev(`(() => {
    const m = require('D:/DeepSeek Harness/meeting-lab/core/modes');
    const borda = m.bordaMeans([
      { reviewer: 'r1', ranks: [{ proposal: '方案甲', rank: 1 }, { proposal: '方案乙', rank: 2 }] },
      { reviewer: 'r2', ranks: [{ proposal: '方案甲', rank: 1 }, { proposal: '方案乙', rank: 2 }] },
    ]);
    const p = m.buildVerdictPrompt({ candidates: '【方案甲】…\\n\\n【方案乙】…', borda });
    const cost = m.estimateCost('tournament', { participants: ['a','b','c','d','e'] });
    const costBuild = m.estimateCost('build', { participants: ['a','b','c','d','e'] });
    const bp = m.judgeBuildPass('所有模块集成完毕，测试全部通过，可以交付了');
    return {
      promptHasBorda: p.includes('Borda 均值'),
      promptNoFreeVote: p.includes('不是重新投票'),
      tournamentTier: cost.tier, tournamentCalls: cost.maxCalls,
      buildTier: costBuild.tier,
      selfClaimNotTrusted: bp.pass === null,
    };
  })()`);
  if (extras && !extras.startsWith) {
    check('定标 prompt 喂了 Borda 均值表', extras.promptHasBorda);
    check('定标 prompt 明确"不是重新投票"', extras.promptNoFreeVote);
    check('成本预估在页面里能算（tournament）', extras.tournamentTier === 'heavy',
      `tier=${extras.tournamentTier} 最坏 ${extras.tournamentCalls} 次调用`);
    check('build 模式被标为最贵档', extras.buildTier === 'heavy');
    check('★ 模型自述"通过"不被采信（拿不到真实编译结果就判未知）', extras.selfClaimNotTrusted);
  } else {
    check('定标 prompt + 成本预估', false, JSON.stringify(extras));
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`接线验证：${pass}/${pass + fail} 项通过`);
  console.log('════════════════════════════════════════════════════════════');
  ws.close();
  process.exit(fail ? 1 : 0);
})();
