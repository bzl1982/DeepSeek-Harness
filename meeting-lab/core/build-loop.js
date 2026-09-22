'use strict';
/**
 * core/build-loop.js —— build 模式的产物流水线：**从「一堆文本」到「一次可信的交付判定」**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这条链路上原本断了两处，本文件把它们接起来
 *
 *   ① 契约是「文本」，但消费方要的是「结构」
 *      冻结契约阶段 produces:'contract'，产出的是一段 markdown。
 *      而 selectSlice(SLICE.CONTRACT) 期望的是
 *          { text: 契约全文, modules: [{ owner, module, signature }] }
 *      ——**中间没有解析器**。于是 `contract.modules` 永远是 undefined：
 *        「你负责的模块」这段提示从未注入过，模型不知道自己该交哪个文件，
 *        产物路径全靠它自觉（于是 defaultPathFor 的兜底也失去依据）。
 *
 *   ② 产物是「文本」，但下游要的是「磁盘上的文件」
 *      —— 这一条已由 artifact-bus + build-verify 补齐，本文件负责把它们串起来。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 流水线
 *
 *   契约文本 ──parseContractModules──▶ [{owner, module, signature}]
 *     │                                      │
 *     │                            artifactPromptFor（告诉每个人"你交哪个文件"）
 *     │                                      ▼
 *   各人回复 ──parseArtifacts──▶ {path,content} ──ArtifactStore.materialize──▶ 磁盘真文件
 *                                                                                  │
 *                                                         planVerification/runVerification
 *                                                                                  ▼
 *                                                                        verdict { buildPass }
 *                                                    ┌─────────────────────────────┴────────────────┐
 *                                                    ▼                                              ▼
 *                                  shouldStop('build', { buildPass })            buildReportText → 集成席
 *                                                                                critiquesFrom  → 修复回路
 *
 * ★ 一条设计原则贯穿全程：**判定只来自执行结果**。
 *   集成席 AI 拿到的报告里没有"请你判断是否通过"这种话 —— 是不是通过，本机已经算完了；
 *   它的职责被收窄成"定位哪里断了 + 指派给谁修"（这正是 modes.js 对 integrator 的定位）。
 */

const fs = require('fs');
const path = require('path');

const {
  ARTIFACT_TEMPLATE, parseArtifacts, ArtifactStore, defaultPathFor, contractModuleNames,
} = require('./artifact-bus');
const {
  planVerification, runVerification, verdictOf, feedbackText, verdictLine,
} = require('./build-verify');

/* ══════════════════════════════════════════════════════════════════
   ① 契约：文本 → 结构
   ══════════════════════════════════════════════════════════════════ */

/**
 * 给「冻结契约」阶段的格式约定。
 *
 * ★ 为什么非得定格式：契约要**被机器消费**（决定每个人写哪个文件、落盘怎么归属）。
 *   自由散文再漂亮也解析不出 `{owner, module}`，而解析错了的后果是
 *   "AI 写的文件覆盖别人的文件" —— 那比解析不出来更糟。
 *   所以：给一种机器可读的表格，同时解析器对几种常见变体保持宽容。
 */
const CONTRACT_TEMPLATE = [
  '【契约格式要求】除了正文说明，**必须**输出一张模块表，用下面的固定格式：',
  '',
  '| 模块路径 | 负责人 | 对外签名 |',
  '|---|---|---|',
  '| src/util.js | <负责人 id> | add(a, b): number |',
  '',
  '要求：',
  '1. 「负责人」必须是**参会者的 id**（照抄名单，不要写角色名、不要写"架构师"）；',
  '2. 「模块路径」是相对路径，用 `/` 分隔，**每个文件一行**；',
  '3. 「对外签名」写一行就够（别的模块只需要知道怎么调，不需要知道怎么实现）；',
  '4. ★ 模块之间不能重名 —— 每人只负责自己名下的文件。',
].join('\n');

/** 一个 token 像不像文件路径 */
function looksLikePath(t) {
  return /[/\\]/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t);
}

/**
 * 从契约文本里抽出模块表 —— 文本 → `[{ owner, module, signature }]`。
 *
 * 宽容三种写法（但 prompt 只教第一种）：
 *   ① markdown 表格：  | src/util.js | p4 | add(a,b): number |
 *   ② 列表行：         - src/util.js — p4 — add(a,b): number
 *   ③ 行内注明：       `src/util.js`（负责人：p4）
 *
 * ★ 硬判据：**owner 必须在参会者名单里**。
 *   模型经常把负责人写成角色名（"架构师"）或幻觉 id（"Agent-1"）。
 *   这类条目一律**丢弃并计入 rejected** —— 保留它们会让"归属校验"整个失效
 *   （一个错的归属比没有归属更糟：它会放行越界写入）。
 *
 * @param {string} text 契约阶段的回复
 * @param {object} opts
 *   - participants  参会者 id 数组（owner 必须在这里面）
 * @returns {{ modules:Array, rejected:Array }}
 */
