'use strict';
/**
 * adapters/web-adapter.js —— WebAI Adapter 通用工厂 + 页面侧信号采集脚本
 *
 * 六家咨询的共识 #2：DOM 选择器绝不能写死进编排层。
 * 这里把「选择器」收敛成一份 profile（可配置/可热修），
 * 把「采集逻辑」写成一个在页面里执行的探针脚本，返回结构化信号。
 *
 * 关键：完成检测的信号来源就在这里（对应 core/completion.js 的 5 个信号）。
 *   stopGone      Stop generating 按钮消失      ← 探针
 *   sendReady     Send 按钮恢复可用             ← 探针
 *   genFlagGone   "生成中"标志位消失            ← 探针
 *   domStable     回答内容连续 N ms 无变化       ← 探针返回 text，Node 侧比对
 *   streamEnd     流式请求结束                  ← 由 CDP Network 域注入（shell 侧）
 *
 * driver 抽象（让 adapter 不依赖 Electron，可被替换/测试）：
 *   {
 *     evaluate(script) -> Promise<any>    在页面执行脚本并返回 JSON
 *     sendText(text)   -> Promise<void>   原生输入 + 回车
 *     setFiles(paths)  -> Promise<boolean> CDP DOM.setFileInputFiles
 *     isReady()        -> Promise<boolean>
 *     cancel()         -> Promise<void>
 *     onStreamEnd(cb)  -> void|null       可选：流式请求结束回调
 *   }
 */

const { SIGNALS, RESULT } = require('../core/completion');
const { StreamTracker } = require('../core/stream-tracker');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面侧探针：一次执行，返回全部信号 + 当前回答文本 */
function buildProbeScript(profile) {
  return `(function(){
  var P = ${JSON.stringify(profile)};
  function qa(sels, root){
    var out = [];
    for (var i = 0; i < sels.length; i++) {
      try {
        var found = (root || document).querySelectorAll(sels[i]);
        for (var j = 0; j < found.length; j++) out.push(found[j]);
      } catch (e) {}
    }
    return out;
  }
  function q(sels, root){
    var list = qa(sels, root);
    return list.length ? list[0] : null;
  }
  function visible(el){
    if (!el) return false;
    try {
      var r = el.getBoundingClientRect();
      return el.offsetParent !== null && r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  }
  function firstVisible(sels){
    var list = qa(sels);
    for (var i = 0; i < list.length; i++) if (visible(list[i])) return list[i];
    return null;
  }

  var stopBtn   = firstVisible(P.stop || []);
  var sendBtn   = firstVisible(P.send || []);
  var genFlag   = firstVisible(P.generating || []);
  var attachEls = qa(P.attachment || []).filter(visible);

  // 取最后一条 assistant 消息文本
  var msgs = qa(P.assistant || []).filter(visible);
  var last = msgs.length ? msgs[msgs.length - 1] : null;
  var text = last ? (last.innerText || '').trim() : '';

  return {
    ok: true,
    url: location.href,
    text: text,
    textLen: text.length,
    msgCount: msgs.length,
    attachCount: attachEls.length,
    signals: {
      stopGone:    !stopBtn,
      sendReady:   !!(sendBtn && !sendBtn.disabled),
      genFlagGone: !genFlag
    }
  };
})()`;
}

/**
 * 创建一个 WebAI Adapter。
 * @param {object} opts
 *   - id / name
 *   - profile        选择器配置（见 deepseek-web.js / generic-web.js）
 *   - driver         页面操作抽象
 *   - pollMs         探针轮询间隔（默认 400ms）
 *   - streamTrackerOpts  传给 StreamTracker（idleMs / armGraceMs / matchAll ...）
 *   - requireContent 是否要求「必须先看到非空回答」才算完成（默认 true）
 */
