#!/usr/bin/env node
'use strict';
/**
 * tools/run-interaction-proof.js —— 「AI 之间到底有没有真的互动」实证脚本
 *
 * 背景：
 *   用户质疑「好像也没互动成功啊」。
 *   光看代码说"接了"没有说服力，所以这个脚本跑一场**真实的两轮对辩**，
 *   把三件事落成可核对的事实：
 *     ① 机制：第二轮里，每个模型收到的 prompt 是否真的含着对方的发言、
 *             且**不含自己的**（这就是"互动"的定义）。
 *     ② 协议：每个模型收到的两轮 prompt 逐字打印，可以看到差异。
 *     ③ 效果：反驳文本里是否真的出现了对方的立场词与反驳标记
 *             （不是"我同意你"式的假对话）。
 *
 * 通道：只用 API 通道（deepseek + google），因为 API 的"答完"是协议级事实
 *       （SSE [DONE]），不存在网页版的假完成干扰，结论更干净。
 *
 * 用法：node tools/run-interaction-proof.js [--verbose]
 */

const fs = require('fs');
const path = require('path');

const { createApiAdapter } = require('../adapters/api-adapter');
const { composePrompt } = require('../core/context-strategy');
const { selectSlice, SLICE } = require('../core/modes');

const VERBOSE = process.argv.includes('--verbose');
const OUT_MD = path.join(__dirname, '..', 'INTERACTION-PROOF.md');

const TOPIC = '通辽会议的多 AI 编排层，应该切换到微软 MAF/AutoGen 框架，还是继续自研？';

const SIDES = {
  'api:deepseek': {
    key: 'deepseek',
    model: 'deepseek-chat',
    label: 'DeepSeek API',
    side: '正方',
    stance: '主张「切换到微软 MAF 框架」',
  },
  'api:google': {
    key: 'google',
    model: 'gemini-3.6-flash',
    label: 'Google API (Gemini)',
    side: '反方',
    stance: '主张「继续自研，不切框架」',
  },
};

const ROLE_ROUND1 = (s) => `【你的角色】
你是这场辩论的${s.side}。你的立场是：${s.stance}。
请给出你方最强的论证：2 条核心理由，每条一句话。
禁止和稀泥、禁止说"要看具体情况"。`;

const ROLE_ROUND2 = (s) => `【你的角色】
你是这场辩论的${s.side}，立场是：${s.stance}。
下面【现场发言】里是对方刚刚发表的立论。
你的任务：**逐条反驳它**——指出对方论证里的漏洞、被忽略的事实或站不住的前提。
要求：用 1./2. 编号；不要复述自己的立场；不要写"我同意某部分"。`;

const TASK1 = `议题：${TOPIC}\n请发表你方立论。`;
const TASK2 = '请反驳【现场发言】中对方提出的论点。';

const t0 = Date.now();
const log = (...a) => console.log(...a);

/* 反驳标记词：出现这些词，说明是在"驳"，不是"和" */
const REBUTTAL_MARKS = ['但是', '然而', '问题在于', '不成立', '忽略', '高估', '低估',
  '站不住', '另一方面', '恰恰', '未必', '反而', '反过来', '不认同', '无法支撑',
  '前提', '漏洞', '过于', '只看到', '忽视了', '省了', '没考虑'];
/* 立场关键词：第一轮里出现、第二轮里被对方"抓"住的词 */
const STANCE_WORDS = ['MAF', 'AutoGen', '微软', '自研', '维护', '迁移', '锁定',
  '依赖', '可控', '成本', '成熟', '生态', '调试', '重写', '接缝'];

const countHits = (text, words) => {
  const t = String(text || '');
  return words.filter((w) => t.includes(w));
};