function parseContractModules(text, { participants = [] } = {}) {
  const src = String(text == null ? '' : text);
  const known = new Set(participants.map((p) => String(p)));
  const modules = [];
  const rejected = [];
  const seen = new Set();

  const add = (rawPath, rawOwner, signature, how) => {
    const p = String(rawPath || '').trim().replace(/^[`*'"<[]+/, '').replace(/[`*'">\]]+$/, '');
    const owner = String(rawOwner || '').trim();
    if (!looksLikePath(p)) return;
    if (!known.has(owner)) {
      rejected.push({ module: p, owner, reason: 'unknown-owner', how });
      return;
    }
    const key = `${p}|${owner}`;
    if (seen.has(key)) return;
    seen.add(key);
    modules.push({
      owner,
      module: p.replace(/\\/g, '/').replace(/^\.\//, ''),
      signature: String(signature || '').trim() || null,
      how,
    });
  };

  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    /* ① markdown 表格行：至少 2 个 `|`。分隔行（|---|---|）没有路径，自然会被跳过。 */
    if ((line.match(/\|/g) || []).length >= 2) {
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '');
      const pIdx = cells.findIndex(looksLikePath);
      if (pIdx >= 0) {
        const rest = cells.slice(pIdx + 1);
        // 负责人：路径之后第一个出现在名单里的 token（跳过纯数字/纯符号列）
        const oIdx = rest.findIndex((c) => known.has(c));
        if (oIdx >= 0) {
          add(cells[pIdx], rest[oIdx], rest.slice(oIdx + 1).join(' '), 'table');
          continue;
        }
        // 路径在，但负责人列认不出来 → 记下来（不静默丢）
        add(cells[pIdx], rest[0] || '', rest.slice(1).join(' '), 'table');
        continue;
      }
    }

    /* ② 列表行：- path — owner — signature  （破折号/冒号/逗号都能当分隔） */
    const listM = line.match(/^[-*+]\s+(.+)$/);
    if (listM) {
      const parts = listM[1].split(/\s*(?:—|–|-{2,}|:|：|,|，|\|)\s*/).map((s) => s.trim()).filter(Boolean);
      const pIdx = parts.findIndex(looksLikePath);
      if (pIdx >= 0) {
        const oIdx = parts.findIndex((c, i) => i > pIdx && known.has(c));
        if (oIdx >= 0) {
          add(parts[pIdx], parts[oIdx], parts.slice(oIdx + 1).join(' '), 'list');
          continue;
        }
        // 也接受「负责人：p4」写成同一段文本
        const all = parts.slice(pIdx + 1).join(' ');
        const om = all.match(/(?:负责人|owner)\s*[:：=]\s*([A-Za-z0-9_.-]+)/);
        if (om) { add(parts[pIdx], om[1], '', 'list-kv'); continue; }
        const anyId = parts.slice(pIdx + 1).find((c) => known.has(c));
        if (anyId) { add(parts[pIdx], anyId, '', 'list'); continue; }
      }
    }

    /* ③ 行内注明：`src/util.js`（负责人：p4） */
    const inline = line.match(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})[^\n]*?(?:负责人|owner)\s*[:：=]\s*([A-Za-z0-9_.-]+)/i);
    if (inline) add(inline[1], inline[2], '', 'inline');
  }

  return { modules, rejected };
}

/**
 * 组装 selectSlice(SLICE.CONTRACT) 要的那个结构。
 * 解析不出模块表也**要返回 text** —— 契约正文本身仍然有价值（那是各人的共同依据）。
 */
function contractFor(text, { participants = [] } = {}) {
  const { modules, rejected } = parseContractModules(text, { participants });
  return { text: String(text || ''), modules, rejected };
}

/**
 * 给某个执行者的"交付说明"—— 追加到「分头实现」阶段的 prompt。
 *
 * ★ 为什么必须逐人给：契约里 A 交 src/app.js、B 交 src/util.js。
 *   若只把契约全文发下去，模型得自己从表格里找自己那一行 —— 找错就写错文件，
 *   而落盘阶段的"越界"判定只能事后发现。**把归属在提问时就钉死，比事后校验便宜得多。**
 */
