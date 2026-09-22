'use strict';
/**
 * core/reporter.js —— 会议记录 MD 生成器
 *
 * 职责（对应需求：每一轮都要生成「会议记录 + 每个人回答的全部内容」的 MD 文件）：
 *   - writeRoundMarkdown()  ：单轮文件 round-N.md，含本轮议题 + 每个参会者完整回答（标注名字）
 *   - writeMasterRecord()   ：累计汇总 会议记录.md，按轮次堆叠所有人的回答
 *
 * 纯 Node、无 GUI 依赖。落盘位置由调用方传入的 outDir 决定（默认 meeting-lab/meetings/<会话>/）。
 */

const fs = require('fs');
const path = require('path');

/** 递归建目录（幂等） */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把议题/任意串压成安全的目录/文件名片段 */
function slug(s, max = 40) {
  const out = String(s || 'meeting')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, max);
  return out || 'meeting';
}

function displayName(names, id) {
  return (names && names[id]) || id;
}

/**
 * 生成单轮 MD。
 * @param {object} opts
 *   - outDir   输出目录（已存在）
 *   - meeting  Meeting 实例
 *   - round    轮次
 *   - names    { providerId: 显示名 }
 *   - topic    议题（兜底用 meeting.topic）
 */
function writeRoundMarkdown({ outDir, meeting, round, names = {}, topic = '' }) {
  const msgs = meeting
    .messagesInRound(round)
    .filter((m) => m.senderType === 'agent' && m.status === 'completed');

  const L = [];
  L.push(`# 通辽会议 · 第 ${round} 轮`);
  L.push('');
  L.push(`- **议题**：${topic || meeting.topic}`);
  L.push(`- **时间**：${new Date().toLocaleString('zh-CN')}`);
  L.push(`- **本轮发言人数**：${msgs.length}`);
  if (round >= 2) {
    L.push(`- **上下文**：本轮已向下传达「第 ${round - 1} 轮」各方发言（见 round-${round - 1}.md）`);
  }
  L.push('');
  L.push('## 本轮发言（按参会者）');
  L.push('');

  if (!msgs.length) {
    L.push('_本轮无人成功发言。_');
  } else {
    for (const m of msgs) {
      const who = displayName(names, m.senderId);
      L.push(`### ${who} \`${m.senderId}\``);
      L.push('');
      L.push((m.content || '_（空）_').trim());
      L.push('');
    }
  }

  const file = path.join(outDir, `round-${round}.md`);
  fs.writeFileSync(file, L.join('\n'), 'utf8');
  return file;
}

/**
 * 重写累计会议记录 会议记录.md（汇总全部轮次）。
 */
function writeMasterRecord({ outDir, meeting, names = {} }) {
  // 以"实际有 agent 发言的轮次"为准，避免最后一轮被漏记
  const roundsWithMsgs = new Set(
    meeting.messages
      .filter((m) => m.senderType === 'agent' && m.status === 'completed')
      .map((m) => m.round),
  );
  const maxRound = roundsWithMsgs.size ? Math.max(...roundsWithMsgs) : 0;

  const L = [];
  L.push('# 通辽会议 · 会议记录（汇总）');
  L.push('');
  L.push(`- **议题**：${meeting.topic}`);
  L.push(`- **会议 ID**：${meeting.meetingId}`);
  L.push(`- **生成时间**：${new Date().toLocaleString('zh-CN')}`);
  L.push(`- **总轮次**：${maxRound}`);
  L.push('');

  for (let r = 1; r <= maxRound; r++) {
    const msgs = meeting
      .messagesInRound(r)
      .filter((m) => m.senderType === 'agent' && m.status === 'completed');
    if (!msgs.length) continue;
    L.push(`## 第 ${r} 轮`);
    L.push('');
    for (const m of msgs) {
      const who = displayName(names, m.senderId);
      L.push(`### ${who}`);
      L.push('');
      L.push((m.content || '').trim());
      L.push('');
    }
    L.push('---');
    L.push('');
  }

  const file = path.join(outDir, '会议记录.md');
  fs.writeFileSync(file, L.join('\n'), 'utf8');
  return file;
}

module.exports = { ensureDir, slug, displayName, writeRoundMarkdown, writeMasterRecord };
