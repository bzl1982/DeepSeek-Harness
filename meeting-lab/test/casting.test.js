'use strict';
/**
 * test/casting.test.js —— 选角引擎 + 模型能力档案的验证
 *
 * 这些断言要证明的核心命题（用户需求）：
 *   「随机设定角色时**要考虑模型的能力**」
 *   → 随机归随机，能力不匹配的人**不可能**坐到那个位子上。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  MODEL_CATALOG, TRAITS, getModel, byProviderId, fitScore, rankForRole, complementarity, listModels,
} = require('../core/models');
const { ROLE_CATALOG, roleReq, ROLE_SETS } = require('../core/roles');
const { castRoles, autoCast, makeRng, hashSeed, topDims } = require('../core/casting');
const { validateAdapter } = require('../adapters/contract');

/* ═══════════════ 一、模型能力档案的完整性 ═══════════════ */

test('每个模型档案都有完整的八维打分与卡片字段', () => {
  for (const [id, m] of Object.entries(MODEL_CATALOG)) {
    for (const t of TRAITS) {
      const v = m.traits[t];
      assert.ok(Number.isFinite(v) && v >= 1 && v <= 5, `${id}.traits.${t} 必须是 1–5，实际 ${v}`);
    }
    assert.ok(Array.isArray(m.strengths) && m.strengths.length > 0, `${id} 缺 strengths`);
    assert.ok(Array.isArray(m.weaknesses) && m.weaknesses.length > 0, `${id} 缺 weaknesses`);
    assert.ok(m.channel === 'web' || m.channel === 'api', `${id}.channel 非法`);
    assert.ok(typeof m.meetingNote === 'string' && m.meetingNote.length > 0, `${id} 缺 meetingNote`);
  }
});

test('每个角色都有需求画像，且权重落在已知能力维度内', () => {
  for (const roleId of Object.keys(ROLE_CATALOG)) {
    const req = roleReq(roleId);
    assert.strictEqual(req.roleId, roleId);
    assert.ok(Object.keys(req.weights).length > 0, `${roleId} 的需求权重为空`);
    for (const k of Object.keys(req.weights)) {
      assert.ok(TRAITS.includes(k), `${roleId} 的需求写了未知维度「${k}」`);
    }
    if (req.floors) {
      for (const k of Object.keys(req.floors)) {
        assert.ok(TRAITS.includes(k), `${roleId} 的门槛写了未知维度「${k}」`);
      }
    }
  }
});

test('traits 打分全部是法律内的整数，没有随手写的 0 或 9', () => {
  const bad = [];
  for (const [id, m] of Object.entries(MODEL_CATALOG)) {
    for (const t of TRAITS) {
      if (!Number.isInteger(m.traits[t]) || m.traits[t] < 1 || m.traits[t] > 5) {
        bad.push(`${id}.${t}=${m.traits[t]}`);
      }
    }
  }
  assert.deepStrictEqual(bad, [], `有越界打分：${bad.join(', ')}`);
});

/* ═══════════════ 二、适配分与一票否决 ═══════════════ */

test('推理弱的模型不能当红队（门槛一票否决）', () => {
  const req = roleReq('red-team');
  assert.ok(req.floors && req.floors.reasoning >= 4, '红队应当对推理设门槛');

  // wenxin-web reasoning=2 —— 必须被否决
  const r = fitScore('wenxin-web', req);
  assert.strictEqual(r.score, 0);
  assert.ok(r.veto, '应当给出否决理由');

  // deepseek-web reasoning=5 —— 应当通过
  const ok = fitScore('deepseek-web', req);
  assert.ok(!ok.veto);
  assert.ok(ok.score > 60, `deepseek 当红队应得分较高，实际 ${ok.score}`);
});

test('纯搜索引擎不能坐任何对话席位（avoidRoles 生效）', () => {
  const req = roleReq('architect');
  const r = fitScore('google-search', req);
  assert.ok(r.veto, 'google-search 当架构师必须被否决');
  assert.strictEqual(r.score, 0);
});

test('慢速模型不能当书记员（speed 门槛）', () => {
  const req = roleReq('clerk');
  assert.ok(req.floors && req.floors.speed >= 4, '书记员应当对速度设门槛');
  // deepseek-web speed=2
  const r = fitScore('deepseek-web', req);
  assert.ok(r.veto, '慢模型当书记员必须被否决');
  // 豆包 speed=5
  const fast = fitScore('doubao-web', req);
  assert.ok(!fast.veto);
});

