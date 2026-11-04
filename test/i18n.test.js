const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

class Node {
  constructor(tag, data = {}, attributes = {}) {
    this.tagName = tag;
    this.dataset = data;
    this.attributes = attributes;
    this.textContent = '';
    this.children = [];
    this.classList = { toggle() {}, contains: () => false };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener() {}
  append(...nodes) { this.children.push(...nodes); }
}

function load({ saved = null, language = 'en-GB', nodes = [] } = {}) {
  const html = new Node('html');
  const stored = {};
  const context = {
    navigator: { language },
    localStorage: { getItem: () => saved, setItem: (k, v) => { stored[k] = v; } },
    location: { reload: jest.fn() },
    document: {
      documentElement: html,
      createElement: (tag) => new Node(tag),
      addEventListener() {},
      querySelectorAll: (selector) => nodes.filter((node) => node.dataset[{
        '[data-zh]': 'zh', '[data-zh-label]': 'zhLabel', '[data-zh-placeholder]': 'zhPlaceholder' }[selector]] !== undefined),
    },
  };
  const script = read('web/i18n.js').replace(/^export /gm, '')
    + '\n;globalThis.out = { lang, t, locale, translateError, initialLanguage, languageSwitcher };';
  vm.runInNewContext(script, context);
  return { ...context.out, html, stored, context };
}

test('the language follows a saved choice, else the browser (any zh-* is Chinese)', () => {
  const { initialLanguage } = load();
  expect(initialLanguage('zh', 'en-GB')).toBe('zh');
  expect(initialLanguage('en', 'zh-CN')).toBe('en');
  expect(initialLanguage(null, 'zh-TW')).toBe('zh');
  expect(initialLanguage(null, 'zh')).toBe('zh');
  expect(initialLanguage(null, 'en-US')).toBe('en');
  expect(initialLanguage('fr', 'fr-FR')).toBe('en');
  expect(load({ language: 'zh-CN' }).lang).toBe('zh');
  expect(load({ saved: 'en', language: 'zh-CN' }).lang).toBe('en');
});

test('Chinese pages get their static text, labels and lang attribute translated', () => {
  const heading = new Node('h1', { zh: '视频' });
  heading.textContent = 'Videos';
  const nav = new Node('nav', { zhLabel: '网站' }, { 'aria-label': 'Site' });
  const zh = load({ language: 'zh-CN', nodes: [heading, nav] });
  expect(zh.html.lang).toBe('zh-CN');
  expect(heading.textContent).toBe('视频');
  expect(nav.attributes['aria-label']).toBe('网站');
  expect(zh.t('中文', 'English')).toBe('中文');

  const english = new Node('h1', { zh: '视频' });
  english.textContent = 'Videos';
  const en = load({ nodes: [english] });
  expect(en.html.lang).toBe('en');
  expect(english.textContent).toBe('Videos');
  expect(en.t('中文', 'English')).toBe('English');
});

test('API errors are shown in Chinese when known, and as sent otherwise', () => {
  const { translateError } = load({ language: 'zh-CN' });
  expect(translateError('Video not found')).toBe('找不到视频');
  expect(translateError('title is longer than 200 characters')).toBe('标题不能超过 200 个字符');
  expect(translateError('No video numbers left for today (100 a day)')).toBe('今天的视频编号已用完（每天 100 个）');
  expect(translateError('Request failed (502)')).toBe('请求失败（502）');
  expect(translateError('Something new')).toBe('Something new');
  expect(load().translateError('Video not found')).toBe('Video not found');
});

test('the switcher is the shared dl-language markup and saves the choice before reloading', () => {
  const { languageSwitcher, stored, context } = load();
  const box = languageSwitcher();
  expect(languageSwitcher()).toBe(box);
  expect(box.className).toBe('dl-language');
  const [toggle, group] = box.children;
  expect(toggle.className).toBe('dl-button dl-language-toggle');
  expect(toggle.textContent).toBe('文/A');
  expect(group.id).toBe('dl-languages');
  expect(group.children.map((b) => [b.dataset.language, b.textContent, b.attributes['aria-pressed']]))
    .toEqual([['zh', '中文', 'false'], ['en', 'English', 'true']]);
  expect(stored).toEqual({});
  expect(context.location.reload).not.toHaveBeenCalled();
});

test('every page loads the language module', () => {
  expect(read('web/common.js')).toMatch(/^import \{[^}]*\} from '\.\/i18n\.js';$/m);
  for (const script of ['home', 'watch', 'upload', 'embed', 'docs']) {
    expect(read(`web/${script}.js`)).toMatch(/from '\.\/common\.js'/);
  }
  for (const html of ['index', 'watch', 'upload', 'docs']) {
    expect(read(`web/${html}.html`)).toContain('<span data-zh="DL 视频">DL video</span>');
  }
});

test('every English sentence in the docs page has a Chinese translation beside it', () => {
  const unwrapped = read('web/docs.js')
    .replace(/t\('[^']*', ('[^']*'|"[^"]*")\)/g, 'T')
    .replace(/(mono|code)\((['"`])[\s\S]*?\2\)/g, 'T');
  const strings = [...unwrapped.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2]);
  // Header values (CSP and friends) are not prose.
  const left = strings.filter((text) => (/[A-Za-z]{3,} [A-Za-z]{2,}/.test(text) || /\/ month/.test(text)) && !/-src |max-age|=\(\)/.test(text));
  expect(left).toEqual([]);
  expect(read('web/docs.js')).toMatch(/^import \{[^}]*\bt\b[^}]*\} from '\.\/common\.js';$/m);
});
