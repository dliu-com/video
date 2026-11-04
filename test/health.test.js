// Guards the status.dliu.com health contract: /health, the /docs#health tab and /docs/health.md (dliu-com/status HEALTH.md).
const fs = require('fs');
const path = require('path');
const { FUNCTIONS, health } = require('../lambda/api/health');
const { createHandler } = require('../lambda/api');
const { humanRules } = require('./human-docs');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const md = read('web/docs/health.md');
const html = read('web/docs.html');
const start = html.indexOf('<article id="health"');
const page = html.slice(start, html.indexOf('</article>', start));
const KEYS = FUNCTIONS.map((f) => f.key);
const section = (text, title) => text.split(title)[1].split('\n## ')[0];
const mdRows = (text) => text.split('\n').filter((l) => /^\| (?!-)/.test(l)).slice(1)
  .map((l) => l.slice(1, -1).split('|').map((c) => c.trim().replace(/`/g, '')));
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
    await jest.advanceTimersByTimeAsync(3999);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
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

test('the function keys agree across /health, the /docs#health tab and /docs/health.md', () => {
  const mdFunctions = mdRows(section(md, '## Functions')).map((r) => r[0]);
  expect([...page.matchAll(/<tr data-function="([a-z]+)"/g)].map((m) => m[1])).toEqual(mdFunctions);
  expect([...page.matchAll(/data-chart="([a-z]+)"/g)].map((m) => m[1])).toEqual(mdFunctions);
  for (const key of KEYS) expect(mdFunctions).toContain(key);
  const mdJson = JSON.parse(section(md, '## Health endpoint').split('```json\n')[1].split('```')[0]);
  expect(mdJson.functions.map((f) => [f.key, f.name])).toEqual(FUNCTIONS.map((f) => [f.key, f.name]));
  expect(mdRows(section(md, '## Health endpoint')).map((r) => r[0])).toEqual(KEYS);
  for (const [key] of mdRows(section(md, '## Guest checks'))) expect(mdFunctions).toContain(key);
});

test('the Markdown file has every technical detail of the guest checks', () => {
  const guest = mdRows(section(md, '## Guest checks'));
  for (const [, method, url, status] of guest) {
    expect(method).toMatch(/^(GET|HEAD)$/);
    expect(url).toMatch(/^https:\/\/(video\.dliu\.com|[a-z0-9]+\.execute-api\.eu-west-1\.amazonaws\.com)\//);
    expect(status).toMatch(/^\d{3}$/);
  }
  expect(guest).toContainEqual(expect.arrayContaining(['https://video.dliu.com/auth/login', '302']));
  expect(guest.find((r) => r[2] === 'https://video.dliu.com/auth/login')[5]).toContain('https://login.microsoftonline.com/');
  expect(guest.find((r) => r[2] === 'https://video.dliu.com/api/me').slice(3, 6)).toEqual(['401', 'application/json', 'JSON key error']);
  expect(md).toContain('```json');
  // The managed API URL is the one published in the API reference.
  const msapi = guest.find((r) => r[0] === 'msapi')[2].replace(/\/api\/me$/, '');
  expect(read('web/docs/api.md')).toContain(msapi);
});

test('the chart and the big numbers on the tab match the checks in the Markdown file', () => {
  const guest = mdRows(section(md, '## Guest checks'));
  const reads = mdRows(section(md, '## Health endpoint'));
  let total = 0;
  for (const row of page.matchAll(/<div class="hc-row" data-chart="([a-z]+)">([\s\S]*?)<\/div>/g)) {
    const [, key, body] = row;
    const visits = guest.filter((r) => r[0] === key).length;
    const self = reads.filter((r) => r[0] === key).length;
    expect([key, (body.match(/class="hc-visit"/g) || []).length, (body.match(/class="hc-self"/g) || []).length])
      .toEqual([key, visits, self]);
    expect(body).toContain(`<span class="hc-count">${visits + self}</span>`);
    total += visits + self;
  }
  expect(total).toBe(guest.length + reads.length);
  expect(page).toContain(`<strong>${total}</strong><small data-zh="项检查，每个地方每轮">checks from each place, every round</small>`);
  const functions = mdRows(section(md, '## Functions')).length;
  expect(page).toContain(`<strong>${functions}</strong><small data-zh="项功能被测试">functions tested</small>`);
});


test('the /docs#health Testing tab shows flows, numbers, a table and a chart, with no technical details', () => {
  expect(page).toMatch(/^<article id="health" class="dl-docs health-doc" hidden>/);
  expect((page.match(/class="dg-flow[ "]/g) || []).length).toBeGreaterThanOrEqual(2);
  expect((page.match(/class="dg-step[ "]/g) || []).length).toBeGreaterThanOrEqual(8);
  expect(page).toMatch(/class="dg-arrow"/);
  for (const tone of ['dg-good', 'dg-warn', 'dg-bad']) expect(page).toMatch(new RegExp(`class="dg-step ${tone}"`));
  expect(page).toMatch(/class="dg-stats/);
  expect((page.match(/class="dg-stat"/g) || []).length).toBeGreaterThanOrEqual(4);
  expect(page).toMatch(/<table class="health-table">/);
  expect(page).toMatch(/<th class="health-ok"[^>]*>Working<\/th><th class="health-bad"/);
  expect(page).toMatch(/class="dg health-chart"/);
  expect(page).toMatch(/data-zh="测不到的部分">What isn't tested</);
  expect(section(md, '## Not tested')).toMatch(/uploading/);
  expect(page).toMatch(/<a href="\/docs\/health\.md"[^>]*>Technical version for machines \(Markdown\)<\/a><\/p>\s*$/);
  humanRules(page, ['/docs/health.md']);
});

test('the Testing tab is on /docs and /docs/health redirects to it', () => {
  expect(html).toContain('<a href="#health" data-tab="health" data-zh="测试">Testing</a>');
  expect(read('web/docs.js')).toMatch(/const TABS = \[[^\]]*'health'[^\]]*\]/);
  for (const file of ['web/docs-health.html', 'web/docs-api.html']) expect(fs.existsSync(path.join(__dirname, '..', file))).toBe(false);
  const code = read('functions/pages.js');
  const pages = new Function(`${code}\nreturn handler;`)();
  for (const uri of ['/docs/health', '/docs/health/']) {
    expect(pages({ request: { uri } })).toEqual({
      statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: '/docs#health' } },
    });
  }
  expect(pages({ request: { uri: '/docs/health.md' } }).uri).toBe('/docs/health.md');
});
