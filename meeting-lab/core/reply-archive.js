'use strict';
/**
 * core/reply-archive.js —— 网页 AI 回复归档（2026-09-25 用户需求）
 *
 * 规矩：
 *   1. 一个对话窗口（席位）一个 MD 文件，放 meeting-lab/replies/ 下；
 *   2. 同一个窗口后续回复【续写追加】到同一个文件，绝不覆盖；
 *   3. 每条回复带时间戳头 + 来源（dom=AI 主线自动收 / clipboard=剪贴板兜底）。
 *
 * A 主线（DOM Observer）与 B 兜底（剪贴板监听）都汇到这一个出口。
 */

const fs = require('fs');
const path = require('path');

const baseDir = path.join(__dirname, '..', 'replies');

/** 文件名安全化：席位显示名 → 文件名（去非法字符，限长） */
function safeName(s) {
  return (s || 'unnamed').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
}

/** 某席位对应的归档文件绝对路径 */
function seatFile(seat) {
  return path.join(baseDir, safeName(seat) + '.md');
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 追加一条回复到席位归档文件。
 * @returns {string} 归档文件绝对路径
 */
function appendReply({ seat, platform, text, source, url }) {
  const body = (text || '').trim();
  if (!body) return null;
  fs.mkdirSync(baseDir, { recursive: true });
  const f = seatFile(seat);
  if (!fs.existsSync(f)) {
    const head = [
      `# ${seat} · AI 回复归档`,
      '',
      '> 一个对话窗口一个文件；同一窗口后续回复自动续写追加到本文件。',
      '> 来源：通辽会议测试台 Reply Bridge（dom=网页自动采集 / clipboard=剪贴板兜底）。',
      '',
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(f, head, 'utf8');
  }
  const src = source === 'clipboard' ? '剪贴板兜底' : '网页采集';
  const entry = [
    `## ${ts()} · ${platform || seat} · ${src}`,
    '',
    body,
    '',
    '---',
    '',
  ].join('\n');
  fs.appendFileSync(f, entry, 'utf8');
  return f;
}

/** 简易 djb2 hash（去重用，跨进程一致即可） */
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

module.exports = { appendReply, seatFile, baseDir, hash, safeName };