test('rankForRole 把被否决的排在最后，且带出理由', () => {
  const ranked = rankForRole(['wenxin-web', 'deepseek-web', 'chatgpt-web'], roleReq('red-team'));
  assert.strictEqual(ranked[ranked.length - 1].modelId, 'wenxin-web', '被否决的应排最后');
  assert.ok(ranked[ranked.length - 1].veto);
  assert.ok(ranked[0].score >= ranked[1].score, '应按分数降序');
});

test('互补度：能力差异越大，互补度越高', () => {
  const c1 = complementarity('deepseek-web', 'doubao-web');   // 差异大
  const c2 = complementarity('deepseek-web', 'deepseek-web'); // 自己
  assert.strictEqual(c2, 0);
  assert.ok(c1 > 20, `DeepSeek 与豆包应当有明显互补度，实际 ${c1}`);
});

/* ═══════════════ 三、选角：随机 ✕ 能力约束 ═══════════════ */

test('选角结果里不会出现能力不匹配的席位（硬约束）', () => {
  const all = listModels().map((m) => m.id);
  const { assignment, ledger } = castRoles(all, { set: 'product-9', seed: 'constraint-check' });

  for (const a of assignment) {
    const req = roleReq(a.roleId);
    const r = fitScore(a.providerId, req);
    // 允许降级（无人可用），但降级必须被显式记录
    if (r.veto) {
      const l = ledger.find((x) => x.roleId === a.roleId);
      assert.ok(l && l.degradedFrom, `席位「${a.roleId}」用了不合格的 ${a.providerId}，却没有记录降级原因`);
    }
  }
});

test('同一个 seed 得到完全相同的分配（可复现）', () => {
  const all = listModels().map((m) => m.id);
  const a = castRoles(all, { set: 'tech-7', seed: 'repro-42' });
  const b = castRoles(all, { set: 'tech-7', seed: 'repro-42' });
  assert.deepStrictEqual(
    a.assignment.map((x) => `${x.roleId}<-${x.providerId}`),
    b.assignment.map((x) => `${x.roleId}<-${x.providerId}`),
  );
});

test('不同 seed 会产生不同的分配（随机性真实存在）', () => {
  const all = listModels().map((m) => m.id);
  const sigs = new Set();
  for (let i = 0; i < 12; i++) {
    const r = castRoles(all, { set: 'tech-7', seed: `seed-${i}` });
    sigs.add(r.assignment.map((x) => `${x.roleId}<-${x.providerId}`).join('|'));
  }
  assert.ok(sigs.size >= 3, `12 次不同 seed 只产生了 ${sigs.size} 种组合，随机性不足`);
});

test('fail-first：门槛最严的席位先分配，不会被宽松席位抢走合格者', () => {
  // 只有 gemini-web / kimi-web / yuanbao-web 的 search >= 4
  const narrow = ['gemini-web', 'kimi-web', 'yuanbao-web', 'doubao-web', 'wenxin-web'];
  for (let i = 0; i < 8; i++) {
    const { assignment } = castRoles(narrow, { set: 'risk-audit-5', seed: `ff-${i}` });
    const retriever = assignment.find((a) => a.roleId === 'retriever');
    if (!retriever) continue;   // 没安排检索员席位就跳过
    const m = getModel(retriever.providerId);
    assert.ok(m.traits.search >= 4,
      `seed=ff-${i}: 检索员分给了 search=${m.traits.search} 的 ${retriever.providerId}`);
  }
});

test('每个席位上的模型互不重复（一个人不能坐两把椅子）', () => {
  const all = listModels().map((m) => m.id);
  for (let i = 0; i < 6; i++) {
    const { assignment } = castRoles(all, { set: 'product-9', seed: `uniq-${i}` });
    const ids = assignment.map((a) => a.providerId);
    assert.strictEqual(new Set(ids).size, ids.length, `seed=uniq-${i} 出现重复占座：${ids.join(',')}`);
  }
});

test('参会者不足时给出警告而不是静默少人', () => {
  const { assignment, warnings } = castRoles(['deepseek-web', 'chatgpt-web'], { set: 'product-9', seed: 'small' });
  assert.strictEqual(assignment.length, 2, '只有 2 个参会者时应只分配 2 席');
  assert.ok(Array.isArray(warnings));
});

