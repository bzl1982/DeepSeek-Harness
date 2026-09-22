'use strict';
/**
 * tools/verify-build-artifacts.js —— build 模式端到端验证（产物真落盘 + 真编译）
 *
 * 与三个单测文件的分工：
 *   test/artifact-bus.test.js   解析与落盘（纯逻辑 + 真磁盘）
 *   test/build-verify.test.js   真编译验证（真子进程）
 *   test/build-loop.test.js     流水线组装
 *   ★ 本脚本走**真 MeetingOrchestrator + 真 PhaseRunner**（完整链路：
 *     speakTo → 附件握手 → 完成检测 → 写回会议记录），把整场 build 会议跑一遍，
 *     用**假 adapter 演一个必然失败的交付**，证明三件事：
 *
 *   ① 契约真的被执行了 —— 契约文本被解析成 modules，「分头实现」时每个人
 *      收到的 prompt 里点名了"你要交哪个文件"；
 *   ② 产物真的落到了磁盘 —— 不是内存记录，是 walk() 读出来的文件；
 *   ③ ★ 真编译抓到错，且**"AI 说自己全通过了"不能翻案** ——
 *      这是 judgeBuildPass 一直等着的那条"真实执行结果"的路。
 *      第 4 阶段让集成席故意回一句"我已全部检查通过，可以交付"，verdict 必须仍是 false。
 *
 * 最后闭环到 shouldStop('build', {buildPass})：判据不再 degraded（此前永远缺输入，
 * 会议只能跑满 4 轮 —— 与 winnerId 那个坑同族）。
 *
 * ★ 幂等：每次运行都新建 Meeting / adapter / 临时工作区，可反复跑。
 *
 * 用法：
 *   node tools/verify-build-artifacts.js            # 全部检查，跑完清理工作区
 *   node tools/verify-build-artifacts.js --keep     # 保留工作区以便人工查看产物
 *   node tools/verify-build-artifacts.js --verbose  # 打印每份产物的路径与大小
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Meeting } = require('../core/meeting-model');
const { MeetingOrchestrator } = require('../core/orchestrator');
const { PhaseRunner, FILE_PRODUCING } = require('../core/phase-runner');
const { planPhases, shouldStop, judgeBuildPass } = require('../core/modes');
const { assignRoles } = require('../core/roles');
const { makeFakeAdapter } = require('../test/helpers/fake-adapter');

const { ArtifactStore } = require('../core/artifact-bus');
const { verdictLine } = require('../core/build-verify');
const {
  CONTRACT_TEMPLATE, contractFor, artifactPromptFor, collectStageArtifacts,
  verifyWorkspace, buildReportText, critiquesFrom, parseContractModules,
} = require('../core/build-loop');

const VERBOSE = process.argv.includes('--verbose');
const KEEP = process.argv.includes('--keep');

const PEOPLE = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];   // build-7 角色组
const ASSIGN = assignRoles(PEOPLE, { set: 'build-7' });

let pass = 0;
let fail = 0;
const failedNames = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✔ ${name}${detail ? `　${detail}` : ''}`);
  } else {
    fail += 1;
    failedNames.push(name);
    console.log(`  ✗ ${name}${detail ? `　${detail}` : ''}`);
  }
}
function section(t) { console.log(''); console.log(`── ${t} ──`); }
function info(t) { console.log(`     ${t}`); }

/* ══════════════════════════════════════════════════════════════════
   假 AI：按收到的 prompt 决定回复（真 AI 也是看 prompt 回话）
   ══════════════════════════════════════════════════════════════════ */

/** 契约（由架构师 p3 产出）—— 故意只给 3 个人分模块，好让"没归属"的分支也被走到 */
const CONTRACT_TEXT = [
  '## 模块划分',
  '',
  '本项目拆成三个文件，接口如下：',
  '',
  '| 模块路径 | 负责人 | 对外签名 |',
  '|---|---|---|',
  '| src/util.js | p4 | add(a, b): number |',
  '| src/app.js | p1 | main(): void |',
  '| config.json | p5 | 配置对象 |',
  '',
  '约定：全部使用 CommonJS。',
].join('\n');

