'use strict';
/**
 * adapters/registry.js —— 网页版智能体 Provider 注册表（主进程侧）。
 *
 * 每个 provider 描述一个「网页版 AI 模型」：
 *   - id:       唯一标识（模型选择器/设置页/智能体窗口共用）
 *   - name:     显示名
 *   - url:      对话主页（智能体窗口默认加载）
 *   - loginUrl: 登录页（设置-模型里「打开登录」时加载）
 *   - loginMode:登录方式描述（账号密码 / 二维码扫码等）
 *   - adapter:  页面侧适配器 key（deepseek-web 特化；其余走 generic-web）
 *   - builtin:  是否内置
 *
 * 用户自定义 provider 通过 addProvider/removeProvider 持久化到
 * userData/agent/providers.json；内置 presets 始终存在。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PRESET_PROVIDERS = [
  {
    id: 'deepseek-web',
    name: 'DeepSeek 网页版',
    url: 'https://chat.deepseek.com/',
    loginUrl: 'https://chat.deepseek.com/sign_in',
    loginMode: '账号密码 / 扫码',
    adapter: 'deepseek-web',
    builtin: true,
  },
  {
    id: 'chatgpt-web',
    name: 'ChatGPT 网页版',
    url: 'https://chatgpt.com/',
    loginUrl: 'https://chatgpt.com/auth/login',
    loginMode: '账号 / Google / 扫码',
    adapter: 'generic-web',
    builtin: true,
  },
  {
    id: 'kimi-web',
    name: 'Kimi 网页版',
    url: 'https://kimi.moonshot.cn/',
    loginUrl: 'https://kimi.moonshot.cn/',
    loginMode: '手机号 / 扫码',
    adapter: 'generic-web',
    builtin: true,
  },
  {
    id: 'doubao-web',
    name: '豆包网页版',
    url: 'https://www.doubao.com/chat/',
    loginUrl: 'https://www.doubao.com/chat/',
    loginMode: '手机号 / 扫码',
    adapter: 'generic-web',
    builtin: true,
  },
  {
    id: 'qwen-web',
    name: '通义千问网页版',
    url: 'https://tongyi.aliyun.com/qianwen/',
    loginUrl: 'https://tongyi.aliyun.com/qianwen/',
    loginMode: '手机号 / 扫码',
    adapter: 'generic-web',
    builtin: true,
  },
  {
    id: 'yuanbao-web',
    name: '腾讯元宝网页版',
    url: 'https://yuanbao.tencent.com/chat/',
    loginUrl: 'https://yuanbao.tencent.com/chat/',
    loginMode: '微信 / QQ / 扫码',
    adapter: 'generic-web',
    builtin: true,
  },
  {
    id: 'gemini-web',
    name: 'Gemini 网页版',
    url: 'https://gemini.google.com/app',
    loginUrl: 'https://gemini.google.com/app',
    loginMode: 'Google 账号',
    adapter: 'generic-web',
    builtin: true,
  },
];

/** 主进程 provider 目录（userData/agent/providers.json） */
class ProviderDirectory {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'providers.json');
    this.custom = [];
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.custom)) this.custom = parsed.custom;
    } catch (e) {
      this.custom = [];
    }
    return this.list();
  }

  async save() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify({ custom: this.custom }, null, 2), 'utf8');
  }

  list() {
    const custom = this.custom.map((p, i) => ({
      id: p.id || `custom-${i}`,
      name: p.name || '自定义网页版',
      url: p.url || '',
      loginUrl: p.url || '',
      loginMode: '账号密码 / 扫码',
      adapter: 'generic-web',
      builtin: false,
    }));
    return [...PRESET_PROVIDERS, ...custom];
  }

  get(id) {
    return this.list().find((p) => p.id === id) || null;
  }

  async add({ name, url }) {
    const trimmedName = String(name || '').trim();
    const trimmedUrl = String(url || '').trim();
    if (!trimmedName || !/^https?:\/\//i.test(trimmedUrl)) {
      return { ok: false, error: '名称不能为空，且网址必须以 http(s):// 开头' };
    }
    const id = 'custom-' + Date.now().toString(36);
    this.custom.push({ id, name: trimmedName, url: trimmedUrl });
    await this.save();
    return { ok: true, provider: this.get(id) };
  }

  async remove(id) {
    const before = this.custom.length;
    this.custom = this.custom.filter((p) => p.id !== id);
    if (this.custom.length === before) return { ok: false, error: '未找到该自定义模型' };
    await this.save();
    return { ok: true };
  }
}

/** 页面侧（webview preload）按 hostname 路由到适配器 key */
function adapterKeyForHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h.includes('deepseek.com')) return 'deepseek-web';
  return 'generic-web';
}

/** 主进程侧：给前端（设置/模型选择）用的安全元数据（不含敏感字段） */
function safeProviderMeta(p) {
  return { id: p.id, name: p.name, url: p.url, loginUrl: p.loginUrl, loginMode: p.loginMode, builtin: !!p.builtin };
}

module.exports = { PRESET_PROVIDERS, ProviderDirectory, adapterKeyForHost, safeProviderMeta };
