const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const routes = require('../lambda/api/routes.json');
const { CONTENT_TYPES, partPlan } = require('../lambda/api/videos');
const { publicVideo } = require('../lambda/api/store');
const { createHandler } = require('../lambda/api/index');
const { createFakeS3 } = require('./fake-s3');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const markdown = read('web/docs/api.md');
const blocks = (text, language) => [...text.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```', 'g'))].map((match) => match[1]);
const endpoints = [...markdown.matchAll(/^### (GET|POST) (\/api\/\S+)\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/gm)];
const examples = Object.fromEntries(endpoints.map((match) => [
  `${match[1]} ${match[2]}`, blocks(match[3], 'json').map((text) => JSON.parse(text)),
]));

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  get textContent() { return this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
}
const el = (tag, attrs = {}, ...children) => {
  const node = new Element(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
};
const walk = (node) => [node, ...node.children.filter((child) => child instanceof Element).flatMap(walk)];

function renderer() {
  const context = { el, renderNav: jest.fn(), document: { getElementById: () => null }, fetch: jest.fn() };
  vm.runInNewContext(read('web/docs-api.js').replace(/^import .*;$/gm, '').replace(/^export /gm, ''), context);
  return context;
}

test('the reference documents exactly the managed routes and their route scopes', () => {
  expect(endpoints.map((match) => `${match[1]} ${match[2]}`)).toEqual(Object.keys(routes));
  for (const match of endpoints) {
    const route = `${match[1]} ${match[2]}`;
    expect(match[3]).toContain(`Required scope: \`${routes[route].scope}\``);
    expect(match[3]).toContain('Response (200)');
    expect(examples[route]).toHaveLength(match[1] === 'GET' ? 1 : 2);
  }
  for (const type of Object.keys(CONTENT_TYPES)) expect(markdown).toContain(`\`${type}\``);
  expect(partPlan(examples['POST /api/uploads'][0].size)).toEqual({
    partSize: examples['POST /api/uploads'][1].partSize, partCount: examples['POST /api/uploads'][1].partCount,
  });
  expect(require('../config/site.json').maxUploadGiB).toBe(50);
  expect(markdown).toContain('53,687,091,200 bytes');
});

test('the public Video example matches the actual response schema and path construction', () => {
  const sample = JSON.parse(blocks(markdown.split('## Video objects\n')[1].split('## Read endpoints\n')[0], 'json')[0]);
  const { src, poster, ...fields } = sample;
  expect(publicVideo({ ...fields, ext: 'mp4', posterVersion: null })).toEqual(sample);
  expect(src).toBe('/v/2026110100.mp4');
  expect(poster).toBeNull();
});

test('the reference documents the actual large-upload completion-body limitation', () => {
  const plan = partPlan(50 * 1024 ** 3);
  expect(plan.partCount).toBe(3200);
  const completion = JSON.stringify({ id: '2026110100', uploadId: 'example-upload-id',
    parts: Array.from({ length: plan.partCount }, (_, index) => ({
      partNumber: index + 1, etag: `"${'a'.repeat(32)}"`,
    })) });
  expect(completion.length).toBeGreaterThan(65536);
  expect(markdown).toContain('50-GiB start cap does not guarantee that an upload can be completed');
  expect(markdown).toContain('3,200 parts');
  expect(markdown).toContain('COMPLETION_BUDGET');
});

function sameShape(actual, example) {
  if (example === null) expect(actual).toBeNull();
  else if (Array.isArray(example)) expect(Array.isArray(actual)).toBe(true);
  else if (typeof example === 'object') {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(example).sort());
    for (const key of Object.keys(example)) sameShape(actual[key], example[key]);
  } else expect(typeof actual).toBe(typeof example);
}

