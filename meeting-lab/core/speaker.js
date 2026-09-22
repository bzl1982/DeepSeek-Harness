'use strict';
/**
 * core/speaker.js —— 发言策略（SpeakerStrategy）
 *
 * 抄自 AutoGen 的编排模型、但不引入其运行时（见《评审与定案》§4.2 裁决三）：
 *   AutoGen: RoundRobinGroupChat / SelectorGroupChat / Manual
 *   这里:    broadcast / round_robin / llm_selector / manual
 *
 * 策略只管"这一轮谁发言、并发还是串行"，
 * 不认识 DOM、不认识网页、不认识微软——这层隔离是全局可替换的前提。
 */

const MODE = Object.freeze({
  PARALLEL: 'parallel', // 同时发言（扇出）
  SEQUENTIAL: 'sequential', // 依次发言（前一个说完再下一个）
});

const STRATEGY = Object.freeze({
  BROADCAST: 'broadcast',
  ROUND_ROBIN: 'round_robin',
  LLM_SELECTOR: 'llm_selector',
  MANUAL: 'manual',
});

const STRATEGY_NAMES = Object.values(STRATEGY);

/**
 * 发言策略基类。
 * decide() 返回 { mode, speakers:[providerId], reason }
 */
class SpeakerStrategy {
  constructor(name) {
    this.name = name;
  }

  /* eslint-disable-next-line no-unused-vars */
  decide(ctx) {
    throw new Error(`${this.name}.decide() not implemented`);
  }
}

/**
 * 广播：所有参会者同时发言。
 * —— 这就是你现在的模式（Broadcast-Led），也是 Phase 0 要打牢的基线。
 */
class BroadcastStrategy extends SpeakerStrategy {
  constructor() {
    super(STRATEGY.BROADCAST);
  }

  decide({ participants = [] }) {
    return { mode: MODE.PARALLEL, speakers: [...participants], reason: 'broadcast all' };
  }
}

/**
 * 轮询：本轮内每个 AI 依次发言一次（串行，天然错峰）。
 * @param {number[]} rotateBy 可选：让每轮的起点轮转，避免总是同一个 AI 先说话
 */
class RoundRobinStrategy extends SpeakerStrategy {
  constructor({ rotate = true } = {}) {
    super(STRATEGY.ROUND_ROBIN);
    this.rotate = rotate;
  }

  decide({ participants = [], round = 1 }) {
    const list = [...participants];
    if (this.rotate && list.length > 0) {
      const start = (round - 1) % list.length;
      return {
        mode: MODE.SEQUENTIAL,
        speakers: [...list.slice(start), ...list.slice(0, start)],
        reason: `round-robin from index ${start}`,
      };
    }
    return { mode: MODE.SEQUENTIAL, speakers: list, reason: 'round-robin' };
  }
}

/**
 * 动态点名：由"主持人 LLM"根据会议记录决定下一个谁发言。
 *
 * ★ 关键约束（六家共识）：主持人【绝不能用网页版】——
 *   网页版单轮延迟 5~30s，做高频调度会拖死整场会议。
 *   必须走便宜稳定的 API（如 DeepSeek API）或本地模型。
 */
class LlmSelectorStrategy extends SpeakerStrategy {
  /**
   * @param {object} opts
   *   - select(ctx) => Promise<{ speaker:string, reason:string }>  主持人决策函数
   *   - allowRevisit 是否允许同一 AI 连续两轮发言
   */
  constructor({ select, allowRevisit = false } = {}) {
    super(STRATEGY.LLM_SELECTOR);
    if (typeof select !== 'function') {
      throw new Error('LlmSelectorStrategy: opts.select must be a function');
    }
    this._select = select;
    this.allowRevisit = allowRevisit;
  }

  async decide({ participants = [], meeting = null, round = 1 }) {
    const recent = meeting
      ? meeting.messages.slice(-12).map((m) => ({ senderId: m.senderId, content: m.content }))
      : [];
    const chosen = await this._select({ participants, round, recent });
    if (!chosen || !chosen.speaker) {
      return { mode: MODE.SEQUENTIAL, speakers: [], reason: 'selector returned nothing' };
    }
    if (!participants.includes(chosen.speaker)) {
      return { mode: MODE.SEQUENTIAL, speakers: [], reason: `selector picked non-participant ${chosen.speaker}` };
    }
    return {
      mode: MODE.SEQUENTIAL,
      speakers: [chosen.speaker],
      reason: chosen.reason || 'llm selector',
      selector: 'llm',
    };
  }
}

/**
 * 手工点名：由用户在 UI 上指定谁发言。
 */
class ManualStrategy extends SpeakerStrategy {
  constructor({ pick = () => [] } = {}) {
    super(STRATEGY.MANUAL);
    this._pick = pick;
  }

  decide(ctx) {
    const speakers = this._pick(ctx) || [];
    return { mode: MODE.SEQUENTIAL, speakers, reason: 'manual pick' };
  }
}

function createStrategy(name, opts = {}) {
  switch (name) {
    case STRATEGY.BROADCAST:
      return new BroadcastStrategy();
    case STRATEGY.ROUND_ROBIN:
      return new RoundRobinStrategy(opts);
    case STRATEGY.LLM_SELECTOR:
      return new LlmSelectorStrategy(opts);
    case STRATEGY.MANUAL:
      return new ManualStrategy(opts);
    default:
      throw new Error(`createStrategy: unknown strategy "${name}"`);
  }
}

module.exports = {
  MODE,
  STRATEGY,
  STRATEGY_NAMES,
  SpeakerStrategy,
  BroadcastStrategy,
  RoundRobinStrategy,
  LlmSelectorStrategy,
  ManualStrategy,
  createStrategy,
};
