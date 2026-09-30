'use strict';
/**
 * core/pdf-text.js —— 零依赖 PDF 文本提取（第 8 步，Q9 共识："PDF 默认本地提取文本注入"）
 *
 * 尽力而为策略（DP 的极简方案 + zlib）：
 *   1. 扫描 PDF 字节流里的 stream...endstream 块；
 *   2. 逐块尝试 zlib.inflate（FlateDecode——绝大多数文本 PDF 用它）；
 *   3. 从解压内容抓文字操作符：(...) Tj 与 [...] TJ 的字符串字面量；
 *   4. 处理 \( \) \\ \n \r \t 与八进制 \ddd 转义。
 *
 * 明确不支持的（抛错让用户转文本，Q9 谷歌反例）：
 *   扫描件图片 PDF、CID/十六进制字体编码（输出乱码时丢弃）、加密 PDF。
 * 返回 { text, blocks }；text 为空视为提取失败。
 */

const zlib = require('zlib');

function unescapePdfStr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b' || n === 'f') out += ' ';
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
      const code = parseInt(oct, 8);
      out += code < 256 ? String.fromCharCode(code) : '';
    } else out += n;   // \( \) \\ 及其他
  }
  return out;
}

/** 从一段内容（解压后或未压缩）抓 Tj/TJ 字符串 */
function grabStrings(content, out) {
  // ( ... ) Tj   与   [ ... ] TJ（数组内多个 (..) 串）
  const re = /\((?:\\.|[^\\()])*\)\s*Tj|\[(?:[^\][]|\\.)*\]\s*TJ/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const seg = m[0];
    const strRe = /\((?:\\.|[^\\()])*\)/g;
    let sm;
    let line = '';
    while ((sm = strRe.exec(seg)) !== null) {
      line += unescapePdfStr(sm[0].slice(1, -1));
    }
    if (line.trim()) out.push(line);
  }
}

function extractPdfText(buf) {
  if (buf.length > 2 && buf[0] === 0x25 && buf[1] === 0x50) { /* %PDF 头 OK */ }
  else throw new Error('不是 PDF 文件（缺 %PDF 头）');
  const raw = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) { re.lastIndex = start; continue; }
    const chunk = Buffer.from(raw.slice(start, end), 'latin1');
    // 尝试 inflate（FlateDecode）；失败则当未压缩内容试
    let text = null;
    try { text = zlib.inflateSync(chunk).toString('latin1'); } catch (_) {
      try { text = zlib.inflateRawSync(chunk).toString('latin1'); } catch (_) {}
    }
    const src = text !== null ? text : chunk.toString('latin1');
    const before = out.length;
    grabStrings(src, out);
    if (out.length === before && /\/Image|\/DCTDecode|\/JPXDecode/.test(src)) { /* 图片流，跳过 */ }
    re.lastIndex = end;
  }
  // 兜底：整文件（未压缩 PDF 极少，但试一次）
  if (!out.length) grabStrings(raw, out);
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text || text.length < 4) throw new Error('PDF 未能提取出文本（可能是扫描件/图片型/复杂字体编码）——请转存为 txt/md 后再附加，或用支持 PDF 的多模态模型直接传');
  return { text, blocks: out.length };
}

module.exports = { extractPdfText };