test('documented request examples exercise all nine handlers locally with matching response shapes', async () => {
  const original = { ...process.env };
  const tenant = '11111111-1111-4111-8111-111111111111';
  const application = '22222222-2222-4222-8222-222222222222';
  Object.assign(process.env, { API_GATEWAY_ID: 'docs-test-api', API_TENANT_ID: tenant, API_AUDIENCE: application,
    API_CLIENT_ID: application, SITE_URL: 'https://video.dliu.com', VIDEO_BUCKET: 'docs-test-bucket',
    AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'test-secret',
    MAX_UPLOAD_BYTES: String(50 * 1024 ** 3) });
  try {
    const s3 = createFakeS3();
    const handler = createHandler({ s3, now: () => Date.UTC(2026, 10, 1, 12), invalidate: async () => {},
      loadConfig: () => { throw new Error('Docs managed examples must not load website secrets'); } });
    const call = async (route, body) => {
      const [method, rawPath] = route.split(' ');
      const response = await handler({ rawPath, body: body === undefined ? undefined : JSON.stringify(body),
        headers: {}, requestContext: { apiId: 'docs-test-api', routeKey: route, http: { method },
          authorizer: { jwt: { scopes: ['video.read', 'video.write', 'video.delete'], claims: {
            ver: '2.0', tid: tenant, aud: application, azp: application,
            iss: `https://login.microsoftonline.com/${tenant}/v2.0`, oid: 'docs-test-user',
            sub: 'docs-test-subject', roles: ['api.access'], name: 'Example user',
          } } } } });
      expect(response.statusCode).toBe(200);
      const value = JSON.parse(response.body);
      sameShape(value, examples[route].at(-1));
      return value;
    };
    await call('GET /api/me');
    await call('GET /api/videos');
    const plan = await call('POST /api/uploads', examples['POST /api/uploads'][0]);
    await call('POST /api/uploads/parts', { ...examples['POST /api/uploads/parts'][0], id: plan.id, uploadId: plan.uploadId });
    await call('POST /api/uploads/complete', { ...examples['POST /api/uploads/complete'][0], id: plan.id, uploadId: plan.uploadId });
    await call('POST /api/videos/update', { ...examples['POST /api/videos/update'][0], id: plan.id });
    await call('POST /api/videos/poster', { ...examples['POST /api/videos/poster'][0], id: plan.id });
    const cancelled = await call('POST /api/uploads', examples['POST /api/uploads'][0]);
    await call('POST /api/uploads/abort', { ...examples['POST /api/uploads/abort'][0], id: cancelled.id, uploadId: cancelled.uploadId });
    await call('POST /api/videos/delete', { ...examples['POST /api/videos/delete'][0], id: plan.id });
  } finally { process.env = original; }
});

test('the Markdown reference renders tables, code and endpoint anchors without executing HTML', () => {
  const { renderApiMarkdown } = renderer();
  const content = renderApiMarkdown(markdown);
  const nodes = walk(content);
  expect(nodes.filter((node) => node.tag === 'h3').map((node) => node.textContent)).toEqual(Object.keys(routes));
  expect(nodes.filter((node) => node.tag === 'table').length).toBeGreaterThanOrEqual(5);
  for (const node of nodes.filter((node) => node.tag === 'a' && node.attributes.href.startsWith('#'))) {
    expect(nodes.some((target) => target.attributes.id === node.attributes.href.slice(1))).toBe(true);
  }
  const malicious = renderApiMarkdown('# Reference\n\n<script>alert(1)</script> [bad](javascript:alert) [bad2](//evil.example)\n\n```html\n<img onerror="bad">\n```');
  expect(walk(malicious).some((node) => ['script', 'img', 'a'].includes(node.tag))).toBe(false);
  expect(malicious.textContent).toContain('<script>alert(1)</script>');
});

test('fetch and document-format failures are surfaced instead of leaving a loading or success placeholder', async () => {
  const context = renderer();
  const root = el('div');
  context.fetch.mockResolvedValueOnce({ ok: true, text: async () => markdown });
  await context.loadApiDocs(root);
  expect(context.fetch).toHaveBeenCalledWith('/docs/api.md');
  expect(root.textContent).toContain('POST /api/uploads/complete');
  context.fetch.mockResolvedValueOnce({ ok: false, status: 503 });
  await context.loadApiDocs(root);
  expect(root.textContent).toContain('Could not load the API reference: HTTP 503');
  expect(walk(root).some((node) => node.attributes.role === 'alert')).toBe(true);
  context.fetch.mockResolvedValueOnce({ ok: true, text: async () => '```json\nunclosed' });
  await context.loadApiDocs(root);
  expect(root.textContent).toContain('Unclosed code block');
});

test('API navigation is linked from docs, keeps the website header active and preserves sign-in return paths', () => {
  expect(read('web/docs.html')).toContain('<a href="/docs/api">API</a>');
  expect(read('web/docs-api.html')).toContain('<a href="/docs/api" aria-current="page">API</a>');
  expect(read('web/docs-api.html')).toContain('href="/docs/api.md"');
  for (const pathname of ['/docs', '/docs/api', '/docs/api/']) {
    const nav = el('nav');
    const context = { Node: Element, location: { pathname, search: '' },
      document: { cookie: '', createElement: (tag) => el(tag),
        querySelector: () => nav } };
    vm.runInNewContext(read('web/common.js').replace(/^export /gm, ''), context);
    context.renderNav();
    expect(nav.children[0].attributes['aria-current']).toBe('page');
    expect(nav.children[1].attributes.href).toBe(`/auth/login?return=${encodeURIComponent(pathname)}`);
  }
});