/** 第 1 轮各人的产物 —— ★ 每一份都埋了一个**只有真编译能发现**的错 */
const ROUND1 = {
  p1: [   // 引用了一个契约里根本没人负责的模块
    '```js path=src/app.js',
    "const { add } = require('./util');",
    "const { helper } = require('./nowhere');",   // ← 缺失引用（语法完全正确）
    'console.log(add(1, 2), helper);',
    '```',
  ].join('\n'),
  p4: [   // 语法错：函数体忘了收尾就直接写下一句（真实交付里最常见的低级错）
    '```js path=src/util.js',
    'function add(a, b) {',
    '  return a + b;',
    '  // 忘了关函数就写了下一句',
    'module.exports = { add };',
    '```',
  ].join('\n'),
  p5: [   // 坏 JSON
    '```json path=config.json',
    '{"port": 8080,,}',
    '```',
  ].join('\n'),
};

/** 修好之后的产物 */
const ROUND2 = {
  p1: '```js path=src/app.js\nconst { add } = require(\'./util\');\nconsole.log(add(1, 2));\n```',
  p4: '```js path=src/util.js\nfunction add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n```',
  p5: '```json path=config.json\n{"port": 8080}\n```',
};

/**
 * 造一个"看 prompt 回话"的假 AI。
 * 判断顺序有讲究：修复阶段的 prompt 同时含"本机真实检查结果"与"交付要求"，
 * 所以必须先判修复，再判一般产物交付。
 */
function makeBuildAgent(id) {
  const a = makeFakeAdapter({ id });
  a._promptOf = (prompt) => {
    if (prompt.includes('本机真实检查结果')) return 'REPAIR';
    if (prompt.includes('产物工作区')) return 'INTEGRATE';
    if (prompt.includes('你本次要交付的文件')) return 'ARTIFACT';
    if (prompt.includes('契约格式要求')) return 'CONTRACT';
    if (prompt.includes('模块划分') || prompt.includes('架构')) return 'ARCH';
    if (prompt.includes('需求')) return 'REQ';
    return 'CHAT';
  };
  a._decide = (prompt) => {
    const kind = a._promptOf(prompt);
    switch (kind) {
      case 'CONTRACT': return CONTRACT_TEXT;
      case 'ARCH': return '## 架构\n分三层：util（纯函数）/ app（入口）/ config（配置）。';
      case 'REQ': return '必做：加法工具。不做：GUI。';
      case 'ARTIFACT': return ROUND1[id] || '本节我没有需要交付的文件（契约里未分配模块给我）。';
      case 'REPAIR': return ROUND2[id] || '我这边没有需要修的文件。';
      case 'INTEGRATE':
        /* ★★ 关键设计：集成席**故意说"已全部通过、可以交付"**。
         *   这是被测试的行为 —— 它不该改变 verdict。
         *   judgeBuildPass 早就写明"模型自述通过不可采信"，这一句就是它的现实检验。 */
        return '我已经把三个文件都读了一遍，集成没有问题，全部检查通过，软件可以交付了。';
      default: return '（闲聊）';
    }
  };
  const origWait = a.waitForResponse.bind(a);
  a.waitForResponse = async function waitForResponse(opts) {
    const prompt = this.sent[this.sent.length - 1] || '';
    this.replyText = this._decide(prompt);
    return origWait(opts);
  };
  return a;
}

/* ══════════════════════════════════════════════════════════════════
   主流程
   ══════════════════════════════════════════════════════════════════ */

