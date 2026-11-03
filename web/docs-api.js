import { el, renderNav, t } from './common.js';

function inline(node, text) {
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    node.append(text.slice(start, match.index));
    if (match[1]) node.append(el('code', {}, match[1]));
    else if (match[4]) node.append(el('strong', {}, match[4]));
    else if (/^(https?:\/\/|\/(?!\/)|#)/.test(match[3])) {
      node.append(el('a', { href: match[3] }, match[2]));
    } else node.append(match[0]);
    start = match.index + match[0].length;
  }
  node.append(text.slice(start));
  return node;
}

// The reference uses only headings, paragraphs, lists, tables and fenced code; never interpret raw HTML.
export function renderApiMarkdown(markdown) {
  const root = el('div');
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const block = (line) => /^(#{1,3} |```|\||- |\d+\. )/.test(line);
  const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (line.startsWith('```')) {
      const content = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) content.push(lines[i++]);
      if (i === lines.length) throw new Error('Unclosed code block in API reference');
      root.append(el('pre', { class: 'code' }, content.join('\n')));
      i += 1;
    } else if (/^#{1,3} /.test(line)) {
      const [, hashes, text] = /^(#{1,3}) (.+)$/.exec(line);
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      root.append(inline(el(`h${hashes.length}`, { id }), text));
      i += 1;
    } else if (line.startsWith('|')) {
      const headers = cells(line);
      if (!lines[i + 1] || !cells(lines[i + 1]).every((cell) => /^:?-{3,}:?$/.test(cell))) {
        throw new Error('Invalid table in API reference');
      }
      const header = el('tr', {}, ...headers.map((text) => inline(el('th', { scope: 'col' }), text)));
      const body = el('tbody');
      i += 2;
      while (i < lines.length && lines[i].startsWith('|')) {
        const row = cells(lines[i++]);
        if (row.length !== headers.length) throw new Error('Invalid table row in API reference');
        body.append(el('tr', {}, ...row.map((text) => inline(el('td'), text))));
      }
      root.append(el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, header), body)));
    } else if (/^(- |\d+\. )/.test(line)) {
      const ordered = /^\d+\. /.test(line);
      const list = el(ordered ? 'ol' : 'ul');
      const marker = ordered ? /^\d+\. / : /^- /;
      while (i < lines.length && marker.test(lines[i])) {
        list.append(inline(el('li'), lines[i++].replace(marker, '')));
      }
      root.append(list);
    } else {
      const content = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !block(lines[i])) content.push(lines[i++]);
      root.append(inline(el('p'), content.join(' ')));
    }
  }
  return root;
}

export async function loadApiDocs(root) {
  try {
    const response = await fetch('/docs/api.md');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    root.replaceChildren(renderApiMarkdown(await response.text()));
  } catch (error) {
    root.replaceChildren(el('p', { class: 'dl-error', role: 'alert' },
      t(`无法加载 API 参考：${error.message}。`, `Could not load the API reference: ${error.message}. `),
      el('a', { href: '/docs/api.md' }, t('直接阅读 Markdown', 'Read the Markdown directly'))));
  }
}

renderNav();
const root = document.getElementById('api-doc');
if (root) loadApiDocs(root);
