// Chinese / English, as on the other dliu.com sites. A choice saved in this browser wins; otherwise the
// browser's language decides (any zh-* is Chinese, everything else English). Video titles and descriptions
// are shown as written. Importing this module translates the static page: data-zh holds the Chinese text of
// an element, data-zh-label its Chinese aria-label, data-zh-placeholder its Chinese placeholder.

const KEY = 'video-language';
const LANGUAGES = [['zh', 'zh-CN', '中文'], ['en', 'en', 'English']];

export function initialLanguage(saved, browserLanguage) {
  if (saved === 'zh' || saved === 'en') return saved;
  return /^zh(?:-|$)/i.test(browserLanguage || '') ? 'zh' : 'en';
}

let saved = null;
try { saved = localStorage.getItem(KEY); } catch { /* storage blocked (for example in a third-party frame) */ }
export const lang = initialLanguage(saved, navigator.language);

/** t('中文', 'English') */
export const t = (zh, en) => (lang === 'zh' ? zh : en);

/** Locale for dates: the browser's own when it is in the language shown, else a default for that language. */
const browserLang = String(navigator.language || '').toLowerCase().split('-')[0];
export const locale = browserLang === lang ? undefined : (lang === 'zh' ? 'zh-CN' : 'en-GB');

// Messages the API sends, in Chinese. Anything unknown is shown as sent.
const ERRORS = {
  'Not signed in': '未登录',
  'Forbidden': '禁止访问',
  'Not found': '未找到',
  'Method not allowed': '不支持该请求方法',
  'Internal error': '服务器内部错误',
  'Request too large': '请求过大',
  'Body must be a JSON object': '请求内容应为 JSON 对象',
  'Invalid video id': '视频编号无效',
  'Upload not found': '找不到这次上传',
  'Video not found': '找不到视频',
  'Invalid part number': '分块编号无效',
  'Invalid part list': '分块列表无效',
  'Invalid poster': '缩略图无效',
  'Poster upload not found or too large': '找不到缩略图上传，或缩略图过大',
  'Streaming conversion is not set up': '尚未设置流媒体转换',
  'Already converting': '正在转换中',
  'The streaming versions are already made': '流媒体版本已经生成',
  'The video changed meanwhile; try again': '视频刚刚被修改过，请重试',
  'Sign-in expired or invalid. Please try again.': '登录已过期或无效，请重试。',
  'Sign-in failed during token exchange.': '登录失败（换取令牌时出错）。',
  'Sign-in is not configured yet. Run "make set-secrets".': '尚未配置登录。请运行 “make set-secrets”。',
  'Network error': '网络错误',
  'Cancelled': '已取消',
};
const FIELDS = { title: '标题', description: '简介', size: '文件大小', duration: '时长', width: '宽度', height: '高度' };
const field = (name) => FIELDS[name] || name;
const PATTERNS = [
  [/^Request failed \((\d+)\)$/, (n) => `请求失败（${n}）`],
  [/^Upload failed \((\d+)\)$/, (n) => `上传失败（${n}）`],
  [/^Part upload failed \((\d+)\)$/, (n) => `分块上传失败（${n}）`],
  [/^(\w+) is required$/, (name) => `缺少${field(name)}`],
  [/^(\w+) must be text$/, (name) => `${field(name)}必须是文字`],
  [/^(\w+) is longer than (\d+) characters$/, (name, n) => `${field(name)}不能超过 ${n} 个字符`],
  [/^(\w+) is not valid$/, (name) => `${field(name)}无效`],
  [/^Unsupported file type\. Use one of: (.+)$/, (list) => `不支持的文件类型。请使用：${list}`],
  [/^No video numbers left for today \((\d+) a day\)$/, (n) => `今天的视频编号已用完（每天 ${n} 个）`],
  [/^Ask for 1 to (\d+) parts at a time$/, (n) => `每次只能请求 1 到 ${n} 个分块`],
  [/^Expected (\d+) parts, got (\d+)$/, (a, b) => `应有 ${a} 个分块，实际收到 ${b} 个`],
  [/^Sign-in failed: (.+)$/, (code) => `登录失败：${code}`],
  [/^(.+) is not allowed to manage videos\.$/, (who) => `${who === 'This account' ? '此账户' : who} 无权管理视频。`],
];

export function translateError(message) {
  if (lang !== 'zh' || !message) return message;
  if (ERRORS[message]) return ERRORS[message];
  for (const [pattern, zh] of PATTERNS) {
    const match = pattern.exec(message);
    if (match) return zh(...match.slice(1));
  }
  return message;
}

function translatePage() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  if (lang !== 'zh') return;
  for (const node of document.querySelectorAll('[data-zh]')) node.textContent = node.dataset.zh;
  for (const node of document.querySelectorAll('[data-zh-label]')) node.setAttribute('aria-label', node.dataset.zhLabel);
  for (const node of document.querySelectorAll('[data-zh-placeholder]')) node.setAttribute('placeholder', node.dataset.zhPlaceholder);
}

// The shared dl-language switcher (dl.css): 中文 | English side by side, or a 文/A menu on narrow screens.
// Choosing the other language saves it and reloads the page.
let switcher = null;
export function languageSwitcher() {
  if (switcher) return switcher;
  const box = document.createElement('div');
  box.className = 'dl-language';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'dl-button dl-language-toggle';
  toggle.setAttribute('aria-controls', 'dl-languages');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Language / 语言');
  toggle.textContent = '文/A';
  const group = document.createElement('div');
  group.id = 'dl-languages';
  group.className = 'dl-languages';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Language / 语言');
  const setOpen = (open) => {
    group.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  for (const [code, htmlLang, label] of LANGUAGES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.language = code;
    button.lang = htmlLang;
    button.textContent = label;
    button.setAttribute('aria-pressed', String(code === lang));
    button.addEventListener('click', () => {
      setOpen(false);
      if (code === lang) return;
      try { localStorage.setItem(KEY, code); } catch { /* storage blocked: nothing to remember it in */ }
      location.reload();
    });
    group.append(button);
  }
  toggle.addEventListener('click', () => setOpen(!group.classList.contains('is-open')));
  document.addEventListener('click', (event) => { if (!box.contains(event.target)) setOpen(false); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && group.classList.contains('is-open')) { setOpen(false); toggle.focus(); }
  });
  box.append(toggle, group);
  switcher = box;
  return box;
}

translatePage();