function artifactPromptFor(contract, ownerId) {
  const names = [...contractModuleNames(contract, ownerId)];
  const mine = (contract && Array.isArray(contract.modules))
    ? contract.modules.filter((m) => m.owner === ownerId) : [];
  const lines = [];
  if (mine.length) {
    lines.push('【你本次要交付的文件】');
    for (const m of mine) {
      lines.push(`- ${m.module}${m.signature ? `（对外签名：${m.signature}）` : ''}`);
    }
    lines.push('★ 只交这些文件；别人负责的文件不要写（写了会被判越界并计入集成冲突）。');
  } else if (names.length) {
    lines.push(`【你本次要交付的文件】${names.join('、')}`);
  } else {
    lines.push('【你本次要交付的文件】契约里没有明确你的模块归属 —— 请按契约正文自行判断，'
      + '并在每个代码块上用 `path=` 标明完整相对路径。');
  }
  lines.push('', ARTIFACT_TEMPLATE);
  return lines.join('\n');
}

/* ══════════════════════════════════════════════════════════════════
   ② 收集一个阶段的产物并落盘
   ══════════════════════════════════════════════════════════════════ */

/**
 * 把「分头实现」（或「修复」）阶段的结果落到磁盘。
 *
 * @param {object} stageResult PhaseRunner.runStage 的返回值（含 results[{providerId, ok, text}]）
 * @param {object} opts
 *   - store     ArtifactStore
 *   - contract  { text, modules }（用于归属校验与路径兜底）
 *   - round     轮次（修复回路里同一个人会重复交同一文件 → 用 force 覆盖自己的）
 * @returns {object} 汇总（含 byOwner / conflicts / outOfContract / rejected）
 */
function collectStageArtifacts(stageResult, { store, contract = null, round = 1, logger = null } = {}) {
  if (!store) throw new Error('collectStageArtifacts: store required');
  const log = logger || (() => {});
  const results = (stageResult && stageResult.results) || [];

  const byOwner = {};
  const conflicts = [];
  const outOfContract = [];
  const rejected = [];
  let written = 0;

  for (const r of results) {
    const ownerId = r && r.providerId;
    if (!ownerId) continue;
    if (!r.ok) {
      byOwner[ownerId] = { ok: false, files: 0, reason: 'stage-failed' };
      continue;
    }
    const parsed = parseArtifacts(r.text, { defaultPath: defaultPathFor(contract, ownerId) });
    for (const rj of parsed.rejected) rejected.push({ ownerId, ...rj });

    if (!parsed.files.length) {
      byOwner[ownerId] = { ok: false, files: 0, reason: 'no-artifact-parsed' };
      log('warn', `${ownerId} 的回复里没有解析出任何文件`, { stage: stageResult && stageResult.name });
      continue;
    }

    /* ★ 修复回路里同一个人会重交同一文件 → 那是"自己的更新"，允许覆盖。
     *   跨作者冲突才是契约被违背，由 ArtifactStore 记进 conflicts（先到者保留）。 */
    const m = store.materialize(ownerId, parsed.files, { contract, force: round > 1 });
    written += m.written.length;
    for (const c of m.conflicts) conflicts.push({ ...c, round });
    for (const o of m.outOfContract) outOfContract.push({ ...o, round });
    for (const s of m.skipped) {
      if (s.reason === 'conflict-kept-first') continue;   // 已在 conflicts 里
      rejected.push({ ownerId, reason: s.reason, detail: s.detail || null, snippet: s.path });
    }
    byOwner[ownerId] = {
      ok: m.written.length > 0,
      files: m.written.length,
      paths: m.written.map((w) => w.path),
      how: parsed.files.map((f) => f.how),
    };
  }

  return {
    round,
    owners: results.length,
    written,
    byOwner,
    conflicts,
    outOfContract,
    rejected,
    ok: written > 0,
  };
}

/* ══════════════════════════════════════════════════════════════════
   ③ 真验证
   ══════════════════════════════════════════════════════════════════ */

