'use strict';
/**
 * shell/main.js —— Phase 0 测试台最小 Electron 壳
 *
 * ⚠️ 本目录【完全不接入客户端】：不 require desktop/ 下任何文件，不改任何客户端代码。
 *
 * 登录态复用：
 *   默认 -> 使用本测试台独立的 userData（干净，需要自己登录）
 *   --reuse-login -> 指向客户端同一个 userData 目录，
 *                    从而复用 Partitions/agent-* 里已登录的 9 个账号
 *                    （需先关闭 DSH 客户端，避免 userData 被占用）
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, webContents } = require('electron');

const REUSE_LOGIN = process.argv.includes('--reuse-login');

// 9 个 webview 同时渲染时 GPU 进程极易崩溃，会把整个程序带走（表现为"闪退"）。
// 关闭硬件加速规避；网页 AI 用软件渲染照样正常显示对话页，功能不受影响。
//
// ★ 2026-09-23 修复「拖拽复制卡死」：绝不能加 disable-software-rasterizer！
//   disable-gpu 之后 Chromium 用 SwiftShader（软件光栅）兜底出帧；
//   disable-software-rasterizer 把这条兜底路径也砍掉 → 等于没有任何光栅器。
//   文本选区拖拽 / 滚动 / 拖拽影像生成都需要连续出帧 → 直接挂死整个窗口。
//   日志里的 "Message rejected by interface blink.mojom.WidgetHost" 就是合成器
//   死掉的指纹（实测：去掉该开关后 12 个 target 全部正常渲染）。
app.commandLine.appendSwitch('disable-gpu');

/* ★ 2026-09-23 修复「Gemini 复制按钮点了没反应」：
 *   网页 AI 的复制按钮走 navigator.clipboard.writeText()，而 Electron 默认
 *   拒绝 webview 的 clipboard-sanitized-write 权限 → promise 静默失败，
 *   按钮看起来"点了没反应"。这里对所有 session 统一放行剪贴板读写
 *   （顺带放行媒体/通知等网页 AI 常用权限），其余权限维持默认拒绝。
 *   app.on('session-created') 在 Electron 12+ 可用（本机 33.2.0 实测支持）。 */
const COMMON_PERMS = new Set([
  'clipboard-sanitized-write',
  'clipboard-read',
  'media',
  'audioCapture',
  'videoCapture',
  'notifications',
  'fullscreen',
  'pointerLock',
  'mediaKeySystem',
]);
app.on('session-created', (session) => {
  session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(COMMON_PERMS.has(permission));
  });
  session.setPermissionCheckHandler((wc, permission) => COMMON_PERMS.has(permission));
});

// 客户端 userData 目录 = appData + 应用名（客户端 productName 是 "DeepSeek Harness"）。
// ★ 不写死盘符与用户名：
//   Electron 的 appData —— Windows 是 %APPDATA%（本机已迁到 D:\Users\Admin\AppData\Roaming，
//   与原先硬编码的路径恰好一致，所以本机行为零变化），macOS 是 ~/Library/Application Support。
//   写死 'D:\Users\Admin\...' 的话，测试台拿到 Mac 上跑 --reuse-login 会指向一个不存在的目录，
//   表现为"所有网页模型都是未登录"——而且不会报错，只能靠人猜。
const CLIENT_USER_DATA = path.join(app.getPath('appData'), 'DeepSeek Harness');

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

if (REUSE_LOGIN) {
  app.setPath('userData', CLIENT_USER_DATA);
}

/* ★ 席位弹出窗口：
 *   网页席位 → 同一个 partition = 直接复用登录态（无需重登）。
 *   API 席位 → 无网页，弹出的是「对话记录」窗口（可全屏 / 自由调大小），
 *              渲染进程开会时通过 seat-popup-update 把最新文本同步进来。
 *   窗口关闭时通知渲染进程恢复格子。 */
const apiPopupWins = new Map();

