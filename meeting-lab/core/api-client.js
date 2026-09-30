'use strict';
/**
 * core/api-client.js —— API 接入核心 · renderer 侧客户端（2026-09-25 第 1+2 步）
 *
 * 与主进程 shell/api-main.js 的通信层：
 *   · providers/seats CRUD → ipcRenderer.invoke
 *   · 流式对话 → invoke('api:chat-stream') 拿 reqId + 订阅 'api:stream-evt' 事件
 *     （主进程已做 100ms delta 合帧；usage/error/done 立即推）
 *   · 明文密钥全程不出主进程（safeStorage 实测 renderer 不可用）
 *
 * 用法：
 *   const Api = require('../core/api-client');
 *   await Api.listProviders();
 *   await Api.saveProvider({ id:'my-中转', name:'我的中转', protocol:'openai-chat',
 *                            baseURL:'https://xx/v1' }, 'sk-xxx');
 *   await Api.fetchModels('my-中转');
 *   const req = Api.chatStream({ providerId, model, messages, params }, {
 *     onDelta(t){}, onReasoning(t){}, onUsage(u){}, onError(e){}, onDone(){}
 *   });
 *   Api.abort(req.reqId);
 */

const { ipcRenderer } = require('electron');

let evtSeq = 0;

/** 发起流式对话。返回 { reqId }；回调对象可选，done/error 后自动清理监听。 */
function chatStream({ providerId, model, messages, params }, cbs = {}) {
  const localSeq = ++evtSeq;
  const p = ipcRenderer.invoke('api:chat-stream', {
    reqId: null,
    localSeq,
    providerId, model, messages, params: params || {},
  }).then((r) => {
    if (!r || !r.ok) {
      if (cbs.onError) cbs.onError({ code: 'INVOKE_FAIL', message: (r && r.error) || 'invoke 失败' });
      return r;
    }
    const reqId = r.reqId;
    const handler = (e, { reqId: rid, evts }) => {
      if (rid !== reqId) return;
      for (const evt of evts || []) {
        if (evt.type === 'delta' && cbs.onDelta) cbs.onDelta(evt.text);
        else if (evt.type === 'reasoning_delta' && cbs.onReasoning) cbs.onReasoning(evt.text);
        else if (evt.type === 'usage' && cbs.onUsage) cbs.onUsage(evt.usage);
        else if (evt.type === 'error' && cbs.onError) cbs.onError(evt);
        else if (evt.type === 'done') {
          if (cbs.onDone) cbs.onDone();
          ipcRenderer.removeListener('api:stream-evt', handler);
        }
      }
      if (evts && evts.some((x) => x.type === 'error')) ipcRenderer.removeListener('api:stream-evt', handler);
    };
    ipcRenderer.on('api:stream-evt', handler);
    return r;
  });
  return p;
}

module.exports = {
  /** 全部提供方（无密钥明文；含 hasKey / modelsCache） */
  listProviders: () => ipcRenderer.invoke('api:list-providers'),
  /** 新增/更新提供方。apiKey 只在新建或换钥时传。 */
  saveProvider: (provider, apiKey) => ipcRenderer.invoke('api:save-provider', { provider, apiKey: apiKey || null }),
  deleteProvider: (id) => ipcRenderer.invoke('api:delete-provider', { id }),
  testKey: (id) => ipcRenderer.invoke('api:test-key', { id }),
  /** 拉取模型列表（主进程代持密钥；TTL 24h 缓存；空列表不覆盖缓存；force=true 强刷） */
  fetchModels: (id, force) => ipcRenderer.invoke('api:fetch-models', { id, force: !!force }),
  listSeats: () => ipcRenderer.invoke('api:list-seats'),
  saveSeats: (list) => ipcRenderer.invoke('api:save-seats', { list }),
  /** 第 7 步：整表保存（含排序，无密钥字段）+ provider 内模型排序 */
  saveProvidersAll: (list) => ipcRenderer.invoke('api:save-providers-all', { list }),
  reorderModels: (id, ids) => ipcRenderer.invoke('api:reorder-models', { id, ids }),
  chatStream,
  abort: (reqId) => ipcRenderer.invoke('api:abort', { reqId }),
};
