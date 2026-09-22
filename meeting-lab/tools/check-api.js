'use strict';
/**
 * tools/check-api.js —— API 通道连通性自检
 *
 * 用法：
 *   node tools/check-api.js              # 检查所有提供方的配置（不花额度）
 *   node tools/check-api.js --live       # 真的发一次最小请求（花极少额度）
 *   node tools/check-api.js --live deepseek   # 只测某一家
 *
 * ★ 双管齐下的验收工具：网页版那条路要开 GUI 才能验，
 *   这条命令行就能验，所以它是"会议能不能用 API 模型"的快速体检口。
 *
 * ★ 输出里绝不出现密钥原文（只显示 host + 有无密钥）。
 */

const { getRedacted } = require('../adapters/dsh-config');
const { createApiAdapter } = require('../adapters/api-adapter');
const { validateAdapter } = require('../adapters/contract');

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', gray: '\x1b[90m', bold: '\x1b[1m', cyan: '\x1b[36m' };

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const only = args.find((a) => !a.startsWith('--')) || null;

  console.log('');
  console.log(C.bold + '  API 通道自检' + C.reset);
  console.log(C.gray + '  ─────────────────────────────────────────────' + C.reset);

  const red = getRedacted({});
  console.log(`  配置目录：${red.dir}`);
  if (red.warnings.length) {
    for (const w of red.warnings) console.log(`  ${C.yellow}⚠ ${w}${C.reset}`);
  }
  console.log('');

  const targets = red.providers.filter((p) => (only ? p.key === only : true));
  if (!targets.length) {
    console.log(`  ${C.red}没有可测的提供方${C.reset}（可用：${red.providers.map((p) => p.key).join(', ') || '无'}）`);
    return;
  }

  let allOk = true;

  for (const p of targets) {
    const a = createApiAdapter({ providerKey: p.key });

    // ── 1) 契约完整性（不发请求）──
    const v = validateAdapter(a);
    const d = a.describe();

    console.log(`  ${C.bold}${p.key}${C.reset}  ${C.gray}${d.host} → ${d.model}${C.reset}`);
    console.log(`    契约：${v.ok ? C.green + '✔ 满足' + C.reset : C.red + '✘ 缺 ' + v.missing.join(', ') + C.reset}`);
    console.log(`    密钥：${p.hasKey ? C.green + '✔ 已取到' + C.reset : C.red + '✘ 缺失' + C.reset}`);

    // ── 2) isReady ──
    const ready = await a.isReady();
    console.log(`    就绪：${ready ? C.green + '✔' + C.reset : C.red + '✘' + C.reset}`);

    if (!live) {
      console.log(`    ${C.gray}（跳过实连；加 --live 可发一次最小请求验证）${C.reset}`);
      console.log('');
      if (!v.ok || !ready) allOk = false;
      continue;
    }

    // ── 3) 真连一次（最小请求）──
    process.stdout.write(`    实连：${C.yellow}请求中…${C.reset}`);
    const t0 = Date.now();
    await a.sendText('只回复两个字：收到');
    const r = await a.waitForResponse({ timeoutMs: 30000 });
    const ms = Date.now() - t0;
    process.stdout.write('\r' + ' '.repeat(40) + '\r');

    if (r.completion.done) {
      const preview = String(r.text || '').replace(/\s+/g, ' ').slice(0, 40);
      console.log(`    实连：${C.green}✔ 成功${C.reset} ${C.gray}${ms}ms${C.reset}`);
      console.log(`    回复：${C.cyan}${preview || '(空)'}${C.reset}`);
      console.log(`    完成判据：${C.gray}${r.completion.reason}（流结束 = 答完，非启发式）${C.reset}`);
      if (r.stream.usage) {
        console.log(`    用量：${C.gray}${JSON.stringify(r.stream.usage)}${C.reset}`);
      }
    } else {
      console.log(`    实连：${C.red}✘ 失败${C.reset} ${C.gray}${ms}ms${C.reset}`);
      console.log(`    原因：${C.red}${r.completion.reason}${C.reset}`);
      allOk = false;
    }
    console.log('');
  }

  console.log(C.gray + '  ─────────────────────────────────────────────' + C.reset);
  console.log(`  结论：${allOk ? C.green + '通道可用' + C.reset : C.red + '有项目未通过' + C.reset}`);
  console.log('');
}

main().catch((e) => {
  console.error(`${C.red}自检异常：${e.message}${C.reset}`);
  process.exit(1);
});
