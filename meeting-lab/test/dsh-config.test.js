'use strict';
/**
 * test/dsh-config.test.js —— DSH 配置读取 + API 通道「双管齐下」的验证
 *
 * 要证明的命题：
 *   1. 能正确解析 .dsh/settings.yaml 与 .credentials.yaml（不引依赖）
 *   2. 能从中装配出可用的 API 提供方（本机真配置）
 *   3. API 适配器与网页版适配器**满足同一份契约**
 *   4. 密钥不会出现在任何诊断输出里
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseYaml, loadProviders, getRedacted, defaultDshDir } = require('../adapters/dsh-config');
const { createApiAdapter } = require('../adapters/api-adapter');

/* ═══════════════ 一、YAML 子集解析器 ═══════════════ */

test('parseYaml 能解析嵌套 map', () => {
  const y = [
    'a:',
    '  b:',
    '    c: 1',
    '  d: hello',
  ].join('\n');
  assert.deepStrictEqual(parseYaml(y), { a: { b: { c: 1 }, d: 'hello' } });
});

test('parseYaml 能解析列表里的对象（settings.yaml 的 models 结构）', () => {
  const y = [
    'providers:',
    '  agne:',
    '    models:',
    '      - id: m1',
    '        name: M1',
    '      - id: m2',
    '        name: M2',
  ].join('\n');
  const r = parseYaml(y);
  assert.deepStrictEqual(r.providers.agne.models, [
    { id: 'm1', name: 'M1' },
    { id: 'm2', name: 'M2' },
  ]);
});

test('parseYaml 能解析标量列表', () => {
  const r = parseYaml('list:\n  - a\n  - b\n');
  assert.deepStrictEqual(r.list, ['a', 'b']);
});

test('parseYaml 处理引号、布尔、数字、null', () => {
  const r = parseYaml([
    'a: "1"',
    'b: true',
    'c: 42',
    'd:',
    'e: 3.14',
  ].join('\n'));
  assert.strictEqual(r.a, '1');
  assert.strictEqual(r.b, true);
  assert.strictEqual(r.c, 42);
  assert.strictEqual(r.d, null);
  assert.strictEqual(r.e, 3.14);
});

test('parseYaml 不把 URL 里的 # 当注释，但把行内注释切掉', () => {
  const r = parseYaml([
    'a: https://x.com/v1#frag',
    'b: value # 这是注释',
  ].join('\n'));
  assert.strictEqual(r.a, 'https://x.com/v1#frag');
  assert.strictEqual(r.b, 'value');
});

test('parseYaml 对无法识别的行保持宽容（不炸整个配置）', () => {
  const r = parseYaml('a: 1\n@@@ 这不是 YAML\nb: 2\n');
  assert.strictEqual(r.a, 1);
  assert.strictEqual(r.b, 2);
});

/* ═══════════════ 二、真实 DSH 配置的读取 ═══════════════ */

test('能定位到 DSH 配置目录并读到提供方', () => {
  const dir = defaultDshDir();
  assert.ok(fs.existsSync(dir), `配置目录不存在：${dir}`);
  const { providers, warnings } = loadProviders({ dir });
  const keys = Object.keys(providers);
  assert.ok(keys.length >= 1, `未读到任何提供方。warnings=${warnings.join('|')}`);

  // 每个提供方必须至少知道 baseURL 与模型（否则创建适配器也没意义）
  for (const [k, p] of Object.entries(providers)) {
    assert.ok(p.baseURL || p.hasKey, `提供方「${k}」既无 baseURL 又无密钥`);
    assert.ok(Array.isArray(p.models));
  }
});

test('提供方结构包含 openai 兼容所需字段', () => {
  const { providers } = loadProviders({});
  const withUrl = Object.values(providers).filter((p) => p.baseURL);
  if (!withUrl.length) return;   // 本机没有可用提供方就跳过（不制造假失败）
  for (const p of withUrl) {
    assert.ok(typeof p.baseURL === 'string' && /^https?:\/\//.test(p.baseURL),
      `「${p.key}」baseURL 不是合法 URL：${p.baseURL}`);
    assert.ok(p.api === 'openai-completions' || typeof p.api === 'string');
  }
});

test('脱敏摘要绝不泄露密钥原文', () => {
  const red = getRedacted({});
  const s = JSON.stringify(red);
  // 任何看起来像密钥的长串都不该出现
  const suspicious = s.match(/sk-[A-Za-z0-9_-]{10,}/g);
  assert.strictEqual(suspicious, null, `脱敏输出里出现了疑似密钥：${suspicious}`);
  assert.ok(!/apiKey["']?\s*:\s*["'][^"']{20,}/.test(s), '脱敏输出里出现了长密钥值');
  for (const p of red.providers) {
    assert.ok(typeof p.hasKey === 'boolean');
    assert.ok(!('apiKey' in p), '脱敏结果不应带 apiKey 字段');
  }
});

/* ═══════════════ 三、API 适配器行为 ═══════════════ */

test('API 适配器缺密钥时给出 NO_API_KEY 而不抛异常', async () => {
  const a = createApiAdapter({ providerKey: 'x', baseURL: 'https://e.invalid/v1', apiKey: null, model: 'm' });
  const r = await a.waitForResponse({});
  assert.strictEqual(r.completion.done, false);
  assert.strictEqual(r.completion.reason, 'NO_API_KEY');
});

