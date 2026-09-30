'use strict';
/**
 * test/manifest.test.js
 * 验证 Tool Manifest + _meta.search_tools / searchTools 架构。
 *
 * 覆盖：
 *  - 每个已注册工具（10 个 + _meta.search_tools）都有完整 manifest 字段
 *  - _meta.search_tools 在 read-only / project / full 三个 context 下都可用
 *  - listForContext 返回的工具列表里包含 _meta.search_tools
 *  - searchTools('文件', 'project') 非空且带 name/description/parameters
 *  - searchTools('文件', 'read-only') 不返回 filesystem.write
 *  - searchTools 不返回自身
 *  - category 过滤只返回该 category 的工具
 */

const test = require('node:test');
const assert = require('node:assert');

const registry = require('../harness/registry');

const META = registry.META_TOOL_NAME;

// 10 个业务工具 + 1 个元工具
const EXPECTED_TOOLS = [
  'filesystem.list',
  'filesystem.read',
  'filesystem.search',
  'filesystem.write',
  'filesystem.mkdir',
  'shell.exec',
  'git.status',
  'git.diff',
  'git.log',
  'git.commit',
  META,
];

// ---------- manifest 字段完整性 ----------
test('manifest: 所有已注册工具都有完整 manifest 字段', () => {
  for (const name of EXPECTED_TOOLS) {
    const t = registry.get(name);
    assert.ok(t, `tool ${name} should be registered`);
    // parameters 是对象（JSON Schema）
    assert.ok(t.parameters && typeof t.parameters === 'object', `${name}.parameters should be object`);
    assert.strictEqual(t.parameters.type, 'object', `${name}.parameters.type should be object`);
    // risk 三选一
    assert.ok(['low', 'medium', 'high'].includes(t.risk), `${name}.risk invalid: ${t.risk}`);
    // side_effect 布尔
    assert.strictEqual(typeof t.side_effect, 'boolean', `${name}.side_effect should be boolean`);
    // fs_scope 数组
    assert.ok(Array.isArray(t.fs_scope), `${name}.fs_scope should be array`);
    // timeout_ms 正整数
    assert.ok(Number.isInteger(t.timeout_ms) && t.timeout_ms > 0, `${name}.timeout_ms invalid: ${t.timeout_ms}`);
    // confirmation 三选一
    assert.ok(['never', 'once', 'always'].includes(t.confirmation), `${name}.confirmation invalid: ${t.confirmation}`);
  }
});

test('manifest: 元工具 _meta.search_tools 字段符合规格', () => {
  const t = registry.get(META);
  assert.ok(t);
  assert.strictEqual(t.permission, 'READ');
  assert.strictEqual(t.risk, 'low');
  assert.strictEqual(t.side_effect, false);
  assert.strictEqual(t.timeout_ms, 5000);
  assert.strictEqual(t.confirmation, 'never');
  assert.strictEqual(t.category, 'meta');
  assert.deepStrictEqual(t.fs_scope, []);
  assert.ok(t.description.includes('search_tools') || t.description.includes('检索'));
  assert.ok(Array.isArray(t.parameters.required) && t.parameters.required.includes('query'));
});

test('manifest: 10 个业务工具的关键字段与规格一致', () => {
  const cases = {
    'filesystem.list': { risk: 'low', side_effect: false, confirmation: 'never', category: 'filesystem' },
    'filesystem.read': { risk: 'low', side_effect: false, confirmation: 'never', category: 'filesystem' },
    'filesystem.search': { risk: 'low', side_effect: false, confirmation: 'never', category: 'filesystem' },
    'filesystem.write': { risk: 'medium', side_effect: true, confirmation: 'always', category: 'filesystem' },
    'filesystem.mkdir': { risk: 'medium', side_effect: true, confirmation: 'always', category: 'filesystem' },
    'shell.exec': { risk: 'high', side_effect: true, confirmation: 'always', category: 'shell' },
    'git.status': { risk: 'low', side_effect: false, confirmation: 'never', category: 'git' },
    'git.diff': { risk: 'low', side_effect: false, confirmation: 'never', category: 'git' },
    'git.log': { risk: 'low', side_effect: false, confirmation: 'never', category: 'git' },
    'git.commit': { risk: 'medium', side_effect: true, confirmation: 'always', category: 'git' },
  };
  for (const [name, expect] of Object.entries(cases)) {
    const t = registry.get(name);
    assert.ok(t, name);
    assert.strictEqual(t.risk, expect.risk, `${name}.risk`);
    assert.strictEqual(t.side_effect, expect.side_effect, `${name}.side_effect`);
    assert.strictEqual(t.confirmation, expect.confirmation, `${name}.confirmation`);
    assert.strictEqual(t.category, expect.category, `${name}.category`);
  }
});

