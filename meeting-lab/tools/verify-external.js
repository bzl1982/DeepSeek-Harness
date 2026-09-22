'use strict';
/**
 * tools/verify-external.js —— 验证「外部 AI 回答」在**渲染进程里**真的可用
 *
 * 为什么不能只跑单测：
 *   单测证明 core 是对的；但用户摸到的是页面 —— 面板有没有渲染、粘贴后
 *   是不是真的进了会议状态、它到底能不能被后续阶段的切片看见，
 *   这三件事只有连着真实 renderer 跑才算数。
 *
 * 用法: node tools/verify-external.js 9223
 */
const http = require('http');
const fs = require('fs');

const PORT = process.argv[2] || '9223';

function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

(async () => {
  const list = await get('/json/list');
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.log('✖ 找不到页面 target'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (m, p) => new Promise((r) => {
    const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const res = r.result;
    if (res && res.exceptionDetails) {
      return { __err: `${res.exceptionDetails.text} ${(res.exceptionDetails.exception || {}).description || ''}`.slice(0, 300) };
    }
    return res && res.result ? res.result.value : null;
  };

  let pass = 0; let fail = 0;
  const check = (name, ok, detail) => {
    if (ok) { pass += 1; console.log(`  ✔ ${name}`); }
    else { fail += 1; console.log(`  ✖ ${name}${detail ? `\n      ${detail}` : ''}`); }
  };

  console.log('\n── ⓪ 重置状态 ──');
  /* ★ 必须先重置，否则脚本**不幂等**：
   *   第二次运行时上一次贴进去的外部回答还在 → "初始 0 条" 与 "徽章变 1 条" 必然失败，
   *   看起来像功能坏了，其实是脚本自己脏了。 */
  const reset = await ev(`(() => {
    meeting.messages = meeting.messages.filter((m) => m.senderType !== 'external');
    const box = document.getElementById('extbox');
    if (box) box.classList.remove('open');
    const t = document.getElementById('ext-text');
    if (t) t.value = '';
    const q = document.getElementById('ext-question');
    if (q) q.value = '';
    if (typeof renderExternalCount === 'function') renderExternalCount();
    return meeting.messages.filter((m) => m.senderType === 'external').length;
  })()`);
  check('重置后外部回答为 0 条（脚本可重复运行）', reset === 0, `remaining=${reset}`);

  console.log('\n── ① 面板存在与初始状态 ──');
  const dom = await ev(`(() => {
    const box = document.getElementById('extbox');
    if (!box) return { box: false };
    const sel = document.getElementById('ext-source');
    return {
      box: true,
      collapsed: !box.classList.contains('open'),
      options: sel ? sel.options.length : -1,
      count: (document.getElementById('ext-count') || {}).textContent,
      addDisabled: (document.getElementById('ext-add') || {}).disabled,
      hasHelper: !!document.querySelector('#extbox .note'),
    };
  })()`);
  if (dom && dom.__err) { console.log(`  ✖ 页面求值异常：${dom.__err}`); process.exit(1); }
  check('外部回答面板已渲染', dom && dom.box === true, JSON.stringify(dom));
  check('默认折叠（不抢日志空间）', dom && dom.collapsed === true);
  check('来源下拉已填充（常见外部 AI）', dom && dom.options >= 8, `options=${dom && dom.options}`);
  check('初始计数为 0 条', dom && /^0 条$/.test(dom.count || ''), `count=${dom && dom.count}`);
  check('正文为空时按钮禁用（防空提交）', dom && dom.addDisabled === true);

  console.log('\n── ② 真的粘贴一条外部回答 ──');
  const before = await ev(`meeting.messages.filter(m => m.senderType === 'external').length`);
  await ev(`(() => {
    const t = document.getElementById('ext-text');
    t.value = '【元宝】我认为应该先冻结接口契约，再分头实现。';
    t.dispatchEvent(new Event('input'));
    document.getElementById('ext-add').click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const after = await ev(`(() => {
    const ext = meeting.messages.filter(m => m.senderType === 'external');
    const last = ext[ext.length - 1];
    return {
      n: ext.length,
      senderId: last && last.senderId,
      provider: last && last.external && last.external.provider,
      model: last && last.external && last.external.model,
      content: last && last.content,
      keepsLabel: last ? /[【】]/.test(last.content) : null,
      countText: (document.getElementById('ext-count') || {}).textContent,
      cleared: document.getElementById('ext-text').value === '',
      listItems: document.querySelectorAll('#ext-list .item').length,
    };
  })()`);
  check('外部回答已写入 meeting.messages', after && after.n === before + 1, `before=${before} after=${after && after.n}`);
  check('senderId 走 external:<来源> 命名空间', after && after.senderId === 'external:元宝', `senderId=${after && after.senderId}`);
  check('来源【元宝】被识别', after && after.provider === '元宝', `provider=${after && after.provider}`);
  check('标注被剥掉、不混进正文', after && after.keepsLabel === false, `content=${after && after.content}`);
  check('计数徽章已刷新', after && after.countText === '1 条', `count=${after && after.countText}`);
  check('列表出现这条记录', after && after.listItems >= 1, `items=${after && after.listItems}`);
  check('提交后输入框清空', after && after.cleared === true);

  console.log('\n── ③ ★ 关键：它真的能被后续阶段的切片看见吗 ──');
  const slice = await ev(`(() => {
    const msgs = meeting.messages
      .filter(m => m.senderType === 'agent' || m.senderType === 'external')
      .map(m => ({ senderId: m.senderId, content: m.content, kind: m.kind }));
    const others = selectSlice(SLICE.OTHERS, { messages: msgs, selfId: 'deepseek-web' });
    const all = selectSlice(SLICE.ALL, { messages: msgs, selfId: 'deepseek-web' });
    return {
      inOthers: others.text.includes('冻结接口契约'),
      inAll: all.text.includes('冻结接口契约'),
      othersLen: others.text.length,
      externalCount: msgs.filter(m => m.senderId.startsWith('external:')).length,
    };
  })()`);
  check('★ OTHERS 切片能看到外部回答（否则那圈外部咨询白问）', slice && slice.inOthers === true, JSON.stringify(slice));
  check('★ ALL 切片能看到外部回答', slice && slice.inAll === true);

  console.log('\n── ④ 多种粘贴格式都能识别 ──');
  const formats = await ev(`(() => {
    const cases = [
      ['【谷歌】资料在官方文档里。', '谷歌'],
      ['--- 混元的回答 ---\\n建议用名次不用分数。', '混元'],
      ['Kimi: 长文本建议分块喂。', 'Kimi'],
      ['我觉得应该这样做：先写测试，再写实现。', null],
    ];
    return cases.map(([raw, want]) => {
      const r = parsePastedLabel(raw);
      return { raw: raw.slice(0, 22), got: r.provider, want, ok: r.provider === want };
    });
  })()`);
  for (const f of (formats || [])) {
    check(`「${f.raw}…」→ ${f.want === null ? '不识别（正文冒号别误伤）' : `识别为 ${f.want}`}`, f.ok, `got=${f.got}`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`外部回答面板验证：${pass}/${pass + fail} 项通过`);
  console.log('═'.repeat(60));

  /* 可选截图：展开面板后再拍，方便直观看到新功能 */
  const si = process.argv.indexOf('--shot');
  if (si >= 0) {
    const file = process.argv[si + 1] || 'ui-external.png';
    await ev("document.getElementById('extbox').classList.add('open'); true");
    await new Promise((r) => setTimeout(r, 400));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      console.log(`截图已存 ${file}（面板；已展开）`);
    }
  }

  ws.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('验证脚本自身出错：', e.message);
  process.exit(1);
});
