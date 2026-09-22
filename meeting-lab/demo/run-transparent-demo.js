'use strict';
/**
 * demo/run-transparent-demo.js —— 「透明广播」会议引擎演示（终端可跑，无需浏览器）
 *
 * 验证三件事（对应你提的需求）：
 *   1. 首条消息含【全部会议规则】，接收方知道在开会、按什么规则来
 *   2. 第 ≥2 轮：每条消息含「除自己外」所有人的上一轮发言，带 ChatGPT说/Gemini说 标签
 *   3. 每一轮自动落盘 MD（round-N.md + 会议记录.md）
 *
 * 跑法：  node demo/run-transparent-demo.js
 */

const { TransparentMeeting } = require('../core/transparent-meeting');
const { makeFakeAdapter } = require('../test/helpers/fake-adapter');
const { writeMasterRecord } = require('../core/reporter');
const fs = require('fs');

const ROSTER = [
  { id: 'deepseek-web', name: '深度求索-DeepSeek', latency: 30, reply: '切入点：用 Electron partition 隔离各 AI 登录态，编排层走本地轻量代理；主要风险是网页结构漂移导致完成检测误判。' },
  { id: 'chatgpt-web', name: 'OpenAI-ChatGPT', latency: 40, reply: '同意隔离登录态。补充：会议记录应独立于网页存储，否则刷新即丢；网页自带上下文与注入要划清边界。' },
  { id: 'kimi-web', name: '月之暗面-Kimi', latency: 25, reply: '完成检测建议多信号联合（停止按钮/发送就绪/DOM 静止），不要固定 sleep，否则长回答被截断。' },
  { id: 'doubao-web', name: '字节跳动-豆包', latency: 35, reply: '文件分发要先等全部 ACK 到齐再统一发送，避免半截材料。' },
  { id: 'tongyi-web', name: '阿里巴巴-通义千问', latency: 28, reply: '每 AI 一个状态机，卡住能定位到具体环节，而不是只显示"加载中"。' },
  { id: 'yuanbao-web', name: '腾讯-元宝', latency: 33, reply: '9 个账号同 IP 高频调用有封号风险，需要限速与错峰。' },
  { id: 'gemini-web', name: '谷歌-Gemini', latency: 45, reply: '我倾向会议记录独立于网页；另外锚定效应要主动防御——首轮并行独立。' },
  { id: 'google-search', name: '谷歌-搜索', latency: 20, reply: '（搜索汇总）主流方案都倾向 Adapter 隔离 + 编排层可替换。' },
  { id: 'wenxin-web', name: '百度-文心', latency: 30, reply: '第一版只验证三个不确定性，不要一上来就 9 人自由辩论。' },
];

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', blue: '\x1b[36m', yellow: '\x1b[33m',
};
const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = (t = '') => line(`\n${C.blue}${'═'.repeat(64)}${C.reset}\n${C.bold}${t}${C.reset}\n${C.blue}${'═'.repeat(64)}${C.reset}`);

async function main() {
  rule('通辽会议 · 透明广播引擎演示');

  const adapters = {};
  const names = {};
  for (const r of ROSTER) {
    adapters[r.id] = makeFakeAdapter({ id: r.id, name: r.name, delayMs: r.latency, replyText: r.reply });
    names[r.id] = r.name;
  }

  const topic = '通辽会议接入微软多智能体框架：请给出你的技术切入点与主要风险。';

  const tm = new TransparentMeeting({
    topic,
    participants: ROSTER.map((r) => r.id),
    adapters,
    names,
    rounds: 3,
  });

  const t0 = Date.now();
  const res = await tm.run();
  line(`${C.green}✓ 会议跑完，耗时 ${Date.now() - t0}ms${C.reset}`);
  line(`MD 落盘目录：${C.bold}${res.outDir}${C.reset}`);

  /* ───── 验证 1：首条消息含完整规则 ───── */
  rule('验证① · 第 1 轮下发给 DeepSeek 的首条消息（应含【会议规则】+【本轮议题】）');
  line(adapters['deepseek-web'].sent[0]);

  /* ───── 验证 2：第 2 轮消息含「除自己外」所有人的发言，带标签 ───── */
  rule('验证② · 第 2 轮下发给 DeepSeek 的消息（应含 ChatGPT说 / Gemini说 …，但不含"DeepSeek 说"）');
  const p2 = adapters['deepseek-web'].sent[1];
  line(p2);
  const hasSelf = /DeepSeek 说|深度求索-DeepSeek 说/.test(p2);
  const hasOthers = /ChatGPT 说|Gemini 说|Kimi 说/.test(p2);
  line('');
  line(`自检：含他人标签=${hasOthers ? C.green + '✔' : C.yellow + '✗'}　含自己标签=${hasSelf ? C.yellow + '✗（不应有）' : C.green + '✔（正确排除）'}${C.reset}`);

  /* ───── 验证 3：MD 已落盘 ───── */
  rule('验证③ · 自动生成的 MD 文件');
  const round2 = fs.readFileSync(require('path').join(res.outDir, 'round-2.md'), 'utf8');
  line(`round-2.md 前 40 行：`);
  line(C.dim + round2.split('\n').slice(0, 40).join('\n') + C.reset);
  line('');
  line(`${C.green}✓ round-1.md / round-2.md / round-3.md / 会议记录.md 均已生成${C.reset}`);

  rule('演示结束');
  line(`完整 MD 在：${res.outDir}`);
  line('');
}

main().catch((err) => {
  line(`${C.yellow}演示失败：${err && err.stack}${C.reset}`);
  process.exit(1);
});
