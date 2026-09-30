# Electron Webview 注入消息到 AI 网页的咨询求助

## 项目背景

我们用 Electron 打包了一个桌面客户端（DeepSeek Harness），内嵌 9 个网页版 AI 的 webview，实现"AI 会议"功能：

- 9 个 webview 宫格排列（3×3），分别是：DeepSeek、ChatGPT、Kimi、豆包、通义千问、腾讯元宝、Gemini、Google 搜索、百度文心
- 用户在底部输入框输入消息，点"发送"后，消息被**广播**到所有 9 个 webview
- 每个 AI 收到消息后自动回复，回复内容抄送到右侧栏

## 当前问题

**消息广播不稳定**——不同网站表现不一致：

| AI | 状态 | 现象 |
|---|---|---|
| ChatGPT | ✅ 正常 | 填文字 + 发送按钮点击成功 |
| 腾讯元宝 | ✅ 正常 | 同上 |
| 百度文心 | ❌ 第二轮失效 | 第一轮正常，第二轮输入框没字 |
| Kimi | ❌ 失效 | 之前正常，现在文字留在输入框没发出去 |
| 豆包 | ❌ 填了没发 | 文字在输入框，发送按钮没点到 |
| 通义千问 | ❌ 填了没发 | 同上 |
| DeepSeek | ❌ 没找到输入框 | 输入框是空的 |
| Gemini | ❌ 没找到输入框 | 同上 |
| Google 搜索 | ⚠️ 普通搜索 | 不是 AI 对话模式 |

## 已尝试的方法

### 1. 找输入框

**方法 A：按 placeholder 匹配**
```js
document.querySelector('textarea[placeholder*="DeepSeek"]')
```
- 结果：DP/Gemini 没找到

**方法 B：找最后一个可见的 textarea + contenteditable**
```js
const inputs = document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]');
const visible = [...inputs].filter(el => el.offsetParent !== null);
input = visible[visible.length - 1];
```
- 结果：GPT/元宝能找到，DP/Gemini 还是找不到

**方法 C：遍历 iframe**
```js
function findInput(doc) {
  // 找 doc 里的输入框
  // 遍历 doc.querySelectorAll('iframe')，递归找 contentDocument
}
```
- 结果：引入了 bug，Kimi 从正常变成失效

### 2. 填文字

**方法 A：直接设 value / innerText**
```js
input.value = text;  // textarea
input.innerText = text;  // contenteditable
input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
```
- 结果：部分网站填了，但没触发 React/Vue 的状态更新

**方法 B：先 focus 再设值**
```js
input.focus();
input.value = text;
```
- 结果：同上

### 3. 发送消息

**方法 A：找发送按钮点击**
```js
const btns = document.querySelectorAll('button, [role="button"]');
for (const btn of btns) {
  const label = (btn.getAttribute('aria-label') || btn.textContent || btn.className || '').toLowerCase();
  if (label.includes('发送') || label.includes('send')) { btn.click(); break; }
}
```
- 结果：GPT/元宝能找到按钮，豆包/千问/Kimi 找不到（可能是 SVG 图标按钮）

**方法 B：按 Enter 键**
```js
input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, bubbles: true }));
input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
```
- 结果：部分网站能发，部分不能

**方法 C：等 300ms 再发送**
```js
await new Promise(r => setTimeout(r, 300));
// 找按钮 / 按 Enter
```
- 结果：GPT/元宝稳定，豆包/千问还是不行

### 4. 特殊处理

**豆包：关掉"创建项目"对话框**
```js
document.querySelectorAll('.modal-close, [class*="close-icon"]').forEach(b => b.click());
```
- 结果：对话框能关掉，但发送还是不行

## 需要的帮助

请各位（DeepSeek、Google、OpenAI、字节跳动、阿里、腾讯、月之暗面、百度）提供：

1. **你们网页版的输入框是哪个元素？**
   - tagName（textarea / contenteditable div / input）
   - 选择器（class / id / placeholder / data-* 属性）
   - 是否在 shadow DOM 或 iframe 里？

2. **填文字后怎么触发状态更新？**
   - React/Vue 用的什么状态管理？
   - 需要 dispatch 什么事件才能让框架监听到？

3. **发送按钮是哪个元素？**
   - tagName（button / div / svg）
   - 选择器（class / aria-label / data-* 属性）
   - 是 button.click() 还是 dispatch Enter 事件？

4. **有没有推荐的自动化方案？**
   - Playwright / Puppeteer 的推荐做法？
   - 有没有官方的自动化 API？

## 技术环境

- Electron 33.2.0
- webviewTag: true
- partition: persist:agent-{providerId}
- 每个 AI 独立 partition，cookie 共享
