const fs = require('fs');
const path = require('path');
const vm = require('vm');
const routes = require('../lambda/api/routes.json');

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.text = '';
    this.attributes = {};
  }
  set textContent(text) { this.text = text; this.children = []; }
  get textContent() { return this.text + this.children.map((node) => node.textContent).join('\n'); }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
}

function renderDocs() {
  const articles = Object.fromEntries(['architecture', 'cost', 'security', 'health', 'api'].map((id) => [id, new Element('article')]));
  const document = {
    createElement: (tag) => new Element(tag),
    getElementById: (id) => articles[id],
    querySelectorAll: () => [],
  };
  const diagram = (...content) => {
    const node = new Element('figure');
    node.textContent = JSON.stringify(content);
    return node;
  };
  const script = fs.readFileSync(path.join(__dirname, '../web/docs.js'), 'utf8').replace(/^import .*;$/gm, '');
  vm.runInNewContext(script, {
    document, location: { hash: '#architecture' }, window: { addEventListener() {} }, renderNav() {}, t: (zh, en) => en,
    flow: diagram, tiers: diagram, stats: diagram, table: diagram, callout: diagram, more: diagram,
  });
  return articles;
}

test('architecture docs require canonical Auth setup and show only a Video request example', () => {
  const { architecture } = renderDocs();
  const paragraph = architecture.children.find((node) =>
    node.children.some((child) => child.href === 'https://auth.dliu.com/docs/api'));
  expect(paragraph).toBeDefined();
  expect(paragraph.children[0].tagName).toBe('a');
  expect(paragraph.textContent).toContain('Authentication is required');
  expect(paragraph.textContent).toContain('Auth API documentation');
  expect(routes['GET /api/videos'].scope).toBe('video.read');
  expect(architecture.children.some((node) =>
    node.tagName === 'pre' && node.textContent === 'node scripts/api-client.js GET /api/videos')).toBe(true);
  expect(architecture.textContent).toContain('MicrosoftApiUrl from the Video deployment outputs');
  expect(architecture.textContent).toContain('Do not use https://video.dliu.com/api/* for managed requests');
});

test('docs preserve Video permissions, assigned roles, approved client, rollout and retention limits', () => {
  const text = renderDocs().architecture.textContent;
  for (const scope of ['video.read', 'video.write', 'video.delete']) expect(text).toContain(scope);
  for (const expected of [
    'write permission does not include delete',
    'scopes Microsoft actually issued',
    'never fall back to website cookies',
    'Tokens come only from Central Microsoft sign-in at auth.dliu.com',
    'only the single configured client azp is approved',
    'api.access role',
    'dliu API user role (value api.access)',
    'The shared role grants no operation by itself',
    'both claims are still checked independently',
    'Authenticated standard-user gateway success remains unverified',
    'no application-global bearer-token cache',
    'not a forensic zeroization guarantee',
    'managed API is enabled in Video configuration',
    'explicitly approved deployment',
    'public playback and embeds remain unchanged',
  ]) expect(text).toContain(expected);
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  for (const expected of [
    '/dliu/entra-tenant-id', '/dliu/api-app-id',
    'The same shared dliu API application/client ID',
    'Authenticated standard-user gateway success remains unverified',
    'no forensic\nzeroization is promised',
  ]) expect(readme).toContain(expected);
});

test('Video documentation delegates generic credential and header tutorials to the Auth documentation', () => {
  const architecture = renderDocs().architecture.textContent;
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  expect(readme).toContain('[Auth API documentation](https://auth.dliu.com/docs/api)');
  expect(readme).toContain('credentials and an authenticated requester configured per');
  for (const text of [architecture, readme]) {
    expect(text).not.toMatch(/\.dliu_token|VIDEO_API_ACCESS_TOKEN|VIDEO_API_TOKEN_FILE|expires_at=|Authorization:|Save file|Copy or Save|23:59:59|auth\.dliu\.com\/redirect\.html/);
  }
});

test('docs record the CDN caching and automatic-clearing decision and the current price class', () => {
  const text = Object.values(renderDocs()).map((article) => article.textContent).join('\n');
  expect(text).toContain('Clearing the CDN');
  expect(text).toContain('no automatic clearing');
  expect(text).toContain('price class All');
  expect(text).not.toContain('price class 100');
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  expect(readme).toContain('## Caching and CDN clearing');
  expect(readme).toContain('There is no automatic clearing');
});

test('security docs list every review finding and how to rerun the live tests', () => {
  const text = renderDocs().security.textContent;
  for (const id of ['V-1', 'V-2', 'V-3', 'V-4', 'V-5', 'V-6']) expect(text).toContain(id);
  for (const expected of ['make pentest', 'Denial of wallet', 'STRIDE', 'gitleaks', 'npm audit', "default-src 'none'; sandbox"]) {
    expect(text).toContain(expected);
  }
});

test('every data-icon placeholder on /docs names an icon in the diagram kit', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../web/docs.html'), 'utf8');
  const kit = fs.readFileSync(path.join(__dirname, '../web/diagram.js'), 'utf8');
  const names = [...html.matchAll(/data-icon="(\w+)"/g)].map((m) => m[1]);
  expect(names.length).toBeGreaterThan(20);
  for (const name of new Set(names)) expect([name, kit]).toEqual([name, expect.stringMatching(new RegExp(`\\n  ${name}: \\['#`))]);
  expect(fs.readFileSync(path.join(__dirname, '../web/docs.js'), 'utf8')).toMatch(/querySelectorAll\('\[data-icon\]'\)\) slot\.replaceWith\(icon\(/);
});
