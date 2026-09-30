/* 统一 AI 窗口壳 · 厂商注册表（占位版，跑起来看效果后再精修）
 * 字段命名与 05 技术接口文档一致：
 *   id            厂商/模型唯一 key（vendorId）
 *   brandShort    大字区品牌简称（displayName）
 *   fullName      标题栏小字完整型号（fullModelName）
 *   brand         色板档位 key（semanticColor 的调色板档）
 *   bg            语义色壁纸（浅色，填充内容区背景）
 *   logoColor     LOGO 占位色块主色（较强色，区别于浅壁纸）
 *   kind          chat（对话） | generative（生成）
 *   variant       logo（LOGO 版，无网页） | web（真实网页版，含 webUrl）
 *   webUrl        仅 variant=web
 *   genType       仅 kind=generative：text2img | text2video
 *   fontStyle     理性硬朗 | 圆润可爱 | 优雅商务
 * logoAsset       可选；缺省用 logoColor+brandShort 文字占位（跑起来后补真实 PNG）
 */
window.WS_VENDORS = [
  /* ===== 对话型 · LOGO 版（19 家，无独立网页，API/占位驱动） ===== */
  { id:'deepseek',   brandShort:'DeepSeek', fullName:'deepseek-flash',  brand:'deepseek-blue',    bg:'#E9EFF7', logoColor:'#4D6BFE', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'kimi',       brandShort:'Kimi',     fullName:'kimi-k2',         brand:'kimi-teal',        bg:'#E4F3F1', logoColor:'#10A37F', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'doubao',     brandShort:'豆包',     fullName:'doubao-pro',      brand:'doubao-orange',    bg:'#FDEEE0', logoColor:'#FF6A00', kind:'chat', variant:'logo', fontStyle:'圆润可爱' },
  { id:'qwen',       brandShort:'通义千问', fullName:'qwen-max',        brand:'qwen-purple',      bg:'#EFE9F7', logoColor:'#6C45E0', kind:'chat', variant:'logo', fontStyle:'优雅商务' },
  { id:'wenxin',     brandShort:'文心一言', fullName:'ernie-4.5',       brand:'wenxin-red',       bg:'#F9E9E9', logoColor:'#E63946', kind:'chat', variant:'logo', fontStyle:'优雅商务' },
  { id:'gemini',     brandShort:'Gemini',   fullName:'gemini-2.5-pro',  brand:'gemini-bluepurple',bg:'#EBF0FB', logoColor:'#5B5BD6', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'gpt',        brandShort:'GPT',      fullName:'gpt-6-astra',     brand:'gpt-green',        bg:'#EDF3EF', logoColor:'#0B7A4B', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'agnes',      brandShort:'Agne',     fullName:'agnes-2.5-pro-alpha', brand:'neutral-grayblue', bg:'#EEF1F5', logoColor:'#5B6B8C', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'claude',     brandShort:'Claude',   fullName:'claude-opus-5',   brand:'claude-rose',      bg:'#F7EEF1', logoColor:'#D97757', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'llama',      brandShort:'Llama',    fullName:'meta-llama-4',    brand:'llama-blue',       bg:'#EAF0F7', logoColor:'#0A66C2', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'grok',       brandShort:'Grok',     fullName:'grok-4.5',        brand:'grok-dark',        bg:'#ECEEF1', logoColor:'#111418', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'perplexity', brandShort:'Perplexity', fullName:'sonar-pro',     brand:'perplexity-teal',  bg:'#E6F4F3', logoColor:'#20B2AA', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'copilot',    brandShort:'Copilot',  fullName:'microsoft-copilot', brand:'copilot-blue',   bg:'#E9F1FB', logoColor:'#0F6CBD', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'longcat',    brandShort:'LongCat',  fullName:'meituan-longcat', brand:'longcat-orange',   bg:'#FFF1E6', logoColor:'#FF7A1A', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'chatgpt',    brandShort:'ChatGPT',  fullName:'chatgpt-5',       brand:'chatgpt-green',    bg:'#EAF3EE', logoColor:'#10A37F', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'baichuan',   brandShort:'百川',     fullName:'baichuan-4',      brand:'baichuan-cyan',    bg:'#E6F6F8', logoColor:'#00A3B4', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'yi',         brandShort:'零一万物', fullName:'yi-large',        brand:'yi-purple',        bg:'#F1EAF7', logoColor:'#7C3AED', kind:'chat', variant:'logo', fontStyle:'优雅商务' },
  { id:'moonshot',   brandShort:'Moonshot', fullName:'moonshot-v1',     brand:'moonshot-teal',    bg:'#E6F7F4', logoColor:'#14B8A6', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },
  { id:'step',       brandShort:'阶跃星辰', fullName:'step-2',          brand:'step-blue',        bg:'#EAF0FA', logoColor:'#2563EB', kind:'chat', variant:'logo', fontStyle:'理性硬朗' },

  /* ===== 对话型 · 真实网页版（5 家，内容区用 webview 加载真站） ===== */
  { id:'baixiaoyi',  brandShort:'百小医',   fullName:'百川医疗 网页版', brand:'baichuan-cyan',    bg:'#E6F6F8', logoColor:'#00A3B4', kind:'chat', variant:'web', webUrl:'https://ying.baichuan-medical.com/', fontStyle:'理性硬朗' },
  { id:'minimax',    brandShort:'MiniMax',  fullName:'MiniMax 网页版',  brand:'minimax-violet',   bg:'#F0EAF8', logoColor:'#7C5CFC', kind:'chat', variant:'web', webUrl:'https://chat.minimax.io/', fontStyle:'理性硬朗' },
  { id:'zhipu',      brandShort:'智谱清言', fullName:'GLM 网页版',      brand:'zhipu-cyan',       bg:'#E7F5F8', logoColor:'#1FA8A0', kind:'chat', variant:'web', webUrl:'https://chat.zhipuai.cn/', fontStyle:'优雅商务' },
  { id:'mimo',       brandShort:'小米 MiMo', fullName:'MiMo 网页版',    brand:'mimo-orange',      bg:'#FFF1E6', logoColor:'#FF6700', kind:'chat', variant:'web', webUrl:'https://mimo.ai/', fontStyle:'理性硬朗' },
  { id:'hunyuan',    brandShort:'腾讯混元', fullName:'Hunyuan 网页版',  brand:'hunyuan-blue',     bg:'#E9F1FB', logoColor:'#0052D9', kind:'chat', variant:'web', webUrl:'https://hunyuan.tencent.com/', fontStyle:'理性硬朗' },

  /* ===== 生成型（6 家，画廊+提示词+生成中第四态） ===== */
  { id:'kling',      brandShort:'可灵',     fullName:'Kling 文生视频',  brand:'gen-video',        bg:'#F0EAF8', logoColor:'#7C5CFC', kind:'generative', variant:'logo', genType:'text2video', fontStyle:'理性硬朗' },
  { id:'vidu',       brandShort:'Vidu',     fullName:'Vidu 文生视频',   brand:'gen-video',        bg:'#F0EAF8', logoColor:'#7C5CFC', kind:'generative', variant:'logo', genType:'text2video', fontStyle:'理性硬朗' },
  { id:'hailuo',     brandShort:'海螺',     fullName:'Hailuo 文生视频', brand:'gen-video',        bg:'#F0EAF8', logoColor:'#7C5CFC', kind:'generative', variant:'logo', genType:'text2video', fontStyle:'理性硬朗' },
  { id:'pixverse',   brandShort:'PixVerse', fullName:'PixVerse 文生视频', brand:'gen-video',      bg:'#F0EAF8', logoColor:'#7C5CFC', kind:'generative', variant:'logo', genType:'text2video', fontStyle:'理性硬朗' },
  { id:'jimeng',     brandShort:'即梦',     fullName:'Jimeng 文生图',   brand:'gen-image',        bg:'#FFF1E6', logoColor:'#FF7A1A', kind:'generative', variant:'logo', genType:'text2img', fontStyle:'圆润可爱' },
  { id:'wan',        brandShort:'万相',     fullName:'Wan 文生图',       brand:'gen-image',        bg:'#FFF1E6', logoColor:'#FF7A1A', kind:'generative', variant:'logo', genType:'text2img', fontStyle:'圆润可爱' }
];
