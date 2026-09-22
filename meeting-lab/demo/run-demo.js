'use strict';
/**
 * demo/run-demo.js —— 通辽会议 Phase 0 演示（终端可跑，无需浏览器）
 *
 * 演示三件事：
 *   1. 9 个 AI 并发广播 + 完成检测
 *   2. 附件握手：先上传齐、再统一发送（含"一个失败 → 降级"）
 *   3. 单点失败隔离：一个出验证码、一个超时，其余照常完成；可单独重试
 *
 * 跑法：  node demo/run-demo.js
 */

const { Meeting } = require('../core/meeting-model');
const { MeetingOrchestrator } = require('../core/orchestrator');
const { STRATEGY } = require('../core/speaker');
const { makeFakeAdapter, SIGNALS } = require('../test/helpers/fake-adapter');

/* ---------- 参会名单（与客户端 agentCatalog.js 一致） ---------- */

const ROSTER = [
  { id: 'deepseek-web', name: '深度求索-DeepSeek', latency: 40, reply: '建议把浏览器控制权留在 Electron，Python 只做编排；这样能复用现有 9 个 partition 的登录态。' },
  { id: 'chatgpt-web', name: 'OpenAI-ChatGPT', latency: 55, reply: '我同意，但要注意网页版自带上下文与会议记录注入会打架，必须明确记忆边界。' },
  { id: 'kimi-web', name: '月之暗面-Kimi', latency: 35, reply: '补充一点：完成检测建议用多信号联合，不要固定 sleep，否则长回答必被截断。' },
  { id: 'doubao-web', name: '字节跳动-豆包', latency: 60, reply: '文件分发应该先等全部 ACK 到齐再统一发送，现在的固定 3 秒是"猜"。' },
  { id: 'tongyi-web', name: '阿里巴巴-通义千问', latency: 45, reply: '建议给每个 AI 建状态机，卡住时能定位到具体环节，而不是只显示"加载中"。' },
  { id: 'yuanbao-web', name: '腾讯-元宝', latency: 50, reply: '限速和错峰很重要，9 个账号同 IP 高频调用有封号风险。' },
  { id: 'gemini-web', name: '谷歌-Gemini', latency: 70, reply: '我倾向于把会议记录独立于网页存储，这样刷新和崩溃都不丢。' },
  { id: 'google-search', name: '谷歌-搜索', latency: 30, reply: '（搜索结果汇总）多数方案倾向于 Adapter 隔离 + 编排层可替换。' },
  { id: 'wenxin-web', name: '百度-文心', latency: 48, reply: '建议第一版只验证三个不确定性，不要一上来就做 9 人自由辩论。' },
];

/* ---------- 输出辅助 ---------- */

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[36m',
};
const line = (s = '') => process.stdout.write(`${s}\n`);
const rule = (t = '') => line(`\n${C.blue}${'═'.repeat(64)}${C.reset}\n${C.bold}${t}${C.reset}\n${C.blue}${'═'.repeat(64)}${C.reset}`);

function pad(s, n) {
  // 中文按 2 宽度算，保证表格对齐
  let w = 0;
  for (const ch of String(s)) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, n - w));
}

/* ---------- 主流程 ---------- */