test('every app menu has exactly one Docs button to /docs, for viewers and the owner, without duplicates', () => {
  for (const html of ['index', 'watch', 'upload', 'docs', 'docs-api']) {
    expect(read(`web/${html}.html`)).toMatch(/<header class="top">[\s\S]*<nav( aria-label="Site")?><\/nav>[\s\S]*<\/header>/);
  }
  for (const pathname of ['/', '/2026102700', '/upload', '/docs', '/docs/api']) {
    for (const cookie of ['', 'video_owner=1']) {
      const nav = el('nav');
      const context = { Node: Element, location: { pathname, search: '' },
        document: { cookie, createElement: (tag) => el(tag), querySelector: () => nav } };
      vm.runInNewContext(read('web/common.js').replace(/^export /gm, ''), context);
      context.renderNav();
      context.renderNav();
      const docs = nav.children.filter((child) => child.attributes.href === '/docs');
      expect(docs).toHaveLength(1);
      expect(nav.children[0]).toBe(docs[0]);
      expect(docs[0].className).toBe('button docs');
      expect(docs[0].textContent).toBe('Docs');
      expect(docs[0].attributes['aria-current']).toBe(pathname.startsWith('/docs') ? 'page' : undefined);
      expect(nav.children.map((child) => child.attributes.href)).toEqual(cookie
        ? ['/docs', '/upload', '/auth/logout'] : ['/docs', `/auth/login?return=${encodeURIComponent(pathname)}`]);
    }
  }
  expect(read('web/style.css')).not.toMatch(/\.docs[^{]*\{[^}]*display:\s*none/);
});

test('Video examples are valid Bash and preserve the separate direct-to-S3 upload contract', () => {
  for (const example of blocks(markdown, 'bash')) {
    const result = spawnSync('bash', ['-n'], { input: example, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }
  expect(markdown).toContain('node scripts/api-client.js "$@"');
  expect(markdown).not.toMatch(/blog_[a-f0-9]|~\/\.dliu_credentials/);
  expect(markdown).toContain('Authenticated standard-user gateway success remains unverified');
  expect(markdown).toContain('Managed API requests do not need `Origin`, website cookies or `x-amz-content-sha256`');
  expect(markdown).toContain('Do not send Microsoft bearer authorization, website cookies or `x-amz-content-sha256` to S3');
  expect(markdown).toContain('repeated call returns 404');
});

test('the reference requires canonical Auth setup without duplicating generic credential or header instructions', () => {
  expect(markdown).toContain('**Authentication is required:**');
  expect(markdown).toContain('[Auth API documentation](https://auth.dliu.com/docs/api)');
  expect(markdown).toContain('credentials and an authenticated requester configured per');
  expect(markdown).toContain('no application-global bearer-token cache');
  expect(markdown).toContain('not a forensic zeroization guarantee');
  const nodes = walk(renderer().renderApiMarkdown(markdown));
  expect(nodes.some((node) => node.tag === 'a' && node.attributes.href === 'https://auth.dliu.com/docs/api')).toBe(true);
  const shell = read('web/docs-api.html');
  expect(shell).toContain('href="https://auth.dliu.com/docs/api">Auth API documentation</a>');
  expect(shell).toContain('Authentication is required');
  for (const source of [markdown, shell]) {
    expect(source).not.toMatch(/\.dliu_token|VIDEO_API_ACCESS_TOKEN|VIDEO_API_TOKEN_FILE|expires_at=|Authorization:|Save file|readAccessToken|23:59:59/);
  }
});

test('the documented Video adapter forwards method/path/JSON unchanged and propagates client failures', () => {
  const helper = blocks(markdown, 'bash').find((example) => example.includes('video_api()'))
    .split('\nvideo_api GET /api/me')[0];
  const body = '{"id":"2026110100","title":"Updated title"}';
  const run = (stub) => spawnSync('/bin/bash', ['-c',
    `${stub}\n${helper}\nvideo_api POST /api/videos/update '${body}'`], {
    encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin' },
  });
  const success = run('node() { printf "%s\\n" "$@"; }');
  expect(success.status).toBe(0);
  expect(success.stdout.trim().split('\n')).toEqual([
    'scripts/api-client.js', 'POST', '/api/videos/update', body,
  ]);
  expect(success.stderr).toBe('');
  const failed = run('node() { return 17; }');
  expect(failed.status).toBe(17);
  expect(failed.stdout).toBe('');
});
