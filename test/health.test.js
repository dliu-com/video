// Guards the status.dliu.com health contract: /health, /docs/health and /docs/health.md (dliu-com/status HEALTH.md).
const fs = require('fs');
const path = require('path');
const { FUNCTIONS, health } = require('../lambda/api/health');
const { createHandler } = require('../lambda/api');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const md = read('web/docs/health.md');
const html = read('web/docs-health.html');
const page = html.slice(html.indexOf('<article class="dl-docs health-doc"'), html.indexOf('</article>'));
const KEYS = FUNCTIONS.map((f) => f.key);
const section = (text, title) => text.split(title)[1].split('\n## ')[0];
const mdRows = (text) => text.split('\n').filter((l) => /^\| (?!-)/.test(l)).slice(1)
  .map((l) => l.slice(1, -1).split('|').map((c) => c.trim().replace(/`/g, '')));
const unescape = (text) => text.replace(/<\/?code>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const htmlRows = (text) => [...text.matchAll(/<tr>((?:<td>.*?<\/td>)+)<\/tr>/g)]
  .map((m) => [...m[1].matchAll(/<td>(.*?)<\/td>/g)].map((c) => unescape(c[1])));
const probes = (over = {}) => ({ catalog: async () => {}, signin: async () => {}, ...over });

test('/health reports every function in application/health+json, cached 60 s, and reveals nothing private', async () => {
  const r = await health({ probes: probes(), now: () => Date.UTC(2026, 10, 4, 9) });
  expect(r.statusCode).toBe(200);
  expect(r.headers['content-type']).toBe('application/health+json');
  expect(r.headers['cache-control']).toBe('public, max-age=60');
  const body = JSON.parse(r.body);
  expect(Object.keys(body)).toEqual(['status', 'time', 'functions']);
  expect(body).toMatchObject({ status: 'pass', time: '2026-11-04T09:00:00Z' });
  expect(body.functions).toEqual(FUNCTIONS.map((f) => ({ ...f, status: 'pass' })));
  expect(r.body).not.toMatch(/video\.dliu|bucket|arn:|amazonaws|catalog\.json|@/i);
});

test('a slow check warns (200); a failed or timed-out check fails (503) with a generic reason only', async () => {
  let t = 0;
  const slow = await health({ probes: probes(), clock: () => (t += 600) });
  expect(slow.statusCode).toBe(200);
  const slowBody = JSON.parse(slow.body);
  expect(slowBody.status).toBe('warn');
  expect(slowBody.functions.every((f) => f.status === 'warn' && f.output === 'slow')).toBe(true);

  const failed = await health({ probes: probes({ catalog: async () => { throw new Error('AccessDenied arn:aws:s3:::secret-bucket'); } }) });
  expect(failed.statusCode).toBe(503);
  expect(JSON.parse(failed.body).functions.find((f) => f.key === 'catalog'))
    .toEqual({ key: 'catalog', name: 'Video list and storage', status: 'fail', output: 'read failed' });
  expect(failed.body).not.toMatch(/AccessDenied|arn|secret/);

  jest.useFakeTimers();
  try {
    const pending = health({ probes: probes({ signin: () => new Promise(() => {}) }) });
    await jest.advanceTimersByTimeAsync(2000);
    const hung = JSON.parse((await pending).body);
    expect(hung.functions.find((f) => f.key === 'signin')).toMatchObject({ status: 'fail', output: 'timeout' });
  } finally {
    jest.useRealTimers();
  }
});

test('the default probes do one HeadObject of the catalog and load the sign-in settings', () => {
  const source = read('lambda/api/health.js');
  expect(source).toMatch(/HeadObjectCommand\(\{ Bucket: process\.env\.VIDEO_BUCKET, Key: 'data\/catalog\.json' \}\)/);
  expect(source).not.toMatch(/List|GetObjectCommand|fetch\(/);
  expect(source).toMatch(/loadConfig\(\)/);
});

test('the handler answers /health without reading cookies, headers, the query string or the body', async () => {
  let calls = 0;
  const handler = createHandler({
    health: async () => { calls++; return { statusCode: 200, body: '{}' }; },
    loadConfig: async () => { throw new Error('/health must not load the config in the handler'); },
  });
  for (const method of ['GET', 'HEAD']) {
    const event = { rawPath: '/health', requestContext: { http: { method } } };
    for (const field of ['cookies', 'headers', 'queryStringParameters', 'body', 'isBase64Encoded', 'rawQueryString']) {
      Object.defineProperty(event, field, { get() { throw new Error(`/health read ${field}`); } });
    }
    expect((await handler(event)).statusCode).toBe(200);
  }
  expect(calls).toBe(2);
  const post = await handler({ rawPath: '/health', requestContext: { http: { method: 'POST' } }, headers: {}, cookies: [] });
  expect(post.statusCode).not.toBe(200);
  expect(calls).toBe(2);
});

test('the function keys agree across /health, /docs/health and /docs/health.md', () => {
  const mdFunctions = mdRows(section(md, '## Functions')).map((r) => r[0]);
  expect([...page.matchAll(/data-function="([a-z]+)"/g)].map((m) => m[1])).toEqual(mdFunctions);
  for (const key of KEYS) expect(mdFunctions).toContain(key);
  const mdJson = JSON.parse(section(md, '## Health endpoint').split('```json\n')[1].split('```')[0]);
  expect(mdJson.functions.map((f) => [f.key, f.name])).toEqual(FUNCTIONS.map((f) => [f.key, f.name]));
  expect(mdRows(section(md, '## Health endpoint')).map((r) => r[0])).toEqual(KEYS);
  for (const [key] of mdRows(section(md, '## Guest checks'))) expect(mdFunctions).toContain(key);
  const mdJsonText = section(md, '## Health endpoint').split('```json\n')[1].split('```')[0].trimEnd();
  expect(unescape(page.split('<pre class="code">')[1].split('</pre>')[0])).toBe(mdJsonText);
});

test('the guest checks and /health details on the page match the Markdown file', () => {
  const guest = mdRows(section(md, '## Guest checks'));
  const reads = mdRows(section(md, '## Health endpoint'));
  const rows = htmlRows(page);
  expect(rows).toEqual([...guest, ...reads]);
  for (const [, method, url, status] of guest) {
    expect(method).toMatch(/^(GET|HEAD)$/);
    expect(url).toMatch(/^https:\/\/(video\.dliu\.com|[a-z0-9]+\.execute-api\.eu-west-1\.amazonaws\.com)\//);
    expect(status).toMatch(/^\d{3}$/);
  }
  expect(guest).toContainEqual(expect.arrayContaining(['https://video.dliu.com/auth/login', '302']));
  expect(guest.find((r) => r[2] === 'https://video.dliu.com/auth/login')[5]).toContain('https://login.microsoftonline.com/');
  expect(guest.find((r) => r[2] === 'https://video.dliu.com/api/me').slice(3, 6)).toEqual(['401', 'application/json', 'JSON key error']);
  // The managed API URL is the one published in the API reference.
  const msapi = guest.find((r) => r[0] === 'msapi')[2].replace(/\/api\/me$/, '');
  expect(read('web/docs/api.md')).toContain(msapi);
});

test('/docs/health has a diagram, plain lines per function, and every technical detail folded', () => {
  expect(page).toMatch(/data-path="\/docs\/health"/);
  expect(page).toMatch(/class="dg-flow"/);
  expect((page.match(/class="dg-step[ "]/g) || []).length).toBeGreaterThanOrEqual(4);
  expect(page).toMatch(/class="dg-arrow"/);
  for (const tone of ['dg-good', 'dg-warn', 'dg-bad']) expect(page).toMatch(new RegExp(`class="dg-step ${tone}"`));
  const details = [...page.matchAll(/<details\b[^>]*>/g)].map((m) => m[0]);
  expect(details.length).toBeGreaterThanOrEqual(2);
  for (const tag of details) expect(tag).not.toMatch(/\bopen\b/);
  const unfolded = page.replace(/<details\b[\s\S]*?<\/details>/g, '');
  expect(unfolded).not.toMatch(/<code>|<pre|<table|https:\/\/|\b(200|302|401|503)\b|application\//);
  expect(page).toMatch(/<a href="\/docs\/health\.md"[^>]*>Full technical version \(Markdown\)<\/a>/);
  expect(page).toMatch(/data-zh="测不到的部分">What isn't tested</);
  expect(section(md, '## Not tested')).toMatch(/uploading/);
  // Bilingual: every element with English prose carries its Chinese text.
  const prose = [...unfolded.matchAll(/<(p|li|strong|small|span|h[23]|figcaption|summary)\b([^>]*)>([^<]*[A-Za-z]{3,} [A-Za-z]{2,}[^<]*)</g)];
  expect(prose.length).toBeGreaterThan(15);
  for (const [, , attributes, text] of prose) expect([text, attributes]).toEqual([text, expect.stringContaining('data-zh=')]);
});

test('every docs page links the Health checks tab', () => {
  for (const file of ['web/docs.html', 'web/docs-api.html', 'web/docs-health.html']) {
    expect(read(file)).toMatch(/<a href="\/docs\/health"[^>]*data-zh="健康检查">Health checks<\/a>/);
  }
});