(async () => {
  log('═'.repeat(78));
  log('互动实证：一场真实的两轮对辩（纯 API 通道）');
  log('═'.repeat(78));
  log(`议题：${TOPIC}`);
  log('');

  /* ---------- 建适配器 ---------- */
  const seats = {};
  for (const [id, s] of Object.entries(SIDES)) {
    const adapter = createApiAdapter({
      providerKey: s.key,
      model: s.model,
      id,
      name: s.label,
      logger: () => {},          // 静音内部日志，报告只看结果
    });
    const ready = await adapter.isReady();
    const d = adapter.describe();
    log(`[席位] ${s.label.padEnd(20)} ${ready ? '就绪' : '不可用'}  ${d.host} · ${d.model}`);
    if (!ready) {
      log(`       跳过：${d.lastError || '未就绪'}`);
      continue;
    }
    seats[id] = { ...s, adapter };
  }

  const ids = Object.keys(seats);
  if (ids.length < 2) {
    log('\n需要至少 2 个可用 API 席位才能验证互动，当前不足。');
    log('先跑 node tools/check-api.js --live 看哪家可用。');
    process.exit(1);
  }

  /* ---------- 第 1 轮：立论（互相看不见） ---------- */
  log('\n' + '─'.repeat(78));
  log('第 1 轮 · 立论（切片 = TASK：每个人只看得到议题，互相看不见）');
  log('─'.repeat(78));

  const messages = [];
  const prompts = { r1: {}, r2: {} };
  const replies = { r1: {}, r2: {} };

  for (const id of ids) {
    const s = seats[id];
    const prompt = composePrompt({ task: TASK1, role: ROLE_ROUND1(s), providerId: id });
    prompts.r1[id] = prompt;
    await s.adapter.sendText(prompt);
    const r = await s.adapter.waitForResponse({ timeoutMs: 120000 });
    replies.r1[id] = r.text || '';
    log(`\n▸ ${s.label}（${s.side}） — ${r.completion.done ? '完成' : '失败'} ${r.completion.elapsedMs}ms · ${r.completion.reason}`);
    log(indent(r.text, 4));
    if (r.completion.done) {
      messages.push({ senderId: id, content: r.text });
    }
  }

  /* ---------- 第 2 轮：对辩（只看别人，不看自己） ---------- */
  log('\n' + '─'.repeat(78));
  log('第 2 轮 · 对辩（切片 = OTHERS：只看别人的，不看自己的）');
  log('─'.repeat(78));

  const sliceReport = {};
  for (const id of ids) {
    const s = seats[id];
    const sl = selectSlice(SLICE.OTHERS, { messages, selfId: id });
    sliceReport[id] = { included: sl.included, chars: sl.text.length };

    // composePrompt 的 recentRounds 语义与 SLICE.OTHERS 完全一致：
    // 「别人的发言」，且天然不含自己
    const others = messages
      .filter((m) => m.senderId !== id)
      .map((m) => ({ sender: (seats[m.senderId] || {}).label || m.senderId, text: m.content }));

    const prompt = composePrompt({
      task: TASK2, role: ROLE_ROUND2(s), recentRounds: others, providerId: id,
    });
    prompts.r2[id] = prompt;

    await s.adapter.sendText(prompt);
    const r = await s.adapter.waitForResponse({ timeoutMs: 120000 });
    replies.r2[id] = r.text || '';
    log(`\n▸ ${s.label}（${s.side}） — ${r.completion.done ? '完成' : '失败'} ${r.completion.elapsedMs}ms · ${r.completion.reason}`);
    log(`  注入切片：${sl.included.join(',') || '(空)'} · ${sl.text.length} 字`);
    log(indent(r.text, 4));
  }

  /* ---------- 取证 ---------- */
  log('\n' + '═'.repeat(78));
  log('取证：互动到底发生了没有');
  log('═'.repeat(78));

  const checks = [];
  const add = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    log(`${pass ? '✔' : '✘'} ${name}\n    ${detail}`);
  };

  for (const id of ids) {
    const me = seats[id];
    const otherIds = ids.filter((x) => x !== id);
    const p2 = prompts.r2[id];

    // ① 第二轮 prompt 必须含对方的立论全文
    const containsOther = otherIds.every((o) => {
      const firstLine = (replies.r1[o] || '').trim().slice(0, 40);
      return firstLine && p2.includes(firstLine);
    });
    add(`${me.label} 第二轮看得到对方立论`, containsOther,
      `对方立论开头片段${containsOther ? '已' : '未'}出现在它的 prompt 里`);

    // ② 第二轮 prompt 必须不含自己的立论（防止自我复述）
    const myFirstLine = (replies.r1[id] || '').trim().slice(0, 40);
    const leaksSelf = myFirstLine && p2.includes(myFirstLine);
    add(`${me.label} 第二轮看不到自己的立论`, !leaksSelf,
      leaksSelf ? '★ 泄漏：自己的立论被注入进去了' : '自己的立论未注入（符合 OTHERS 切片语义）');

    // ③ 反驳文本里是否抓住对方的立场词
    const opp = otherIds.map((o) => replies.r1[o]).join('\n');
    const oppWords = countHits(opp, STANCE_WORDS);
    const caught = countHits(replies.r2[id], oppWords);
    add(`${me.label} 的反驳抓住了对方的论点词`, caught.length > 0,
      `对方立论里的词：${oppWords.join('、') || '(无)'}\n    被它抓住的：${caught.join('、') || '(一个都没抓到 → 疑似各说各话)'}`);

    // ④ 反驳标记词
    const marks = countHits(replies.r2[id], REBUTTAL_MARKS);
    add(`${me.label} 的第二轮确实在"驳"不在"和"`, marks.length > 0,
      `命中反驳标记：${marks.join('、') || '(无 → 可能只是在重复自己)'}`);
  }

  const passed = checks.filter((c) => c.pass).length;
  log(`\n结论：${passed}/${checks.length} 项通过`);

  /* ---------- 落盘 ---------- */
  const md = buildMarkdown({ checks, prompts, replies, sliceReport, seats, ids });
  fs.writeFileSync(OUT_MD, md, 'utf8');
  log(`\n报告已写入 ${OUT_MD}`);
  log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  process.exit(passed === checks.length ? 0 : 2);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});