ipcMain.handle('seat-popup-open', (e, { id, name, url, partition, api }) => {
  if (api) {
    const win = new BrowserWindow({
      width: 1200,
      height: 860,
      title: `${name || id} · 通辽会议`,
      backgroundColor: '#0b0e14',
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    win.loadURL('data:text/html,' + encodeURIComponent(
      '<!doctype html><html><head><meta charset="utf-8">'
      + '<style>body{background:#0b0e14;color:#bcd;font-family:Consolas,monospace;padding:14px;'
      + 'font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;overflow:auto}</style>'
      + '</head><body id="b">（等待会议下发第一条消息…）</body></html>'
    ));
    win.on('closed', () => {
      apiPopupWins.delete(id);
      if (!e.sender.isDestroyed()) e.sender.send('seat-popup-closed', id);
    });
    apiPopupWins.set(id, win);
    return true;
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    title: `${name || id} · 通辽会议`,
    backgroundColor: '#0b0e14',
    webPreferences: { partition, sandbox: true, contextIsolation: true },
  });
  win.loadURL(url);
  win.on('closed', () => {
    if (!e.sender.isDestroyed()) e.sender.send('seat-popup-closed', id);
  });
  return true;
});

/* API 弹出窗口的对话内容实时同步 */
ipcMain.on('seat-popup-update', (e, { id, text }) => {
  const win = apiPopupWins.get(id);
  if (!win || win.isDestroyed()) return;
  const safe = JSON.stringify(text || '');
  win.webContents.executeJavaScript(`(function(){var b=document.getElementById('b');if(b)b.textContent=${safe};})()`).catch(() => {});
});

/* ★ CDP 塞文件（renderer 无法访问 webContents 模块——那是主进程专属，
 *   所以 setFiles 必须经 IPC 让主进程代持 webContents.debugger）。
 *   输入 { webContentsId, files: [绝对路径], attach?: {trigger, menu?} }，输出 { ok, via?, error? }
 *
 *   策略 A（有 attach.trigger 时）：文件选择器拦截——点站点自己的📎按钮，
 *     拦截弹出的 chooser，把文件塞进真实 backendNodeId（绕开"抓错 input"黑洞）。
 *   策略 B（兜底）：querySelector 找第一个 input[type=file] 直接塞（DP/豆包/Kimi 已验证可通）。 */
ipcMain.handle('cdp-set-files', async (e, { webContentsId, files, attach }) => {
  const wc = webContents.fromId(webContentsId);
  if (!wc) return { ok: false, error: 'webContents 不存在（webview 可能还没 dom-ready）' };
  const dbg = wc.debugger;
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      await new Promise((r) => setTimeout(r, 250));
    }

    /* ── 策略 A：chooser 拦截（受信任点击——合成 .click() 骗不过部分框架，
     *   必须经 Input.dispatchMouseEvent 派 isTrusted=true 的真鼠标事件） ── */
    if (attach && attach.trigger) {
      let opened = null;
      const onMsg = (evt, method, params) => {
        if (method === 'Page.fileChooserOpened' && params && params.backendNodeId && !opened) opened = params;
      };
      try {
        await dbg.sendCommand('Page.enable');
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
        dbg.on('message', onMsg);

        /** 在页面里找元素（返回 getBoundingClientRect 中心），再用 CDP Input 真点击 */
        const trustClick = async (finderJs) => {
          const rect = await wc.executeJavaScript(`(function(){
            var el = (${finderJs})();
            if (!el || el.offsetParent === null) return null;
            var r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return null;
            if (r.top < 0 || r.bottom > innerHeight + 20 || r.left < 0 || r.right > innerWidth + 20) return null;
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })();`);
          if (!rect) return false;
          const o = { x: rect.x, y: rect.y, button: 'left', clickCount: 1 };
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...o });
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...o });
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...o });
          return true;
        };

        /* ★ prepare：站点需先进入某界面（谷歌要先点「AI 模式」才有承接文件的输入框） */
        if (attach.prepare) {
          const okPrep = await trustClick(`(() => {
            var want = ${JSON.stringify(attach.prepare)};
            var cands = document.querySelectorAll('button,[role="button"],[role="tab"],a,div[jsname],span');
            for (var i = 0; i < cands.length; i++) {
              var el = cands[i];
              if (el.offsetParent === null) continue;
              var t = (el.textContent || '').trim();
              var lb = el.getAttribute('aria-label') || '';
              /* 包含匹配且文本短（按钮常带图标/空格，精确相等会漏） */
              if ((t.indexOf(want) >= 0 && t.length < 24) || (lb.indexOf(want) >= 0 && lb.length < 24)) return el;
            }
            return null;
          })`);
          console.log('[cdp-set-files] prepare(' + attach.prepare + '): ' + (okPrep ? '已点击' : '未找到'));
          if (okPrep) await sleepMs(2500);
        }

        const clicked = await trustClick(`(() => {
          return document.querySelector(${JSON.stringify(attach.trigger)});
        })`);        if (!clicked) {
          // ★ 不 early-return！附着按钮找不到/不在视口 → 继续往下走策略 C/B（否则拖放通道被跳过）
          console.log('[cdp-set-files] 策略 A 找不到附着按钮（' + attach.trigger + '），继续后续策略');
        } else {
          /** 轮询等 chooser（固定 sleep 会漏：谷歌菜单渲染 ~1.5s，1.2s 就放弃过） */
          const waitChooser = async (ms) => {
            const t0 = Date.now();
            while (!opened && Date.now() - t0 < ms) await sleepMs(200);
            return !!opened;
          };
          if (!(await waitChooser(2500)) && attach.menu) {
            // 触发按钮开的可能是菜单（谷歌"添加文件和工具"/ChatGPT"添加文件等"）
            //   → 精确文本匹配菜单项（排除触发按钮自己），受信任点击
            await trustClick(`(() => {
              var trig = document.querySelector(${JSON.stringify(attach.trigger)});
              var cands = document.querySelectorAll('[role="menuitem"],[role="menu"] *,li,button,[jsaction]');
              for (var i = 0; i < cands.length; i++) {
                var el = cands[i];
                if (el === trig || el.contains(trig) || el.offsetParent === null || el.children.length > 3) continue;
                var t = (el.textContent || '').trim();
                if (t === '添加文件' || /^(上传文件|上传附件|本地文件|从电脑上传|从本地文件上传)/.test(t)) return el;
              }
              return null;
            })`);
            await waitChooser(4000);
          }

          if (opened && opened.backendNodeId) {
            await dbg.sendCommand('DOM.setFileInputFiles', { files, backendNodeId: opened.backendNodeId });
            /* ★ 芯片验收：塞进真实节点 ≠ 站点挂上了（谷歌不在 AI 模式时静默无痕）。
             *   1.5s 后页面正文不含文件名 → 视为未挂上，继续走拖放/直塞（自愈式降级）。 */
            const names = files.map((p) => path.basename(p));
            const ackChooser = await wc.executeJavaScript(`(function(){
              var t = document.body.innerText || '';
              var names = ${JSON.stringify(names)};
              for (var i = 0; i < names.length; i++) { if (t.indexOf(names[i]) >= 0) return 'staged'; }
              return 'no-chip';
            })();`);
            if (ackChooser === 'staged') return { ok: true, via: 'chooser' };
            console.log('[cdp-set-files] 策略 A 塞入成功但页面无芯片，继续后续策略');
          } else {
            console.log('[cdp-set-files] 策略 A 未等到 chooser（' + attach.trigger + '），继续后续策略');
          }
        }
      } catch (errA) {
        console.log('[cdp-set-files] 策略 A 异常: ' + errA.message + '，退回策略 B');
      } finally {
        try { dbg.removeListener('message', onMsg); } catch (_) {}
        try { await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (_) {}
      }
    }

    /* ── 策略 C：合成拖放（内容级——读文件字节，在页面里造真 File 对象，
     *   沿输入区往上 6 层逐个派 dragenter/dragover/drop；不依赖站点附着按钮、
     *   也不依赖真实文件路径。实测：通义/文心首页即挂上（staged=true）。
     *   ACK 判据：1.5s 后页面正文出现文件名 = 真挂上） ── */
    if (attach && attach.drop && files.length) {
      try {
        const MAX = 20 * 1024 * 1024;
        const picked = [];
        let total = 0;
        for (const p of files) {
          const st = fs.statSync(p);
          total += st.size;
          if (total > MAX) break;
          picked.push({
            name: path.basename(p),
            type: /\.(md|txt|csv|json|log)$/i.test(p) ? 'text/plain' : 'application/octet-stream',
            b64: fs.readFileSync(p).toString('base64'),
          });
        }
        if (!picked.length) throw new Error('没有可投递的文件（或超过 20MB 上限）');
        const ack = await wc.executeJavaScript(`(async () => {
          var FILES = ${JSON.stringify(picked)};
          var makeFile = function (f) {
            var bin = atob(f.b64);
            var arr = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            return new File([arr], f.name, { type: f.type });
          };
          var comp = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
          var targets = [];
          var t = comp;
          for (var d = 0; d < 6 && t; d++) { targets.push(t); t = t.parentElement; }
          if (document.body) targets.push(document.body);
          var hasChip = function () {
            var text = document.body.innerText || '';
            for (var m = 0; m < FILES.length; m++) { if (text.indexOf(FILES[m].name) >= 0) return true; }
            return false;
          };
          /* ★ 逐层试探：每层只派一次 drop，出现芯片立刻停。
           *   曾经 7 层同时派 → 文心/千问各收到 7 份重复（每层各挂一份）。 */
          for (var k = 0; k < targets.length; k++) {
            try {
              var dt = new DataTransfer();
              for (var j = 0; j < FILES.length; j++) dt.items.add(makeFile(FILES[j]));
              var mk = function (n) {
                return { bubbles: true, cancelable: true, dataTransfer: dt, composed: true };
              };
              ['dragenter', 'dragover', 'drop'].forEach(function (n) {
                targets[k].dispatchEvent(new DragEvent(n, mk(n)));
              });
            } catch (e) { /* 这一层不行就下一层 */ }
            await new Promise(function (r) { setTimeout(r, 900); });
            if (hasChip()) return 'staged';
          }
          return 'no-chip';
        })();`);
        if (ack === 'staged') return { ok: true, via: 'drop' };
        console.log('[cdp-set-files] 策略 C 拖放后页面未出现文件名（' + (attach.trigger || 'drop') + '），继续策略 B');
      } catch (errC) {
        console.log('[cdp-set-files] 策略 C 异常: ' + errC.message + '，继续策略 B');
      }
    }

    /* ── 策略 B：querySelector 第一个 input[type=file] 直接塞 ── */
    // 没有 file input 就造一个（部分站点懒加载/自定义上传）
    await wc.executeJavaScript(`(function(){
      var inp = document.querySelector('input[type="file"]');
      if (!inp) {
        inp = document.createElement('input');
        inp.type = 'file'; inp.style.display = 'none';
        document.body.appendChild(inp);
      }
      return true;
    })();`);
    const root = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
    const found = await dbg.sendCommand('DOM.querySelector', {
      nodeId: root.root.nodeId, selector: 'input[type="file"]',
    });
    if (!found || !found.nodeId) return { ok: false, error: '页面上找不到 <input type=file>（造的兜底也没生效）' };
    await dbg.sendCommand('DOM.setFileInputFiles', { files, nodeId: found.nodeId });
    // ★ 默认零合成事件（setFileInputFiles 自带原生 input+change，多派=重复文件）。
    //   例外：per-provider synthetic 配置（文心框架只听 input 事件，实测零事件挂不上）。
    if (attach && Array.isArray(attach.synthetic) && attach.synthetic.length) {
      const evts = JSON.stringify(attach.synthetic);
      await wc.executeJavaScript(`(function(){
        var inp = document.querySelector('input[type="file"]');
        if (!inp) return;
        var names = ${evts};
        for (var i = 0; i < names.length; i++) {
          inp.dispatchEvent(new Event(names[i], { bubbles: true }));
        }
      })();`);
    }
    /* ★ 策略 B 也验芯片：静默黑洞（塞进未接线的 input）必须报失败，不许日志假成功 */
    await sleepMs(1500);
    const namesB = files.map((p) => path.basename(p));
    const ackB = await wc.executeJavaScript(`(function(){
      var t = document.body.innerText || '';
      var names = ${JSON.stringify(namesB)};
      for (var i = 0; i < names.length; i++) { if (t.indexOf(names[i]) >= 0) return 'staged'; }
      return 'no-chip';
    })();`);
    if (ackB === 'staged') return { ok: true, via: 'direct' };
    return { ok: false, error: '页面未出现附件（该站点直接塞通道无效，需站点专属适配）' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
function createWindow() {
  const win = new BrowserWindow({
    width: 1680,
    height: 1020,
    title: '通辽会议 · Phase 0 测试台（独立，不接客户端）',
    backgroundColor: '#0b0e14',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

app.whenReady().then(() => {
  console.log('[meeting-lab] userData =', app.getPath('userData'));
  console.log('[meeting-lab] 登录态复用 =', REUSE_LOGIN ? '是（复用客户端 partition）' : '否（独立）');
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
