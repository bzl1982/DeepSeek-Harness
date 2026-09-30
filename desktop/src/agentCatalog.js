'use strict';
/**
 * 网页版智能体唯一配置源（单一数据源）
 * 通辽会议窗口、设置-模型面板、主页模型切换器 三处共用，改这里一处全生效。
 * 命名规则：公司名用中文；产品有官方中文名用中文，无官方中文名保留英文品牌名（不生造译名）。
 * 注意：loginRe/logoutRe 用「字符串正则」，可安全跨 IPC 序列化，在 guest 页面 new RegExp 执行。
 */
const AGENT_CATALOG = [
  {
    id: 'deepseek-web', name: '深度求索-DeepSeek', shortName: 'DeepSeek',
    type: 'web', url: 'https://chat.deepseek.com/', partition: 'persist:agent-deepseek-web',
    // 输入框单次可接受的最大字符数（超长走"转 .md 上传"路径，见 meeting.html smartSend）。
    // 各站点的输入框硬上限不一，这里按官方/实测保守值填；后续可逐站校准。
    charLimit: 10000,
    login: {
      loginRe: '^(登录|登\\s*录|立即登录|Sign in|Log in|Login)$',
      logoutRe: '(退出|注销|登出|Log out|Sign out)',
      userSelectors: ['[class*="user-email"]', '[class*="account"] [class*="email"]', 'div[class*="user-menu"] span', 'img[alt]'],
      cookieNames: ['ds_token', 'ds_user_id'],
    },
  },
  {
    id: 'chatgpt-web', name: 'OpenAI-ChatGPT', shortName: 'ChatGPT',
    type: 'web', url: 'https://chatgpt.com/', partition: 'persist:agent-chatgpt-web',
    // 输入框字符上限：ChatGPT 网页版 32K 上下文，单次输入框实际接受量远小于此；
    // 取 8000 保守值，超出则走"转 .md 文件上传"路径。
    charLimit: 8000,
    login: {
      loginRe: '^(Log in|Sign in|登录)$',
      logoutRe: '(Log out|Sign out|退出)',
      userSelectors: ['[data-testid="user-email"]', '[data-testid="profile-button"]', 'button[aria-label*="Account"]'],
      cookieNames: ['__Secure-next-auth.session-token'],
    },
  },
  {
    id: 'kimi-web', name: '月之暗面-Kimi', shortName: 'Kimi',
    type: 'web', url: 'https://kimi.moonshot.cn/', partition: 'persist:agent-kimi-web',
    charLimit: 12000,
    login: {
      loginRe: '^(登录|登\\s*录|立即登录|Login)$',
      logoutRe: '(退出|退出登录|Logout)',
      userSelectors: ['[class*="user-name"]', '[class*="account-info"] span', 'div[class*="user-panel"] p', 'img[alt]'],
      cookieNames: ['access_token', 'refresh_token'],
    },
  },
  {
    id: 'doubao-web', name: '字节跳动-豆包', shortName: '豆包',
    type: 'web', url: 'https://www.doubao.com/chat/', partition: 'persist:agent-doubao-web',
    charLimit: 10000,
    login: {
      loginRe: '^(登录|立即登录|Sign in)$',
      logoutRe: '(退出登录|退出|Log out)',
      userSelectors: ['[class*="user-name"]', 'div[class*="user-info"] span', 'div[class*="account"] span'],
      cookieNames: ['sessionid', 'sid_tt'],
    },
  },
  {
    id: 'tongyi-web', name: '阿里巴巴-通义千问', shortName: '通义千问',
    type: 'web', url: 'https://tongyi.aliyun.com/qianwen/', partition: 'persist:agent-tongyi-web',
    charLimit: 10000,
    login: {
      loginRe: '^(登录|立即登录|Sign in)$',
      logoutRe: '(退出登录|退出|Log out)',
      userSelectors: ['[class*="userName"]', '[class*="nickname"]', 'div[class*="user-info"] span', 'img[alt]'],
      cookieNames: ['tongyi_token', 'login_tongyi'],
    },
  },
  {
    id: 'yuanbao-web', name: '腾讯-元宝', shortName: '元宝',
    type: 'web', url: 'https://yuanbao.tencent.com/chat', partition: 'persist:agent-yuanbao-web',
    charLimit: 10000,
    login: {
      loginRe: '^(登录|立即登录|微信登录|QQ登录)$',
      logoutRe: '(退出|退出登录|注销)',
      userSelectors: ['[class*="nickname"]', '[class*="user-name"]', 'div[class*="user-info"] span'],
      cookieNames: ['hy_token', 'hy_user_info'],
    },
  },
  {
    id: 'gemini-web', name: '谷歌-Gemini', shortName: 'Gemini',
    type: 'web', url: 'https://gemini.google.com/app', partition: 'persist:agent-gemini-web',
    charLimit: 10000,
    login: {
      loginRe: '^(Sign in|登录)$',
      logoutRe: '(Sign out|退出)',
      userSelectors: ['[class*="gb_wb"]', 'a[aria-label*="账户"]', 'div[role="menuitem"] div[class*="email"]', '[aria-label*="Google Account"]'],
      cookieNames: ['SID', 'SAPISID', 'HSID'],
    },
  },
  {
    id: 'google-search', name: '谷歌-搜索', shortName: '搜索',
    type: 'web', url: 'https://www.google.com/search?q=', partition: 'persist:agent-google-search',
    exempt: true, // 豁免：搜索引擎无登录门槛，不参与「未登录隐藏」
    // 搜索引擎的"查询"是 URL 参数形式，charLimit 仅约束拼进 q= 的字符量
    charLimit: 2000,
    login: {
      loginRe: '^(Sign in|登录)$',
      logoutRe: '(Sign out|退出)',
      userSelectors: ['a[aria-label*="账户"]', 'div[class*="gb_wb"]'],
      cookieNames: ['SID', 'HSID'],
    },
  },
  {
    id: 'wenxin-web', name: '百度-文心', shortName: '文心',
    type: 'web', url: 'https://yiyan.baidu.com/', partition: 'persist:agent-wenxin-web',
    charLimit: 8000,
    login: {
      loginRe: '^(登录|立即登录|百度登录)$',
      logoutRe: '(退出|退出登录|注销)',
      userSelectors: ['[class*="username"]', '[class*="nick-name"]', 'div[class*="userinfo"] span', 'img[alt]'],
      cookieNames: ['BAIDUID', 'BDUSS'],
    },
  },
];

module.exports = { AGENT_CATALOG };
