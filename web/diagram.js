// Small DOM/SVG diagram kit for the docs page (from dliu-com/traffic-monitor).
const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  browser: ['#4b6575', [['rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2 }], ['path', { d: 'M3 9h18' }], ['circle', { cx: 6, cy: 6.8, r: 0.6, fill: '#fff' }], ['circle', { cx: 8.3, cy: 6.8, r: 0.6, fill: '#fff' }]]],
  cloudfront: ['#8c4fff', [['circle', { cx: 12, cy: 12, r: 8.5 }], ['ellipse', { cx: 12, cy: 12, rx: 3.6, ry: 8.5 }], ['path', { d: 'M3.5 12h17M5 7.5h14M5 16.5h14' }]]],
  lambda: ['#ed7100', [['path', { d: 'M6.5 4h3.5l8 16' }], ['path', { d: 'M12.3 10.6 6.5 20' }]]],
  s3: ['#7aa116', [['ellipse', { cx: 12, cy: 6, rx: 8, ry: 2.6 }], ['path', { d: 'M4 6l1.9 12.6c.3 1.6 2.9 2.6 6.1 2.6s5.8-1 6.1-2.6L20 6' }]]],
  athena: ['#8c4fff', [['circle', { cx: 10.5, cy: 10.5, r: 6.5 }], ['path', { d: 'M15.3 15.3 20.5 20.5M7.8 9h5.4M7.8 12h3.6' }]]],
  glue: ['#8c4fff', [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 1.5 }], ['path', { d: 'M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10' }]]],
  ssm: ['#e7157b', [['path', { d: 'M4 6h16M4 12h16M4 18h16' }], ['circle', { cx: 9, cy: 6, r: 2, fill: '#e7157b' }], ['circle', { cx: 15.5, cy: 12, r: 2, fill: '#e7157b' }], ['circle', { cx: 7.5, cy: 18, r: 2, fill: '#e7157b' }]]],
  entra: ['#0078d4', [['rect', { x: 4.5, y: 4.5, width: 6.8, height: 6.8, fill: '#fff', stroke: 'none' }], ['rect', { x: 12.7, y: 4.5, width: 6.8, height: 6.8, fill: '#fff', stroke: 'none' }], ['rect', { x: 4.5, y: 12.7, width: 6.8, height: 6.8, fill: '#fff', stroke: 'none' }], ['rect', { x: 12.7, y: 12.7, width: 6.8, height: 6.8, fill: '#fff', stroke: 'none' }]]],
  cookie: ['#805719', [['path', { d: 'M20.5 12.6A8.5 8.5 0 1 1 11.4 3.5a3 3 0 0 0 3.8 3.8 3 3 0 0 0 5.3 5.3z' }], ['circle', { cx: 8.5, cy: 10, r: 1, fill: '#fff' }], ['circle', { cx: 13, cy: 15.5, r: 1, fill: '#fff' }], ['circle', { cx: 8.8, cy: 15.8, r: 1, fill: '#fff' }], ['circle', { cx: 15.6, cy: 11.6, r: 0.8, fill: '#fff' }]]],
  key: ['#dd344c', [['circle', { cx: 8, cy: 15.5, r: 4.2 }], ['path', { d: 'M11 12.5 19.5 4M16 7.5l2.6 2.6M13.8 9.7l2 2' }]]],
  shield: ['#dd344c', [['path', { d: 'M12 2.8l7.5 3v5.4c0 4.8-3.2 8.7-7.5 10.1-4.3-1.4-7.5-5.3-7.5-10.1V5.8z' }], ['path', { d: 'M8.8 12.2l2.2 2.2 4.3-4.6' }]]],
  lock: ['#dd344c', [['rect', { x: 4.5, y: 10.5, width: 15, height: 10.5, rx: 2 }], ['path', { d: 'M8 10.5V7.8a4 4 0 0 1 8 0v2.7M12 14.5v3' }]]],
  user: ['#4b6575', [['circle', { cx: 12, cy: 8, r: 3.8 }], ['path', { d: 'M4.5 20.5c.9-4.2 4-6.6 7.5-6.6s6.6 2.4 7.5 6.6' }]]],
  users: ['#805719', [['circle', { cx: 9, cy: 8.5, r: 3.2 }], ['path', { d: 'M2.8 19.5c.6-3.5 3.2-5.5 6.2-5.5s5.6 2 6.2 5.5' }], ['circle', { cx: 16.6, cy: 9, r: 2.6 }], ['path', { d: 'M16.4 14.2c2.5.1 4.3 1.9 4.9 4.8' }]]],
  bot: ['#7b2d2d', [['rect', { x: 4.5, y: 8, width: 15, height: 11.5, rx: 3 }], ['path', { d: 'M12 8V4.5M9.5 16h5' }], ['circle', { cx: 9.2, cy: 12.3, r: 1.2, fill: '#fff' }], ['circle', { cx: 14.8, cy: 12.3, r: 1.2, fill: '#fff' }]]],
  chart: ['#147cab', [['path', { d: 'M4 4v16h16' }], ['path', { d: 'M7 15l4-5 3 3 5.5-7' }]]],
  check: ['#2e8540', [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M8 12.3l2.7 2.7L16 9.6' }]]],
  clock: ['#147cab', [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7.5V12l3.2 2' }]]],
  power: ['#2e8540', [['path', { d: 'M12 3v8.5' }], ['path', { d: 'M7.2 6.6a7.5 7.5 0 1 0 9.6 0' }]]],
  budget: ['#2e8540', [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M14.8 8.6c-.5-1.1-1.6-1.7-2.9-1.7-1.6 0-2.8.9-2.8 2.1 0 2.9 5.9 1.6 5.9 4.7 0 1.3-1.3 2.3-3 2.3-1.4 0-2.6-.6-3.1-1.8M12 5v1.9M12 16v2.9' }]]],
  stack: ['#e7157b', [['path', { d: 'M12 3.5l8.5 4.5-8.5 4.5L3.5 8z' }], ['path', { d: 'M3.5 12.3l8.5 4.5 8.5-4.5M3.5 16.3l8.5 4.5 8.5-4.5' }]]],
  filter: ['#8c4fff', [['path', { d: 'M3.5 5h17l-6.5 8v6l-4 2v-8z' }]]],
  eye: ['#147cab', [['path', { d: 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]]],
  page: ['#4b6575', [['path', { d: 'M6 2.5h8.5l4 4V21.5H6z' }], ['path', { d: 'M14.5 2.5v4h4M9 12h6.5M9 15.5h6.5' }]]],
  pin: ['#147cab', [['path', { d: 'M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z' }], ['circle', { cx: 12, cy: 10, r: 2.3 }]]],
  link: ['#147cab', [['path', { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' }]]],
  code: ['#4b6575', [['path', { d: 'M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5M13.5 5l-3 14' }]]],
  film: ['#2563eb', [['rect', { x: 3.5, y: 5, width: 17, height: 14, rx: 2 }], ['path', { d: 'M7.5 5v14M16.5 5v14M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4' }]]],
  play: ['#2563eb', [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M10 8.5v7l5.5-3.5z', fill: '#fff' }]]],
  upload: ['#2e8540', [['path', { d: 'M12 15.5V4.5M7.5 9 12 4.5 16.5 9' }], ['path', { d: 'M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15' }]]],
  route53: ['#8c4fff', [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 3.5v17M3.5 12h17' }]]],
};

const svgNode = (tag, attrs) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

export function icon(name) {
  const [colour, parts] = ICONS[name] ?? ICONS.browser;
  const box = el('span', 'dg-icon');
  box.style.setProperty('--dg', colour);
  box.setAttribute('aria-hidden', 'true');
  const svg = svgNode('svg', { viewBox: '0 0 24 24', focusable: 'false' });
  for (const [tag, attrs] of parts) svg.append(svgNode(tag, attrs));
  box.append(svg);
  return box;
}

function arrow() {
  const span = el('span', 'dg-arrow');
  const svg = svgNode('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgNode('path', { d: 'M4 12h15M13 6l6 6-6 6' }));
  span.append(svg);
  return span;
}

function card(step, className, number) {
  const node = el('div', className);
  if (number != null) node.append(el('span', 'dg-num', String(number)));
  if (step.icon) node.append(icon(step.icon));
  const text = el('span', 'dg-text');
  text.append(el('strong', '', step.title));
  if (step.text) text.append(el('small', '', step.text));
  node.append(text);
  return node;
}

function frame(title, className) {
  const figure = el('figure', 'dg' + (className ? ' ' + className : ''));
  if (title) figure.append(el('figcaption', '', title));
  return figure;
}

function withNote(figure, text) {
  if (text) figure.append(el('p', 'dg-note', text));
  return figure;
}

export function flow({ title, steps, note, numbered = false }) {
  const figure = frame(title);
  const list = el('div', 'dg-flow');
  list.setAttribute('role', 'list');
  steps.forEach((step, index) => {
    if (index) list.append(arrow());
    const item = card(step, 'dg-step' + (step.tone ? ' dg-' + step.tone : ''), numbered ? index + 1 : null);
    item.setAttribute('role', 'listitem');
    list.append(item);
  });
  figure.append(list);
  return withNote(figure, note);
}

export function tiers({ title, rows, note }) {
  const figure = frame(title, 'dg-tiers');
  rows.forEach((row, index) => {
    if (index) {
      const link = el('div', 'dg-link');
      link.append(arrow());
      if (row.link) link.append(el('span', '', row.link));
      figure.append(link);
    }
    const tier = el('div', 'dg-tier' + (row.tone ? ' dg-' + row.tone : ''));
    const label = el('div', 'dg-tier-label');
    if (row.badge) label.append(el('span', 'dg-badge', row.badge));
    label.append(el('strong', '', row.label));
    tier.append(label);
    const nodes = el('div', 'dg-tier-nodes');
    for (const node of row.nodes) nodes.append(card(node, 'dg-node'));
    tier.append(nodes);
    figure.append(tier);
  });
  return withNote(figure, note);
}

export function stats(items) {
  const grid = el('div', 'dg-stats');
  for (const [value, label, name] of items) {
    const box = el('div', 'dg-stat');
    if (name) box.append(icon(name));
    const text = el('span', 'dg-text');
    text.append(el('strong', '', value), el('small', '', label));
    box.append(text);
    grid.append(box);
  }
  return grid;
}

// A cell is a string or { text, className }.
export function table(headers, rows) {
  const wrap = el('div', 'table-wrap');
  const tableNode = el('table');
  const head = el('tr');
  for (const header of headers) head.append(el('th', '', header));
  tableNode.append(el('thead'), el('tbody'));
  tableNode.tHead.append(head);
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) tr.append(typeof cell === 'string' ? el('td', '', cell) : el('td', cell.className, cell.text));
    tableNode.tBodies[0].append(tr);
  }
  wrap.append(tableNode);
  return wrap;
}

// Cards linking to other info pages: [href, icon, title, line, key fact].
export function cards(items) {
  const grid = el('div', 'about-cards');
  for (const [href, name, title, line, key] of items) {
    const card = el('a', 'about-card');
    card.href = href;
    const body = el('span', 'about-card-text');
    body.append(el('strong', '', title), el('span', 'about-card-line', line), el('span', 'about-card-key', key));
    card.append(icon(name), body);
    grid.append(card);
  }
  return grid;
}

export function more(summary, ...content) {
  const details = el('details', 'dg-more');
  const body = el('div');
  body.append(...content);
  details.append(el('summary', '', summary), body);
  return details;
}

export function callout(name, text) {
  const box = el('div', 'dg-callout');
  box.append(icon(name), el('span', '', text));
  return box;
}