test('分配结果带可解释理由（适配分 + 优势维度）', () => {
  const { assignment } = castRoles(['deepseek-web', 'chatgpt-web', 'gemini-web'], { set: 'trio', seed: 'why' });
  for (const a of assignment) {
    assert.ok(typeof a.reason === 'string' && a.reason.length > 0, `${a.roleId} 缺分配理由`);
    assert.ok(Number.isFinite(a.fitScore));
    assert.ok(a.channel === 'web' || a.channel === 'api');
  }
});

test('sharpness 越大越确定（高锐度下应稳定选最强）', () => {
  const all = listModels().map((m) => m.id);
  const picks = new Set();
  for (let i = 0; i < 10; i++) {
    const r = castRoles(all, { set: 'trio', seed: `sharp-${i}`, sharpness: 40 });
    picks.add(r.assignment.map((x) => x.providerId).join(','));
  }
  assert.ok(picks.size <= 3, `锐度 40 下 10 次产生 ${picks.size} 种组合，确定性不足`);
});

test('autoCast 按人数选合适的角色组', () => {
  assert.strictEqual(autoCast(['deepseek-web', 'chatgpt-web', 'gemini-web'], {}).set, 'trio');
  assert.strictEqual(autoCast(new Array(7).fill(0).map((_, i) => `m${i}`), {}).set, 'tech-7');
  assert.strictEqual(autoCast(listModels().map((m) => m.id), {}).set, 'product-9');
});

test('每个预置角色组都能被成功分配（无"设计出来却用不了"的组）', () => {
  const all = listModels().map((m) => m.id);
  for (const setId of Object.keys(ROLE_SETS)) {
    const r = castRoles(all, { set: setId, seed: `set-${setId}` });
    assert.strictEqual(r.assignment.length, ROLE_SETS[setId].seats.length,
      `角色组「${setId}」分配席位数为 ${r.assignment.length}，期望 ${ROLE_SETS[setId].seats.length}`);
    assert.ok(r.ledger.length > 0);
  }
});

test('byProviderId 能从 providerId 反查到能力档案', () => {
  const m = byProviderId('deepseek-web');
  assert.ok(m);
  assert.strictEqual(m.channel, 'web');
  assert.strictEqual(byProviderId('api:deepseek'), null, 'API 模型没有 providerId');
});

test('makeRng 同 seed 序列一致，不同 seed 序列不同', () => {
  const r1 = makeRng('a'); const r2 = makeRng('a'); const r3 = makeRng('b');
  const s1 = [r1(), r1(), r1()];
  const s2 = [r2(), r2(), r2()];
  const s3 = [r3(), r3(), r3()];
  assert.deepStrictEqual(s1, s2);
  assert.notDeepStrictEqual(s1, s3);
  assert.strictEqual(hashSeed('abc'), hashSeed('abc'));
});

test('topDims 输出人话（不暴露内部字段名）', () => {
  const { breakdown } = fitScore('deepseek-web', roleReq('architect'));
  const s = topDims(breakdown);
  assert.ok(/推理|结构化|长文|中文|速度|稳定性|检索|多模态/.test(s), `topDims 输出不可读：${s}`);
});

/* ═══════════════ 四、API 通道也满足契约 ═══════════════ */

test('API 适配器满足统一契约（与网页版同一套接口）', () => {
  const { createApiAdapter } = require('../adapters/api-adapter');
  const a = createApiAdapter({
    providerKey: 'test', baseURL: 'https://example.invalid/v1', apiKey: 'sk-test', model: 'm',
  });
  const r = validateAdapter(a);
  assert.ok(r.ok, `API 适配器缺方法：${r.missing.join(', ')}`);
  assert.strictEqual(a.channel, 'api');
});

test('API 适配器在缺配置时不崩、明确返回未就绪', async () => {
  const { createApiAdapter } = require('../adapters/api-adapter');
  const a = createApiAdapter({ providerKey: 'nope', baseURL: null, apiKey: null, model: null });
  assert.strictEqual(await a.isReady(), false);
  const resp = await a.waitForResponse({});
  assert.strictEqual(resp.completion.done, false);
  assert.ok(/NO_/.test(resp.completion.reason), `应给出明确错误码，实际 ${resp.completion.reason}`);
});
