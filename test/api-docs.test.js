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
const { humanRules } = require('./human-docs');
const docsHtml = read('web/docs.html');
const apiStart = docsHtml.indexOf('<article id="api"');
const apiTab = docsHtml.slice(apiStart, docsHtml.indexOf('</article>', apiStart));

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

test('documented request examples exercise all ten handlers locally with matching response shapes', async () => {
  const original = { ...process.env };
  const tenant = '11111111-1111-4111-8111-111111111111';
  const application = '22222222-2222-4222-8222-222222222222';
  Object.assign(process.env, { API_GATEWAY_ID: 'docs-test-api', API_TENANT_ID: tenant, API_AUDIENCE: application,
    API_CLIENT_ID: application, SITE_URL: 'https://video.dliu.com', VIDEO_BUCKET: 'docs-test-bucket',
    AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'test-secret',
    MAX_UPLOAD_BYTES: String(50 * 1024 ** 3), MEDIACONVERT_ROLE_ARN: 'arn:aws:iam::123456789012:role/mediaconvert',
    SCHEDULER_ROLE_ARN: 'arn:aws:iam::123456789012:role/scheduler', SCHEDULE_GROUP: 'video-streaming' });
  const fakeAws = (reply) => ({ send: async (command) => reply(command.constructor.name) });
  try {
    const s3 = createFakeS3();
    const handler = createHandler({ s3, now: () => Date.UTC(2026, 10, 1, 12), invalidate: async () => {},
      mediaconvert: fakeAws(() => ({ Job: { Id: 'job-1' } })), scheduler: fakeAws(() => ({})),
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
    await call('POST /api/videos/convert', { ...examples['POST /api/videos/convert'][0], id: plan.id });
    await call('POST /api/videos/update', { ...examples['POST /api/videos/update'][0], id: plan.id });
    await call('POST /api/videos/poster', { ...examples['POST /api/videos/poster'][0], id: plan.id });
    const cancelled = await call('POST /api/uploads', examples['POST /api/uploads'][0]);
    await call('POST /api/uploads/abort', { ...examples['POST /api/uploads/abort'][0], id: cancelled.id, uploadId: cancelled.uploadId });
    await call('POST /api/videos/delete', { ...examples['POST /api/videos/delete'][0], id: plan.id });
  } finally { process.env = original; }
});

// common.js imports i18n.js; the VM gets English stand-ins instead.
const SWITCHER = el('div');
const I18N = { t: (zh, en) => en, locale: undefined, translateError: (m) => m, languageSwitcher: () => SWITCHER };
const commonScript = () => read('web/common.js').replace(/^import .*;$/gm, '').replace(/^export \{[^}]*\};$/gm, '').replace(/^export /gm, '');

test('API navigation is linked from docs, keeps the website header active and preserves sign-in return paths', () => {
  expect(docsHtml).toContain('<a href="#api" data-tab="api">API</a>');
  expect(docsHtml).toContain('<link rel="alternate" type="text/markdown" href="/docs/api.md"');
  for (const pathname of ['/docs', '/docs/']) {
    const nav = el('nav');
    const context = { Node: Element, location: { pathname, search: '' }, ...I18N,
      document: { cookie: '', createElement: (tag) => el(tag),
        querySelector: () => nav } };
    vm.runInNewContext(commonScript(), context);
    context.renderNav();
    expect(nav.children[0].attributes['aria-current']).toBe('page');
    expect(nav.children[1].attributes.href).toBe(`/auth/login?return=${encodeURIComponent(pathname)}`);
  }
});

test('every app menu has exactly one Docs button to /docs, for viewers and the owner, without duplicates', () => {
  for (const html of ['index', 'watch', 'upload', 'docs']) {
    expect(read(`web/${html}.html`)).toMatch(/<header class="dl-header">[\s\S]*<nav class="dl-nav" aria-label="Site" data-zh-label="网站"><\/nav>[\s\S]*<\/header>/);
  }
  for (const pathname of ['/', '/2026102700', '/upload', '/docs']) {
    for (const cookie of ['', 'video_owner=1']) {
      const nav = el('nav');
      const context = { Node: Element, location: { pathname, search: '' }, ...I18N,
        document: { cookie, createElement: (tag) => el(tag), querySelector: () => nav } };
      vm.runInNewContext(commonScript(), context);
      context.renderNav();
      context.renderNav();
      const docs = nav.children.filter((child) => child.attributes.href === '/docs');
      expect(docs).toHaveLength(1);
      expect(nav.children[0]).toBe(docs[0]);
      expect(docs[0].className).toBe('dl-button');
      expect(docs[0].textContent).toBe('Docs');
      expect(docs[0].attributes['aria-current']).toBe(pathname.startsWith('/docs') ? 'page' : undefined);
      expect(nav.children.map((child) => child.attributes.href)).toEqual(cookie
        ? ['/docs', '/upload', '/auth/logout', undefined] : ['/docs', `/auth/login?return=${encodeURIComponent(pathname)}`, undefined]);
      expect(nav.children.at(-1)).toBe(I18N.languageSwitcher());
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
  expect(apiTab).toContain('<a href="https://auth.dliu.com/docs/api" data-zh="Auth API 文档">Auth API documentation</a>');
  for (const source of [markdown, apiTab]) {
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

test('the /docs#api tab shows the endpoints, permissions and flows in plain words, with no exact technical details', () => {
  expect(apiTab).toMatch(/^<article id="api" class="dl-docs api-doc" hidden>/);
  expect((apiTab.match(/class="dg-flow"/g) || []).length).toBeGreaterThanOrEqual(2);
  expect((apiTab.match(/class="dg-step[ "]/g) || []).length).toBeGreaterThanOrEqual(10);
  expect(apiTab).toMatch(/class="dg-arrow"/);
  expect((apiTab.match(/class="dg-stat"/g) || []).length).toBeGreaterThanOrEqual(4);
  const names = { 'video.read': 'Read', 'video.write': 'Change', 'video.delete': 'Delete' };
  const rows = [...apiTab.matchAll(/<tr data-route="([^"]+)"><td>([^<]+)<\/td><td[^>]*>[^<]+<\/td><td class="api-(\w+)"[^>]*>(\w+)<\/td><\/tr>/g)];
  const byPath = Object.fromEntries(Object.entries(routes).map(([route, value]) => [route.split(' ')[1], value]));
  expect(rows.map((m) => m[1])).toEqual(Object.keys(byPath));
  for (const [, route, shown, , permission] of rows) {
    expect(shown).toBe(route);
    expect(permission).toBe(names[byPath[route].scope]);
  }
  const counts = {};
  for (const { scope } of Object.values(routes)) counts[scope] = (counts[scope] || 0) + 1;
  const chart = [...apiTab.matchAll(/<div class="hc-row" data-chart="([\w.]+)">([\s\S]*?)<\/div>/g)];
  expect(Object.fromEntries(chart.map(([, scope, body]) => [scope, (body.match(/<i /g) || []).length]))).toEqual(counts);
  for (const [, scope, body] of chart) expect(body).toContain(`<span class="hc-count">${counts[scope]}</span>`);
  expect(apiTab).toContain(`<strong>${Object.keys(routes).length}</strong><small data-zh="个接口">endpoints</small>`);
  expect(apiTab).toContain(`<strong>${require('../config/site.json').maxUploadGiB} GiB</strong>`);
  expect(markdown).toContain(`All ${['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][Object.keys(routes).length]} managed routes are listed below.`);
  expect(apiTab).toMatch(/<a href="\/docs\/api\.md"[^>]*>Technical version for machines \(Markdown\)<\/a>/);
  humanRules(apiTab, ['/docs/api.md', 'https://auth.dliu.com/docs/api']);
});

test('/docs/api redirects to the API tab and the Markdown reference stays at /docs/api.md', () => {
  expect(read('web/docs.js')).toMatch(/const TABS = \[[^\]]*'api'\]/);
  const pages = new Function(`${read('functions/pages.js')}\nreturn handler;`)();
  for (const uri of ['/docs/api', '/docs/api/']) {
    expect(pages({ request: { uri } }).headers.location.value).toBe('/docs#api');
  }
  expect(pages({ request: { uri: '/docs/api.md' } }).uri).toBe('/docs/api.md');
});
