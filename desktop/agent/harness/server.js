'use strict';
/**
 * harness/server.js —— Harness 入口。
 * 由 Electron 主进程用 `node harness/server.js` 拉起，也可独立 `npm run start:harness`。
 *
 * 启动后把 token 打到 stdout（形如：AGENT_TOKEN=<hex>），Electron 侧解析后注入 Browser。
 * token 同时落 harness/data/token。
 */

const { createHarnessServer, HOST } = require('./server/index.js');

async function main() {
  const server = createHarnessServer();
  const info = await server.start();

  // 供 Electron / Browser 解析的固定格式
  process.stdout.write(`AGENT_READY host=${info.host} port=${info.port} token=${info.token}\n`);
  process.stdout.write(`AGENT_TOKEN=${info.token}\n`);
  process.stdout.write(`AGENT_WS=ws://${info.host}:${info.port}/agent\n`);

  const shutdown = async () => {
    try {
      await server.stop();
    } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 仅作为 CLI 直接运行时才启动；被 require（内嵌模式）时不执行 main()
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[harness] fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
