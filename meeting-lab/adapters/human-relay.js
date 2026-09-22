'use strict';
/**
 * adapters/human-relay.js —— 人工中转席位（Q8）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 工作流 A 里用户"手工把外部 AI 的回答复制粘贴回来"——
 * 这个人工动作必须建模成一个**真实席位**，而不是"手动插一条 message"。
 *
 * 为什么是"真实席位"（§8 的裁决）：
 *   - 插一条 message 进不了"选角"（它没有角色、没有能力画像）
 *   - 进不了"上下文切片"（OTHERS/CONTRACT 都不知道该不该含它）
 *   - 没有"完成检测"（它不会自己说完，要等人粘贴）
 *   这三条缺了任意一条，它就会在编排里变成幽灵——看得见记录、参与不了流程。
 *
 * 所以它是一个**channel:'human' 的 adapter**，实现与其它 adapter 同一套契约：
 *   isReady / uploadFiles / sendText / waitForResponse / cancel
 *   但语义是"等人工粘贴"：
 *     - sendText：把"该你粘贴了"推给 UI（Electron 通知/弹窗）
 *     - waitForResponse：阻塞在"等用户粘贴"的 IPC 事件上
 *     - 超时【不算失败】——人没空就是没空，标记 human-pending，会议其它席位照常
 *
 * 它进 models.js 的 MODEL_CATALOG，能力画像：
 *   稳定=5（不会中途弹验证码）/ 结构化=5（人粘贴前可以整理成结构化）
 *   推理=0（它本身不生成，只是"搬运工"）
 * ─────────────────────────────────────────────────────────────────────
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 创建一个"人工中转"adapter。
 *
 * @param {object} opts
 *   - id               席位名（默认 'human-relay'）
 *   - name             显示名
 *   - notify           (payload) => void    把"该你粘贴了"推给 UI（默认 no-op，测试可注入）
 *   - onReply          (text) => void       用户粘贴回来的接收端（由外部 UI/IPC 调 reply()）
 *   - pendingReplies   可选：预置的待粘贴回答队列（测试用，不依赖 UI）
 *   - timeoutMs        等人粘贴的上限（默认 300000 = 5 分钟；超时不失败，标 human-pending）
 *   - now              时钟注入
 */
function createHumanRelayAdapter({
  id = 'human-relay',
  name = '人工中转',
  notify = null,
  pendingReplies = null,
  timeoutMs = 300000,
  now = () => Date.now(),
} = {}) {
  const log = typeof notify === 'function' ? notify : () => {};
  let waiters = []; // 正在等粘贴的 Promise 解析器
  let queue = Array.isArray(pendingReplies) ? [...pendingReplies] : null;

  function reply(text) {
    // 外部 UI/IPC 调这个，把用户粘贴的内容交给第一个在等的席位
    if (queue && queue.length) {
      // 预置队列模式（测试）：取队首
      const next = queue.shift();
      if (typeof next === 'function') return next();
      return next;
    }
    const w = waiters.shift();
    if (w) w(text != null ? String(text) : '');
    return text;
  }
  return {
    id,
    name,
    channel: 'human',
    /** ★ 与普通席位的差异 1：没有完成检测，人是事实源 */
    isReady: async () => true,
    /** ★ 与普通席位的差异 2：人不需要"上传文件"（粘贴时自己带） */
    uploadFiles: async () => ({ ok: true, failed: [] }),

    async sendText(text) {
      // 把"该你粘贴了"推给 UI
      log({ kind: 'human-relay:request', text });
      return { ok: true };
    },

    /**
     * ★ 与普通席位的差异 3：超时不标记 TIMEOUT（人会迟到，不是机器卡死）。
     * 超时返回 { text:'', completion:{ result:'HUMAN_PENDING' } }，会议继续。
     */
    async waitForResponse({ timeoutMs: t = null } = {}) {
      const limit = t != null ? t : timeoutMs;
      if (queue && queue.length) {
        const next = queue.shift();
        return {
          text: typeof next === 'function' ? await next() : next,
          completion: { result: 'COMPLETED', reason: '预置粘贴' },
        };
      }
      const result = await new Promise((resolve) => {
        let settled = false;
        const finish = (text) => {
          if (settled) return;
          settled = true;
          clearInterval(timer); // ★ 超时/被唤醒时都必须清 timer，否则 setInterval 永不退出（node --test 会挂住）
          resolve(text);
        };
        waiters.push(finish);
        const started = now();
        const timer = setInterval(() => {
          if (now() - started >= limit) {
            // ★ 超时不 resolve 成"回答"，而是标记 human-pending（会议继续，不阻塞其它席位）
            finish(null);
          }
        }, 1000);
      });
      if (result == null) {
        return {
          text: '',
          completion: { result: 'HUMAN_PENDING', reason: `等人工粘贴超时（${limit}ms），会议继续` },
        };
      }
      return { text: result, completion: { result: 'COMPLETED', reason: '人工粘贴' } };
    },

    async cancel() {
      // 清空等待队列（散会时用）
      for (const w of waiters) w('');
      waiters = [];
      return true;
    },

    /** 测试/诊断：当前有多少席位在等粘贴 */
    pendingCount() {
      return waiters.length;
    },

    /** 外部入口：UI 收到用户粘贴后调这个 */
    reply,
  };
}

/**
 * 注册进 MODEL_CATALOG 的能力画像（供 models.js / casting.js 消费）。
 * ★ 关键：推理=0（它不生成，只搬运），稳定/结构化=5（人粘贴前可整理）。
 */
function humanRelayModelEntry() {
  return {
    id: 'human-relay',
    label: '人工中转（外部 AI 粘贴）',
    channel: 'human',
    providerId: 'human-relay',
    traits: {
      reasoning: 0,    // ★ 它本身不推理，是"搬运工"
      chinese: 4,
      structure: 5,    // 人粘贴前可以整理成结构化
      speed: 3,        // 取决于人，给个中等值
      longOutput: 4,
      multimodal: 0,
      search: 0,
      stability: 5,    // ★ 不会中途弹验证码
    },
    strengths: ['把外部 AI 的回答"合法化"进会议（可切片、可选角、可审计）', '人工整理后的粘贴通常比原文更结构化'],
    weaknesses: ['依赖人手速，超时率高', '无法在无人值守的自动会议里使用'],
    notes: 'channel=human，不进正常选角的"能力匹配"（推理 0 会被一票否决），只在【需要"接外部 AI 结论"】时手动指定。',
  };
}

module.exports = { createHumanRelayAdapter, humanRelayModelEntry };