// ---------- _meta.search_tools 在所有 context 可用 ----------
test('search_tools: 在 read-only / project / full 三个 context 下 isAvailable 都为 true', () => {
  for (const ctx of ['read-only', 'project', 'full']) {
    assert.ok(registry.isAvailable(META, ctx), `meta tool should be available in ${ctx}`);
  }
  // 未知 context 也不爆炸
  assert.ok(registry.isAvailable(META, 'bogus'));
});

test('listForContext: 返回结果里包含 _meta.search_tools（且在首位）', () => {
  for (const ctx of ['read-only', 'project', 'full']) {
    const list = registry.listForContext(ctx);
    assert.ok(list.some((t) => t.name === META), `${ctx} should include meta tool`);
    assert.strictEqual(list[0].name, META, `${ctx}: meta tool should be prepended`);
  }
});

test('listForContext: 每项带上完整 manifest 新字段', () => {
  const list = registry.listForContext('project');
  for (const t of list) {
    for (const f of ['name', 'permission', 'description', 'parameters', 'risk', 'side_effect', 'fs_scope', 'timeout_ms', 'confirmation', 'category']) {
      assert.ok(f in t, `listForContext item should have field ${f}`);
    }
    // 不应泄露 handler
    assert.strictEqual(t.handler, undefined);
  }
});

// ---------- searchTools 行为 ----------
test('searchTools: 在 project 下搜"文件"返回非空，且带 name/description/parameters', () => {
  const r = registry.searchTools('文件', 'project');
  assert.ok(r.tools.length > 0, 'should return matches');
  for (const t of r.tools) {
    assert.ok(typeof t.name === 'string' && t.name);
    assert.ok(typeof t.description === 'string');
    assert.ok(t.parameters && typeof t.parameters === 'object');
  }
  assert.strictEqual(typeof r.total, 'number');
  assert.ok(r.total >= r.tools.length);
});

test('searchTools: read-only 下搜"文件"不返回 filesystem.write', () => {
  const r = registry.searchTools('文件', 'read-only');
  const names = r.tools.map((t) => t.name);
  assert.ok(names.includes('filesystem.list') || names.includes('filesystem.search'), 'read-only 应能搜到读类工具');
  assert.ok(!names.includes('filesystem.write'), 'read-only 不应出现 filesystem.write');
  assert.ok(!names.includes('shell.exec'), 'read-only 不应出现 shell.exec');
});

test('searchTools: 结果永不包含 _meta.search_tools 自身', () => {
  for (const ctx of ['read-only', 'project', 'full']) {
    const r = registry.searchTools('文件', ctx);
    assert.ok(!r.tools.some((t) => t.name === META), `${ctx}: should not return meta tool itself`);
    const r2 = registry.searchTools('git', ctx);
    assert.ok(!r2.tools.some((t) => t.name === META));
  }
});

test('searchTools: category 过滤只返回该 category 的工具', () => {
  const r = registry.searchTools('git', 'project', { category: 'git' });
  assert.ok(r.tools.length > 0, 'should match git tools');
  for (const t of r.tools) {
    assert.ok(t.name.startsWith('git.'), `expected git.* tool, got ${t.name}`);
  }
});

test('searchTools: limit 生效，且上限 20', () => {
  const all = registry.searchTools('git', 'project');
  assert.ok(all.tools.length <= 5, 'default limit is 5');
  const many = registry.searchTools('git', 'project', { limit: 100 });
  assert.ok(many.tools.length <= 20, 'hard cap is 20');
  assert.ok(many.tools.length >= all.tools.length);
});