test('API 适配器无 baseURL 时给出 NO_BASE_URL', async () => {
  const a = createApiAdapter({ providerKey: 'x', baseURL: '', apiKey: 'sk-x', model: 'm' });
  const r = await a.waitForResponse({});
  assert.strictEqual(r.completion.reason, 'NO_BASE_URL');
});

test('API 适配器 sendText 记录文本，waitForResponse 返回契约结构', async () => {
  const a = createApiAdapter({ providerKey: 'x', baseURL: 'https://e.invalid/v1', apiKey: 'k', model: 'm' });
  await a.sendText('你好');
  const r = await a.waitForResponse({ timeoutMs: 300 });
  // 网络不可达 → 结构化失败（而不是抛异常），结构必须齐
  assert.ok(typeof r.text === 'string');
  assert.ok(r.completion && typeof r.completion.done === 'boolean');
  assert.ok(r.completion.signals, 'completion.signals 必须存在');
  assert.ok(r.stream && r.stream.transport === 'api');
});

test('API 通道的完成是协议级事实：signals 全部来自流状态', async () => {
  const a = createApiAdapter({ providerKey: 'x', baseURL: 'https://e.invalid/v1', apiKey: 'k', model: 'm' });
  const r = await a.waitForResponse({ timeoutMs: 300 });
  const sig = r.completion.signals;
  // 失败时三个信号都应为 false（不能出现"没答完却报完成"）
  if (!r.completion.done) {
    assert.strictEqual(sig.streamEnded, false);
    assert.strictEqual(sig.stopGone, false);
  }
});

test('附件内联：文本类会被读进 prompt，不支持的类型明确报失败', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mlab-att-'));
  const txt = path.join(tmp, 'note.txt');
  fs.writeFileSync(txt, '这是附件内容', 'utf8');
  const zip = path.join(tmp, 'x.zip');
  fs.writeFileSync(zip, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  const a = createApiAdapter({ providerKey: 'x', baseURL: 'https://e.invalid/v1', apiKey: 'k', model: 'm' });
  const acks = [];
  const r = await a.uploadFiles(
    [{ attachmentId: 'a1', name: 'note.txt', localPath: txt },
      { attachmentId: 'a2', name: 'x.zip', localPath: zip }],
    { onAck: (id) => acks.push(id) },
  );

  assert.strictEqual(r.ok, false, '有失败项时 ok 应为 false');
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].name, 'x.zip');
  assert.ok(/UNSUPPORTED/.test(r.failed[0].error));
  assert.deepStrictEqual(acks, ['a1'], '只有成功内联的项应当 ACK');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('附件缺 localPath 时明确报 NO_LOCAL_PATH（不静默跳过）', async () => {
  const a = createApiAdapter({ providerKey: 'x', baseURL: 'https://e.invalid/v1', apiKey: 'k', model: 'm' });
  const r = await a.uploadFiles([{ attachmentId: 'a', name: 'n.txt' }], {});
  assert.strictEqual(r.failed[0].error, 'NO_LOCAL_PATH');
});

test('describe() 输出诊断信息但不含密钥', () => {
  const a = createApiAdapter({ providerKey: 'x', baseURL: 'https://api.example.com/v1', apiKey: 'sk-supersecret-1234567890', model: 'm1' });
  const d = a.describe();
  const s = JSON.stringify(d);
  assert.ok(!s.includes('supersecret'), `describe 泄露密钥：${s}`);
  assert.strictEqual(d.host, 'api.example.com');
  assert.strictEqual(d.model, 'm1');
  assert.strictEqual(d.hasKey, true);
});

test('cancel() 在没有请求进行中时返回 false（不抛异常）', async () => {
  const a = createApiAdapter({ providerKey: 'x', baseURL: 'https://e.invalid/v1', apiKey: 'k', model: 'm' });
  assert.strictEqual(await a.cancel(), false);
});

test('detectCapabilities 说明 API 通道的能力边界（无联网）', async () => {
  const a = createApiAdapter({ providerKey: 'x', baseURL: 'https://e.invalid/v1', apiKey: 'k', model: 'm' });
  const c = await a.detectCapabilities();
  assert.strictEqual(c.transport, 'api');
  assert.strictEqual(c.search, false, 'API 通道无联网能力，必须如实声明');
});

/* ═══════════════ 四、双通道混编的前提 ═══════════════ */

test('API 适配器与网页版适配器的契约字段一致（编排层看不出差别）', () => {
  const { validateAdapter, REQUIRED_METHODS } = require('../adapters/contract');
  const api = createApiAdapter({ providerKey: 'x', baseURL: 'https://e.invalid/v1', apiKey: 'k', model: 'm' });
  const r = validateAdapter(api);
  assert.ok(r.ok, `API 适配器缺：${r.missing}`);
  for (const m of REQUIRED_METHODS) {
    assert.strictEqual(typeof api[m], 'function', `缺方法 ${m}`);
  }
  assert.ok(api.id && api.name, 'id / name 是编排层寻址依据，不可缺');
});