async function main() {
  const root = path.join(os.tmpdir(), `dsh-build-verify-${process.pid}`);
  const store = new ArtifactStore({ root });
  store.clean();

  console.log('build 模式端到端验证 —— 产物真落盘 + 真编译 + 判定只认执行结果');
  console.log(`工作区：${root}`);

  /* ---------- 造 rig ---------- */
  const meeting = new Meeting({ topic: 'build 模式产物验证' });
  const adapters = {};
  for (const id of PEOPLE) adapters[id] = makeBuildAgent(id);
  const orch = new MeetingOrchestrator({
    meeting, adapters, completionOpts: { minSignals: 2, timeoutMs: 2000 },
  });
  const runner = new PhaseRunner({ meeting, orchestrator: orch });

  const plan = planPhases('build', { participants: PEOPLE, assignment: ASSIGN });
  const byName = (n) => plan.find((p) => p.name === n);
  const promptOf = (id, i = -1) => {
    const sent = adapters[id].sent;
    return (i < 0 ? sent[sent.length + i] : sent[i]) || '';
  };

  /**
   * ★ 阶段提示词注入 —— 三处用途统一走 PhaseRunner 的 ctx.phasePrompt。
   *   report 要等编译之后才有，所以做成可后填的工厂。
   */
  const phasePrompter = (contract, report) => (stage, pid) => {
    if (stage.produces === 'contract') return CONTRACT_TEMPLATE;
    if (FILE_PRODUCING.includes(stage.produces)) return artifactPromptFor(contract, pid);
    if (stage.produces === 'integration') return report;
    return null;
  };

  /* ---------- ① 契约：文本 → 结构 ---------- */
  section('① 契约被执行：文本 → { text, modules }');

  await runner.runStage(byName('冻结契约'), {
    task: '做一个加法工具', round: 1, contract: null, critiques: [],
    phasePrompt: phasePrompter(null, null),
  });
  const contractMsg = meeting.messages.filter((m) => m.kind === 'contract').pop();
  const contractText = (contractMsg || {}).content || '';
  check('契约阶段真拿到了格式模板（否则产出是散文，解析不出归属）',
    promptOf('p3').includes('模块路径'), '');
  const contract = contractFor(contractText, { participants: PEOPLE });

  check('契约由架构师 p3 产出（seat: architect 生效）',
    contractText.length > 0, `契约 ${contractText.length} 字`);
  check('★ 契约文本被解析成 modules（此前没人做这一步，导致归属永远为空）',
    contract.modules.length === 3,
    contract.modules.map((m) => `${m.owner}→${m.module}`).join(' · '));
  check('模块归属正确',
    contract.modules.some((m) => m.owner === 'p4' && m.module === 'src/util.js')
    && contract.modules.some((m) => m.owner === 'p1' && m.module === 'src/app.js')
    && contract.modules.some((m) => m.owner === 'p5' && m.module === 'config.json'));
  check('契约里的签名被带出来（"同伴只看接口"的机制有了数据）',
    contract.modules.find((m) => m.module === 'src/util.js').signature === 'add(a, b): number');

  // 解析器负样本：角色名当负责人必须被丢弃
  const badParse = parseContractModules('| src/x.js | 架构师 | f() |', { participants: PEOPLE });
  check('★ 负责人写成角色名（"架构师"）→ 丢弃并记账，不放进 modules',
    badParse.modules.length === 0 && badParse.rejected.length === 1
    && badParse.rejected[0].reason === 'unknown-owner');

  /* ---------- ② 分头实现：交付说明 + 落盘 ---------- */
  section('② 分头实现：每个人都被告知"你交哪个文件"，产物落盘');

  const artifactPromptP4 = artifactPromptFor(contract, 'p4');
  check('★ 交付说明点名了 p4 该交的文件（归属在提问时就钉死，不靠事后校验）',
    artifactPromptP4.includes('src/util.js') && artifactPromptP4.includes('只交这些文件'));
  check('交付说明带上了格式约定（path= 写法）',
    artifactPromptP4.includes('path=') && artifactPromptP4.includes('相对路径'));
  check('没分到模块的人拿到的是"自行判断 + 必须标 path="（不编一个路径给他）',
    artifactPromptFor(contract, 'p7').includes('没有明确你的模块归属'));

  const implResult = await runner.runStage(byName('分头实现'), {
    task: '做一个加法工具', round: 1, contract, critiques: [],
    phasePrompt: phasePrompter(contract, null),
  });
  check('「分头实现」7 人全部被调用（seat: all）',
    implResult.calls === 7, `calls=${implResult.calls} ok=${implResult.ok.length}`);
  check('★ 交付说明逐人不同地进了 prompt（p4 看到自己的文件，p1 看到自己的）',
    /【你本次要交付的文件】\n- src\/util\.js/.test(promptOf('p4'))
    && /【你本次要交付的文件】\n- src\/app\.js/.test(promptOf('p1')));
  check('没分到模块的人收到的是"没有明确你的模块归属"那一支',
    promptOf('p7').includes('没有明确你的模块归属'));

  const collect1 = collectStageArtifacts(implResult, { store, contract, round: 1 });
  const disk1 = store.walk();
  check('★ 产物真的落到了磁盘（walk 读出来的，不是内存账本）',
    disk1.length === 3, disk1.map((f) => f.path).join(' · '));
  check('三个文件内容正确写盘',
    fs.readFileSync(path.join(root, 'src', 'util.js'), 'utf8').includes('function add'));
  check('★ 没交文件的人被明确记为 no-artifact-parsed（不假装成功）',
    ['p2', 'p3', 'p6', 'p7'].filter((id) => collect1.byOwner[id] && collect1.byOwner[id].reason === 'no-artifact-parsed').length >= 3,
    Object.entries(collect1.byOwner).filter(([, v]) => v.reason === 'no-artifact-parsed').map(([k]) => k).join(','));
  check('按作者归因正确（p4 → src/util.js）',
    JSON.stringify(collect1.byOwner.p4.paths) === JSON.stringify(['src/util.js']));
  if (VERBOSE) for (const f of disk1) info(`${f.path}  ${f.bytes}B`);

  /* ---------- ③ 真编译 ---------- */
  section('③ 真编译验证：抓出三个只有执行才能发现的错');

  const v1 = await verifyWorkspace({ store, level: 'static' });
  const kinds = v1.verdict.errors.map((e) => e.kind).sort();
  check('★ 语法错被抓到（node --check）', kinds.includes('syntax'),
    v1.verdict.errors.find((e) => e.kind === 'syntax') ? `src/util.js 第 ${v1.verdict.errors.find((e) => e.kind === 'syntax').line} 行` : '');
  check('★ 缺失引用被抓到（node --check 抓不到 —— 那是语法完全正确的代码）',
    kinds.includes('refs'),
    v1.verdict.errors.find((e) => e.kind === 'refs') ? `${v1.verdict.errors.find((e) => e.kind === 'refs').ref} 在产物里不存在` : '');
  check('★ 坏 JSON 被抓到', kinds.includes('json'));
  check('三处错误一个不漏', v1.verdict.errors.length === 3, `实际 ${v1.verdict.errors.length} 处`);
  check('verdict.buildPass === false', v1.verdict.buildPass === false);
  check('理由里显式声明可信度来源（"本机执行结果"）',
    v1.verdict.reason.includes('本机执行结果'));
  check('检查项确实在真子进程里跑过', v1.res.ran >= 4, `ran=${v1.res.ran}`);
  for (const e of v1.verdict.errors) {
    info(`[${e.kind}] ${e.file}${e.line ? ` 第 ${e.line} 行` : ''} — ${e.message}`);
  }

  /* ---------- ④ 集成席：判定权不在它手上 ---------- */
  section('④ 集成席拿到真实报告，但"它说通过"不算数');

  const report = buildReportText({
    verdict: v1.verdict, res: v1.res, files: disk1, root, level: 'static',
  });
  check('报告声明这是本机执行结果',
    report.includes('本机真实执行结果'));
  check('报告列出了磁盘文件清单（集成席不必猜产物在哪）',
    report.includes('src/util.js') && report.includes('config.json'));
  check('报告列出失败明细（含类型、文件、行号）',
    report.includes('[refs]') && report.includes('[syntax]')
    && report.includes('src/app.js') && report.includes('第 '));
  check('★ 报告把集成席的职责限定为"定位 + 指派"，不给判定权',
    report.includes('指派到**具体的人**') && report.includes('不要声称')
    && !report.includes('请你判断是否通过'));

  // 集成席开口 —— 它说的是"全部通过、可以交付"
  await runner.runStage(byName('集成验证'), {
    task: '做一个加法工具', round: 1, contract, critiques: [],
    phasePrompt: phasePrompter(contract, report),
  });
  const integratorSaid = promptOf('p6')
    ? ((meeting.messages.filter((m) => m.senderId === 'p6' && m.kind === 'integration').pop() || {}).content || '')
    : '';
  check('★ 编译报告真的进了集成席的 prompt（它拿到了真结果，不是靠猜）',
    promptOf('p6').includes('本机真实执行结果') && promptOf('p6').includes('src/util.js'));
  check('集成席确实说了"全部通过、可以交付"（这是故意埋的）',
    /全部检查通过|可以交付/.test(integratorSaid), integratorSaid.slice(0, 40));

  const checkerSpeech = judgeBuildPass(integratorSaid);
  check('★ judgeBuildPass 对这句话返回 null（不采信模型自述）',
    checkerSpeech.pass === null && checkerSpeech.confidence === 'text-heuristic-untrusted');
  check('★★ 而 verdict 仍然是 false —— 判定只来自执行结果，自述无法翻案',
    v1.verdict.buildPass === false);

  /* ---------- ⑤ shouldStop 闭环 ---------- */
  section('⑤ 闭环：build-pass 判据不再 degraded（此前永远缺输入）');

  const stop1 = shouldStop('build', { iteration: 1, buildPass: v1.verdict.buildPass });
  check('★ 判据不再是 degraded（missingInput 为空）',
    !stop1.degraded && !stop1.missingInput,
    stop1.reason);
  check('未通过 → 不停止，进修复回路', stop1.stop === false);

  // 对照：不传 buildPass 时确实会 degraded（说明这个断言不是白来的）
  const degraded = shouldStop('build', { iteration: 1 });
  check('对照：漏传 buildPass 时判据如实报缺输入（degraded 机制仍然有效）',
    degraded.degraded === true && degraded.missingInput.includes('buildPass'));

  /* ---------- ⑥ 修复回路 ---------- */
  section('⑥ 修复回路：真实失败清单派下去，修完再真编译');

  const crit = critiquesFrom(v1.verdict);
  check('★ 失败清单转成 critiques（给修复阶段当输入）', crit.length === 1 && crit[0].includes('本机真实检查结果'));
  check('清单包含三条硬要求（只修这些 / 只交改动过的 / 不要解释）',
    crit[0].includes('不要重写整个文件') && crit[0].includes('只交回**你改动过的文件**'));
  check('★ 清单逐字稳定（同一次失败两次生成完全相同 —— 否则收敛判据会失效）',
    JSON.stringify(critiquesFrom(v1.verdict)) === JSON.stringify(crit));
  check('清单不含时间戳/耗时（那些会让"已修好"被判成"又出现新批评"）',
    !/\d{4}-\d{2}-\d{2}|\d+ms/.test(crit[0]));

  const repairResult = await runner.runStage(byName('修复'), {
    task: '做一个加法工具', round: 2, contract, critiques: crit,
    phasePrompt: phasePrompter(contract, report),
  });
  check('修复阶段全员被调用', repairResult.calls === 7);
  check('★ 真实失败清单真的进了修复者的 prompt（它拿到的是编译输出，不是"某个 AI 的意见"）',
    promptOf('p4').includes('本机真实检查结果') && promptOf('p4').includes('不要重写整个文件'));
  check('修复阶段同时收到"你要交回哪些文件"（限定改动与交付范围）',
    /【你本次要交付的文件】\n- src\/util\.js/.test(promptOf('p4')));

  const collect2 = collectStageArtifacts(repairResult, { store, contract, round: 2 });
  check('★ 修复后同一作者覆盖了自己的文件（round>1 → force）',
    collect2.written === 3 && fs.readFileSync(path.join(root, 'src', 'util.js'), 'utf8').includes('function add(a, b) {\n  return a + b;\n}'));
  check('没有产生跨作者冲突（各写各的模块）', collect2.conflicts.length === 0);

  const v2 = await verifyWorkspace({ store, level: 'static' });
  check('★★ 修好后 buildPass 变 true（这一整轮判定是可信的）',
    v2.verdict.buildPass === true, verdictLine(v2.verdict));

  const stop2 = shouldStop('build', { iteration: 2, buildPass: v2.verdict.buildPass });
  check('★ 判据给出停止：集成验证通过，软件可交付',
    stop2.stop === true && !stop2.degraded, stop2.reason);

  /* ---------- ⑦ 别的模式的判据不受影响 ---------- */
  section('⑦ 未越界：别的模式判定不变');

  const t = shouldStop('tournament', { iteration: 2, winnerId: 'X', prevWinnerId: 'X' });
  check('tournament 仍然靠 winnerId 收敛（没被本轮改动波及）', t.stop === true);
  const i1 = shouldStop('iterate', { iteration: 1, critiques: [], prevCritiques: [] });
  check('iterate 的 no-new-critique 仍然正常', i1.stop === false);

  /* ---------- 汇总 ---------- */
  console.log('');
  console.log('═'.repeat(64));
  console.log(`检查结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('失败项：');
    failedNames.forEach((n) => console.log(`  · ${n}`));
  }
  console.log(`工作区：${root}`);
  console.log('  磁盘文件：' + disk1.map((f) => f.path).join(', '));
  console.log('  最终判定：' + verdictLine(v2.verdict));

  if (KEEP) console.log('（--keep：工作区保留，可自行查看产物）');
  else { store.clean(); fs.rmSync(root, { recursive: true, force: true }); console.log('（工作区已清理）'); }

  return fail ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  console.log('');
  console.log('脚本异常：' + (e && e.stack));
  process.exitCode = 2;
});