function createWebAdapter({
  id,
  name,
  profile,
  driver,
  pollMs = 400,
  streamTrackerOpts = {},
  requireContent = true,
}) {
  if (!driver) throw new Error(`createWebAdapter(${id}): driver required`);
  if (!profile) throw new Error(`createWebAdapter(${id}): profile required`);

  const probeScript = buildProbeScript(profile);

  /**
   * ★ 流结束信号（信号 D）。
   *
   * v1 的错法（已修）：
   *   let streamEnded = false;
   *   driver.onStreamEnd(() => { streamEnded = true; });   // 永久闩锁
   *   ...
   *   if (streamEnded) detector.feed(SIGNALS.STREAM_END, true);  // 第二轮瞬间误判完成
   *
   * 现在改为每轮 arm() 的 StreamTracker：
   *   - sendText 时 arm()，清零上一轮
   *   - CDP Network 事件持续喂入
   *   - 只在「见过流 + 全部结束 + 静默够久」时给 true
   */
  const tracker = new StreamTracker(streamTrackerOpts);

  /**
   * ★ 本轮「基线快照」（2026-09-22 第四轮新增，修假阳性完成）。
   *
   * 完成检测必须基于【增量】而不是【存在】——这是实测踩出来的：
   *   在已登录、页面本来就有内容的真实场景下（欢迎语 / 历史对话 / 我们的 prompt 回显），
   *   第一次探测就能读到非空文本 → 原实现立刻 sawContent=true →
   *   页面又恰好稳定（AI 根本没在生成）→ **1 秒内判定"回答完成"**。
   *   实测：Gemini 932ms、ChatGPT 1121ms 假完成，会议记录里存下的是
   *   「需要我为你做些什么？」（欢迎语）和「你是【红队评审】…」（我们自己的 prompt 回显）。
   *
   * 为什么基线要在【发送之后】抓：发送前输入框是空的，发送后页面才会出现"用户消息"。
   * 若在发送前抓，后续新增里会混进我们自己的 prompt 回显（ChatGPT 正是这样被误判的）。
   */
  let baselineText = null;
  let baselineMsgCount = null;


  /**
   * 把 Electron webContents.debugger 挂到 tracker 上。
   * driver.attachNetwork(cb) 由 shell 侧实现：
   *   cb((method, params) => tracker.handleEvent(method, params))
   * 返回值是 detach 函数（可选）。
   */
  let detachNetwork = null;
  if (typeof driver.attachNetwork === 'function') {
    try {
      detachNetwork = driver.attachNetwork((method, params) => tracker.handleEvent(method, params));
    } catch (e) {
      detachNetwork = null; // 接不上就退回纯 DOM 信号，不影响可用性
    }
  }

  return {
    id,
    name: name || id,
    profile,

    async isReady() {
      if (typeof driver.isReady === 'function') {
        const ok = await driver.isReady();
        if (!ok) return false;
      }
      try {
        const r = await driver.evaluate(probeScript);
        return !!(r && r.ok);
      } catch (e) {
        return false;
      }
    },

    /**
     * 投递附件 —— 必须回报 ACK（这是"先上传齐再发送"门闩的基础）。
     * 用 CDP DOM.setFileInputFiles 直接塞文件，不模拟"点上传→文件选择器→输路径"。
     */
    async uploadFiles(attachments = [], { onAck } = {}) {
      const failed = [];
      for (const att of attachments) {
        let ok = false;
        let error = null;
        try {
          ok = await driver.setFiles([att.localPath]);
        } catch (e) {
          ok = false;
          error = 'UPLOAD_FAILED';
        }
        if (!ok) {
          failed.push(att.attachmentId);
          if (onAck) onAck(att.attachmentId, false, { error: error || 'UPLOAD_FAILED' });
          continue;
        }

        // ★ 等到页面真的出现附件卡片才算 ACK（不是"调用了 API"就算成功）
        const acked = await waitAttachCard(driver, probeScript, attachments.length);
        if (onAck) onAck(att.attachmentId, acked, { error: acked ? null : 'UPLOAD_FAILED' });
        if (!acked) failed.push(att.attachmentId);
      }
      return { ok: failed.length === 0, failed, error: failed.length ? 'UPLOAD_FAILED' : null };
    },

    async sendText(text) {
      // ★ 每轮发言重新武装网络观察，绝不能沿用上一轮的结论
      tracker.arm();
      baselineText = null;
      baselineMsgCount = null;
      const sent = await driver.sendText(text);
      // ★ 发送后留 700ms 让"用户消息"先上屏，再抓基线：
      //   这样后续的"新增文本"才是 AI 的回复，而不是我们自己的 prompt 回显。
      await sleep(700);
      try {
        const pre = await driver.evaluate(probeScript);
        if (pre && pre.ok) {
          baselineText = pre.text || '';
          baselineMsgCount = pre.msgCount || 0;
        }
      } catch (e) {
        baselineText = null; // 探针失败 → 退回无基线的旧行为，宁可漏判也不卡死
        baselineMsgCount = null;
      }
      return sent;
    },

    /**
     * 等待回复 + 判定"答完了"。
     * 核心：多信号联合（详见 core/completion.js），绝不能固定 sleep。
     *
     * ★ 两个曾经会误判的地方，现已堵上：
     *   1) domStable 起手即真 → 只要 sendReady 也为真就"零信号完成"（抓空回复）
     *      → 现在 domStable 只在「看到非空回答后」才置真
     *   2) streamEnd 永久闩锁 → 第二轮瞬间完成
     *      → 现在是每轮 arm() 的 StreamTracker
     */
    async waitForResponse({ detector, timeoutMs = 120000 } = {}) {
      const started = Date.now();
      let lastText = null;
      let sawContent = false; // ★ 是否已经看到"相对基线新增的"回答
      let everStreamEnded = false; // ★ 本轮是否出现过 streamEnd（防止后续抖回 false）

      /**
       * ★ 存在 ≠ 新增：这是修假阳性完成的核心判据。
       * 页面里本来就有内容（欢迎语/历史消息/prompt 回显）绝不能算"AI 已回复"。
       */
      const hasNewContent = (full) => {
        const f = full || '';
        if (f.trim().length === 0) return false;
        if (baselineText === null) return true; // 无基线（探针失败）→ 退回旧行为
        if (f.startsWith(baselineText)) return f.length > baselineText.length;
        return f !== baselineText; // 页面被整体替换（如新建会话）→ 视为有新增
      };

      /** ★ 写进会议记录的应是「本轮增量」，不是整页文本 */
      const replyDelta = (full) => {
        const f = (full || '').trim();
        if (baselineText === null || !baselineText) return f;
        if (f.startsWith(baselineText)) return f.slice(baselineText.length).trim();
        return f;
      };

      while (Date.now() - started < timeoutMs) {
        let probe = null;
        try {
          probe = await driver.evaluate(probeScript);
        } catch (e) {
          probe = null;
        }

        if (probe && probe.ok) {
          const text = probe.text || '';
          if (text !== lastText) {
            // 内容变了 → 重置 DOM 稳定计时
            detector.touchContent();
            lastText = text;
            // ★ 只有"相对基线确有新增"才算看到了 AI 的回复（修假阳性完成）
            if (hasNewContent(text)) sawContent = true;
          }

          // ★ 信号 D：CDP 网络流结束（不依赖 DOM，改版时最后一道保险）
          const st = tracker.status();
          if (st.streamEnd) everStreamEnded = true;
          detector.feed(SIGNALS.STREAM_END, everStreamEnded);

          const domSignals = [SIGNALS.STOP_GONE, SIGNALS.SEND_READY, SIGNALS.GEN_FLAG_GONE];

          if (requireContent && !sawContent) {
            // 还没看到任何回答 → 不喂 DOM 信号，防止"空页面"被当成答完
            for (const s of domSignals) detector.feed(s, false);
            detector.feed(SIGNALS.DOM_STABLE, false);
          } else {
            detector.feed(SIGNALS.STOP_GONE, !!probe.signals.stopGone);
            detector.feed(SIGNALS.SEND_READY, !!probe.signals.sendReady);
            detector.feed(SIGNALS.GEN_FLAG_GONE, !!probe.signals.genFlagGone);

            // domStable 只在「真的看到了内容」之后才有资格置真
            const quietFor = lastText != null ? Date.now() - (detector.lastContentChangeAt || started) : 0;
            const stable = sawContent && quietFor >= detector.stableMs;
            detector.feed(SIGNALS.DOM_STABLE, stable);

            // 网络还在飞 → 抽掉 domStable，避免"长回答中途长时间无新字"被误判
            if (st.state === 'streaming' && !st.streamEnd) detector.feed(SIGNALS.DOM_STABLE, false);
          }
        }

        const snap = detector.evaluate();
        if (snap.result !== RESULT.PENDING) {
          return { text: replyDelta(lastText), completion: snap, stream: tracker.status() };
        }
        /* eslint-disable-next-line no-await-in-loop */
        await sleep(pollMs);
      }

      detector.evaluate();
      return { text: replyDelta(lastText), completion: detector.snapshot(), stream: tracker.status() };
    },

    async cancel() {
      if (typeof driver.cancel === 'function') return driver.cancel();
      return true;
    },

    /** 主动释放（卸掉 CDP 监听，防止 9 个 webview 长会累积泄漏） */
    dispose() {
      try {
        if (typeof detachNetwork === 'function') detachNetwork();
      } catch (e) { /* ignore */ }
      detachNetwork = null;
      tracker.reset();
    },

    /** 暴露给编排层/UI 做诊断："现在网络在流吗？" */
    streamStatus() {
      return tracker.status();
    },

    /** 供 orchestrator 做"能力探测"（借鉴 Magentic-UI 的思路） */
    async detectCapabilities() {
      try {
        const r = await driver.evaluate(probeScript);
        return {
          provider: id,
          composer: true,
          send: true,
          response: !!r,
          stream: true,
          url: r && r.url,
        };
      } catch (e) {
        return { provider: id, composer: false, send: false, response: false, stream: false };
      }
    },
  };
}

/** 等页面出现附件卡片（ACK 的判据） */
async function waitAttachCard(driver, probeScript, expectAtLeast, { timeoutMs = 15000, stepMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await driver.evaluate(probeScript);
      if (r && r.ok && r.attachCount >= expectAtLeast) return true;
    } catch (e) { /* 探测失败继续等 */ }
    /* eslint-disable-next-line no-await-in-loop */
    await sleep(stepMs);
  }
  return false;
}

module.exports = { createWebAdapter, buildProbeScript, waitAttachCard };