/** 读工作区的 package.json（level:'build' 要用它判断有没有构建脚本） */
function readPackageJson(store) {
  try {
    const p = path.join(store.root, 'package.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * 对当前工作区跑一次真验证（基于**磁盘事实**，不是内存账本）。
 *
 * @returns {Promise<{verdict, res, plan, files, level}>}
 */
async function verifyWorkspace({
  store, level = 'static', timeoutMs = undefined, concurrency = undefined, logger = null,
} = {}) {
  if (!store) throw new Error('verifyWorkspace: store required');
  const log = logger || (() => {});
  const files = store.walk();
  const pkg = readPackageJson(store);
  const plan = planVerification({ files, level, pkg });
  const res = await runVerification(plan, { root: store.root, files, timeoutMs, concurrency });
  const verdict = verdictOf(res);
  log(verdict.buildPass === false ? 'warn' : 'info',
    `产物验证（${level}）：${verdictLine(verdict)}`, { files: files.length, ran: res.ran });
  return { verdict, res, plan, files, level };
}

/* ══════════════════════════════════════════════════════════════════
   ④ 出证：给集成席的报告 / 给修复回路的清单
   ══════════════════════════════════════════════════════════════════ */

/**
 * 组装给「集成验证」席的报告。
 *
 * ★ 措辞上有意**不给它判定的权力**：
 *   报告里不说"请你判断是否通过"——是不是通过本机已经算完了（verdict.buildPass）。
 *   它的职责被收窄为"定位哪里断了、指派给谁修"，这正是 modes.js 对 integrator 的定位
 *   （"集成者拼装 + 编译/运行，报哪里断了"）。
 *   若把判定权交给它，就等于让 judgeBuildPass 那套"不采信模型自述"的坚持白费。
 */
function buildReportText({ verdict, res, files = [], root = '', level = 'static', extra = null }) {
  const lines = [];
  lines.push('【产物工作区 —— 本机真实执行结果，不是任何 AI 的判断】');
  lines.push(`落盘目录：${root}`);
  lines.push(`磁盘文件（${files.length} 个）：`);
  if (files.length) {
    for (const f of files) lines.push(`  ${f.path}${f.bytes != null ? `  ${f.bytes}B` : ''}`);
  } else {
    lines.push('  （空 —— 上一阶段没有产出任何文件）');
  }
  lines.push('');
  lines.push(`【本机检查】档位 ${level}，执行 ${res ? res.ran : 0} 项`);
  lines.push(`结论：${verdictLine(verdict)}`);

  if (res && res.failures.length) {
    lines.push('');
    lines.push('失败明细：');
    res.failures.forEach((f, i) => {
      const loc = [f.file, f.line ? `第 ${f.line} 行` : null].filter(Boolean).join(' ') || '(全局)';
      lines.push(`  ${i + 1}. [${f.kind}] ${loc} —— ${f.message}`);
      if (f.detail) lines.push(`     ${String(f.detail).split('\n').slice(0, 4).join('\n     ')}`);
    });
  }
  if (res && res.skipped && res.skipped.length) {
    const sv = res.skipped.filter((s) => s.reason === 'no-ts-compiler').map((s) => s.file);
    if (sv.length) lines.push('', `⚠ 以下文件**未经验证**（缺 TS 编译器）：${sv.join('、')}`);
  }
  if (extra) lines.push('', extra);
  lines.push('');
  lines.push('★ 你的任务：');
  lines.push('1. 针对上面每一条真实错误，定位它**断在哪里**（哪个文件、哪个引用、哪个签名不一致）；');
  lines.push('2. 把修复指派到**具体的人**（按契约的模块归属），不要笼统说"大家一起改"；');
  lines.push('3. 不要重写别人的模块，不要声称"已通过"（是不是通过由本机结果决定，不由你的判断决定）。');
  return lines.join('\n');
}

/**
 * 把真实失败清单变成「修复」阶段吃的 critiques。
 *
 * ★ 字段名对齐 shell：critiques 是 `string[]`，而它同时会喂给
 *   `newCritiques()` 做"本轮相对上轮无新增 → 收敛"的判定。
 *   所以这里必须输出**稳定、可比较**的文本：同一次失败在两次运行里字形要一致，
 *   否则"修好了"会被判成"又出现新批评"，收敛判据永久失效。
 *   → 做法：只包含结构性字段（kind/file/line/code），**不含耗时、时间戳、绝对路径**。
 */
function critiquesFrom(verdict, { maxItems = 20 } = {}) {
  const errs = (verdict && verdict.errors) || [];
  if (!errs.length) return [];
  return [feedbackText(verdict, { maxItems })];
}

/** 便于断言/日志的稳定签名（同一次失败 → 同一个 key） */
function failureKey(f) {
  return `${f.kind}|${f.file || ''}|${f.line == null ? '' : f.line}|${f.code || ''}|${f.ref || ''}`;
}

module.exports = {
  CONTRACT_TEMPLATE,
  parseContractModules,
  contractFor,
  artifactPromptFor,
  collectStageArtifacts,
  verifyWorkspace,
  buildReportText,
  critiquesFrom,
  readPackageJson,
  failureKey,
  /* 转出，方便调用方从一处 import */
  ARTIFACT_TEMPLATE,
  parseArtifacts,
  ArtifactStore,
  defaultPathFor,
  verdictOf,
  verdictLine,
  feedbackText,
};