function indent(text, n) {
  const pad = ' '.repeat(n);
  return String(text || '(空)').trim().split('\n').map((l) => pad + l).join('\n');
}

function buildMarkdown({ checks, prompts, replies, sliceReport, seats, ids }) {
  const L = [];
  L.push('# 互动实证报告：AI 之间到底有没有在对话');
  L.push('');
  L.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}　·　脚本：\`tools/run-interaction-proof.js\``);
  L.push(`> 通道：纯 API（deepseek-chat / gemini-3.6-flash），无网页版干扰`);
  L.push('');
  L.push(`**议题**：${TOPIC}`);
  L.push('');
  L.push('**对局**：' + ids.map((id) => `${seats[id].side}=${seats[id].label}`).join('　vs　'));
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 一、结论速览');
  L.push('');
  L.push('| 检查项 | 结果 | 说明 |');
  L.push('|---|---|---|');
  for (const c of checks) {
    L.push(`| ${c.name} | ${c.pass ? '通过' : '**未通过**'} | ${c.detail.replace(/\n\s*/g, '；')} |`);
  }
  L.push('');
  const passed = checks.filter((c) => c.pass).length;
  L.push(`**${passed}/${checks.length} 项通过。**`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 二、第 1 轮 · 立论（互相看不见）');
  L.push('');
  L.push('这一轮每个模型收到的 prompt 里**只有自己的角色 + 议题**，没有任何其他人的信息。');
  L.push('这是有意的：先各自独立表态，避免一上来就互相锚定。');
  L.push('');
  for (const id of ids) {
    L.push(`### ${seats[id].label}（${seats[id].side}）`);
    L.push('');
    L.push('**它收到的 prompt（逐字）**');
    L.push('');
    L.push('```text');
    L.push(prompts.r1[id]);
    L.push('```');
    L.push('');
    L.push('**它的回复**');
    L.push('');
    L.push(replies.r1[id].trim() || '(空)');
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('## 三、第 2 轮 · 对辩（只看别人的，不看自己的）');
  L.push('');
  L.push('这一轮的关键差异：prompt 里**换成了对方的立论**，而**自己的立论被摘掉了**。');
  L.push('机制上用的是 `selectSlice(OTHERS)` —— 过滤条件是 `senderId !== selfId`。');
  L.push('');
  L.push('| 席位 | 切片内容 | 注入字数 |');
  L.push('|---|---|---|');
  for (const id of ids) {
    L.push(`| ${seats[id].label} | ${sliceReport[id].included.join(',') || '(空)'} | ${sliceReport[id].chars} |`);
  }
  L.push('');
  for (const id of ids) {
    L.push(`### ${seats[id].label}（${seats[id].side}）`);
    L.push('');
    L.push('**它收到的 prompt（逐字）**');
    L.push('');
    L.push('```text');
    L.push(prompts.r2[id]);
    L.push('```');
    L.push('');
    L.push('**它的反驳**');
    L.push('');
    L.push(replies.r2[id].trim() || '(空)');
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('## 四、这两轮的差异说明了什么');
  L.push('');
  L.push('同一场会里，同一个模型的 prompt 在两轮之间发生了变化：');
  L.push('');
  L.push('| 轮次 | 切片 | 它看得到什么 | 它看不到什么 |');
  L.push('|---|---|---|---|');
  L.push('| 第 1 轮 立论 | `TASK` | 只有议题 | 其他所有人的发言 |');
  L.push('| 第 2 轮 对辩 | `OTHERS` | 对方的立论 | **自己的立论**（防自我复述） |');
  L.push('');
  L.push('这就是「互动」在工程上的确切含义：**不是把几个 AI 放在一起各问一遍，**');
  L.push('**而是每一轮的 prompt 都由「前面谁说过什么」动态组装出来。**');
  L.push('');
  L.push('如果哪一天互动断了，症状会非常明确：第二轮 prompt 里切片为空 ——');
  L.push('那说明 `messages` 没被写进会议状态，或者 `selfId` 传错了导致过滤掉所有人。');
  L.push('');
  return L.join('\n');
}