async function main() {
  rule('通辽会议 Phase 0 · 独立测试台演示（不接客户端）');

  // 建 9 个"假"网页 AI（可控延迟 / 可控失败），完全不需要浏览器
  const adapters = {};
  for (const r of ROSTER) {
    adapters[r.id] = makeFakeAdapter({
      id: r.id,
      name: r.name,
      delayMs: r.latency,
      replyText: r.reply,
    });
  }

  const meeting = new Meeting({ topic: '通辽会议接入方案评审' });
  const orch = new MeetingOrchestrator({
    meeting,
    adapters,
    strategy: STRATEGY.BROADCAST,
    completionOpts: { minSignals: 2, timeoutMs: 5000 },
    attachmentBusOpts: { defaultTimeoutMs: 800 },
    logger: ({ level, msg, data }) => {
      if (level === 'error' || level === 'warn') {
        line(`${C.yellow}  [${level}] ${msg}${C.reset}`);
      } else if (data) {
        line(`${C.dim}  [info] ${msg} ${JSON.stringify(data)}${C.reset}`);
      }
    },
  });

  /* ───── 第 1 轮：纯广播 ───── */
  rule('第 1 轮 · 广播问题（无附件）');
  line(`${C.dim}[用户]${C.reset} 请评审"通辽会议接入微软多智能体框架"的可行路径。`);
  line('');

  const t1 = Date.now();
  const r1 = await orch.runTurn({ text: '请评审"通辽会议接入微软多智能体框架"的可行路径。' });
  const d1 = Date.now() - t1;

  line(`${pad('AI', 22)}${pad('状态', 12)}${pad('耗时', 10)}${pad('字数', 8)}`);
  for (const res of r1.results) {
    const ok = res.ok ? `${C.green}✔${C.reset}` : `${C.red}✗${C.reset}`;
    line(`${ok} ${pad(res.providerId, 19)}${pad(res.state, 12)}${pad(`${res.durationMs}ms`, 10)}${pad(`${res.text.length}字`, 8)}`);
  }
  line('');
  line(`${C.green}汇总：${r1.ok.length}/9 成功${C.reset}　模式=${r1.mode}　总耗时=${d1}ms　会议记录=${meeting.messages.length} 条`);

  /* ───── 第 2 轮：带附件（握手 + 降级）───── */
  rule('第 2 轮 · 带附件（验证"9 个人都能收到"的握手协议）');

  // 制造两种真实故障：
  //   · 文心：附件上传失败（DOM 改版）
  //   · Gemini：答到一半弹验证码
  adapters['wenxin-web'].failAt = 'upload';
  adapters['gemini-web'].failAt = 'send';
  adapters['gemini-web'].failError = 'captcha challenge required';

  meeting.nextRound();
  line(`${C.dim}[用户]${C.reset} 请审阅附件 spec.pdf 并给出意见。`);
  line(`${C.dim}[附件]${C.reset} spec.pdf (2048 bytes, application/pdf)`);
  line('');

  const t2 = Date.now();
  const r2 = await orch.runTurn({
    text: '请审阅附件 spec.pdf 并给出意见。',
    files: [{ name: 'spec.pdf', size: 2048, mime: 'application/pdf', localPath: 'D:/demo/spec.pdf' }],
    timeoutMs: 5000,
  });
  const d2 = Date.now() - t2;

  line(`${C.bold}附件门闩结果：${C.reset}${r2.attachmentGate.action}　` +
    `ACK ${r2.attachmentGate.okCount}/${r2.attachmentGate.total}`);
  if (r2.attachmentGate.degraded && r2.attachmentGate.degraded.length) {
    line(`${C.yellow}降级（上传未确认，改文本投递）：${r2.attachmentGate.degraded.join(', ')}${C.reset}`);
  }
  line('');

  line(`${pad('AI', 22)}${pad('状态', 20)}${pad('耗时', 10)}${pad('上传', 12)}`);
  for (const res of r2.results) {
    const ok = res.ok ? `${C.green}✔${C.reset}` : `${C.red}✗${C.reset}`;
    const up = res.upload ? (res.upload.skipped ? `${C.yellow}降级${C.reset}` : '已上传') : '-';
    line(`${ok} ${pad(res.providerId, 19)}${pad(res.state, 20)}${pad(`${res.durationMs}ms`, 10)}${pad('', 12)}${up}`);
  }
  line('');
  line(`${C.green}成功 ${r2.ok.length}${C.reset} / ${C.red}失败 ${r2.failed.length}${C.reset}` +
    `　闭麦名单：${r2.silenced.join(', ')}　总耗时=${d2}ms`);

  /* ───── 第 3 轮：单点重试 ───── */
  rule('第 3 轮 · 单点重试（修好后单独恢复，不重开整场会议）');
  adapters['gemini-web'].failAt = null;
  const retry = await orch.retryAgent('gemini-web', { text: '验证码已完成，请继续你的意见。' });
  line(`gemini-web 重试 → ${retry.ok ? `${C.green}${retry.state}${C.reset}` : `${C.red}${retry.state}${C.reset}`}` +
    `　耗时 ${retry.durationMs}ms`);
  line(`剩余闭麦：${orch.silenced.size ? [...orch.silenced.keys()].join(', ') : '（无）'}`);

  /* ───── 会议纪要 ───── */
  rule('会议纪要（会议状态独立于网页，可回放/可存档）');
  const j = meeting.toJSON();
  line(`会议 ID：${j.meetingId}`);
  line(`议题：${j.topic}`);
  line(`轮次：第 ${j.round} 轮　总消息：${j.messages.length} 条　附件：${j.attachments.length} 个`);
  line('');
  line(`${C.bold}各 AI 终态：${C.reset}`);
  for (const a of j.agents) {
    const color = a.state === 'COMPLETED' ? C.green : (a.error ? C.red : C.dim);
    line(`  ${pad(a.providerId, 20)}${color}${pad(a.state, 20)}${C.reset}${a.error ? a.error : ''}`);
  }

  rule('演示结束');
  line('下一步：把 adapters/web-adapter.js 的 driver 换成 Electron webview（shell/ 已备好），');
  line('        即可用真实 9 个网页 AI 跑同一套编排逻辑。');
  line('');
}

main().catch((err) => {
  line(`${C.red}演示失败：${err && err.stack}${C.reset}`);
  process.exit(1);
});
