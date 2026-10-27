const auth = require('../lambda/api/auth');
const { createHandler } = require('../lambda/api/index');
const { ukDate } = require('../lambda/api/videos');
const { createFakeS3 } = require('./fake-s3');

const SITE = 'https://video.dliu.com';
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const config = { tenantId: 't', clientId: 'c', clientSecret: 'secret', allowedDomain: 'example.com' };

process.env.SITE_URL = SITE;
process.env.VIDEO_BUCKET = 'video-bucket';
process.env.AWS_REGION = 'eu-west-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'secret';
process.env.MAX_UPLOAD_BYTES = String(10 * 1024 ** 3);

const session = auth.sign({ user: 'me@example.com', name: 'Me', exp: Math.floor(NOW / 1000) + 7 * 86400 }, auth.sessionKey(config));

function setup({ now = () => NOW } = {}) {
  const s3 = createFakeS3();
  const invalidated = [];
  const handler = createHandler({ loadConfig: async () => config, s3, now, invalidate: async (paths) => { invalidated.push(...paths); } });
  const call = (method, path, { body, signedIn = true, origin = SITE, query } = {}) => handler({
    rawPath: path,
    requestContext: { http: { method } },
    queryStringParameters: query,
    headers: { ...(origin ? { origin } : {}) },
    cookies: signedIn ? [`${auth.SESSION_COOKIE}=${session}`] : [],
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => ({ ...r, json: r.body ? JSON.parse(r.body) : undefined }));
  return { s3, call, invalidated };
}

async function upload(call, s3, overrides = {}) {
  const created = await call('POST', '/api/uploads', {
    body: { title: '  My trip  ', description: 'Line 1\nLine 2', contentType: 'video/mp4', size: 40 * 1024 * 1024, duration: 61.5, width: 1920, height: 1080, poster: true, ...overrides },
  });
  expect(created.statusCode).toBe(200);
  const plan = created.json;
  if (plan.posterUrl) s3.put(new URL(plan.posterUrl).pathname.slice(1), 'jpeg-bytes');
  const parts = Array.from({ length: plan.partCount }, (_, i) => ({ partNumber: i + 1, etag: `"${'a'.repeat(32)}"` }));
  const done = await call('POST', '/api/uploads/complete', { body: { id: plan.id, uploadId: plan.uploadId, parts } });
  expect(done.statusCode).toBe(200);
  return { plan, video: done.json.video };
}

describe('API', () => {
  test('owner endpoints need a session, and clear the owner hint when it is missing', async () => {
    const { call } = setup();
    const result = await call('GET', '/api/videos', { signedIn: false });
    expect(result.statusCode).toBe(401);
    expect(result.cookies.some((c) => c.startsWith(`${auth.OWNER_HINT_COOKIE}=;`))).toBe(true);
  });

  test('POSTs from another origin are refused', async () => {
    const { call } = setup();
    expect((await call('POST', '/api/uploads', { body: {}, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await call('POST', '/api/uploads', { body: {}, origin: '' })).statusCode).toBe(403);
  });

  test('unknown methods and paths', async () => {
    const { call } = setup();
    expect((await call('PUT', '/api/videos')).statusCode).toBe(405);
    expect((await call('GET', '/api/nope')).statusCode).toBe(404);
  });

  test('upload plan: multipart with 16 MiB parts, a pending record and a poster URL', async () => {
    const { call, s3 } = setup();
    const result = await call('POST', '/api/uploads', { body: { title: 'x', contentType: 'video/mp4', size: 40 * 1024 * 1024, poster: true } });
    expect(result.statusCode).toBe(200);
    const plan = result.json;
    expect(plan.id).toBe('2026102700');
    expect(plan.partSize).toBe(16 * 1024 * 1024);
    expect(plan.partCount).toBe(3);
    expect(new URL(plan.posterUrl).pathname).toMatch(new RegExp(`^/t/${plan.id}-[A-Za-z0-9_-]{8}\\.jpg$`));
    const create = s3.calls.find((c) => c.name === 'CreateMultipartUploadCommand').input;
    expect(create).toMatchObject({ Key: `v/${plan.id}.mp4`, ContentType: 'video/mp4', StorageClass: 'INTELLIGENT_TIERING' });
    expect(s3.json(`pending/${plan.id}.json`).uploadId).toBe(plan.uploadId);

    const parts = await call('POST', '/api/uploads/parts', { body: { id: plan.id, uploadId: plan.uploadId, parts: [1, 2, 3] } });
    expect(Object.keys(parts.json.urls)).toEqual(['1', '2', '3']);
    const url = new URL(parts.json.urls[2]);
    expect(url.host).toBe('video-bucket.s3.eu-west-1.amazonaws.com');
    expect(url.searchParams.get('partNumber')).toBe('2');
    expect(url.searchParams.get('uploadId')).toBe(plan.uploadId);

    expect((await call('POST', '/api/uploads/parts', { body: { id: plan.id, uploadId: plan.uploadId, parts: [4] } })).statusCode).toBe(400);
    expect((await call('POST', '/api/uploads/parts', { body: { id: plan.id, uploadId: 'other', parts: [1] } })).statusCode).toBe(404);
  });

  test('part size grows so a large file stays within 10,000 parts', async () => {
    const { call } = setup();
    const size = 9 * 1024 ** 3 + 5;
    const plan = (await call('POST', '/api/uploads', { body: { title: 'big', contentType: 'video/mp4', size } })).json;
    expect(plan.partCount).toBeLessThanOrEqual(10000);
    expect(plan.partSize * plan.partCount).toBeGreaterThanOrEqual(size);
  });

  test.each([
    [{ title: '', contentType: 'video/mp4', size: 10 }, 'title is required'],
    [{ title: 'a', contentType: 'video/x-matroska', size: 10 }, 'Unsupported file type'],
    [{ title: 'a', contentType: 'video/mp4', size: 11 * 1024 ** 3 }, 'size is not valid'],
    [{ title: 'a'.repeat(201), contentType: 'video/mp4', size: 10 }, 'longer than 200'],
  ])('rejects bad upload %#', async (body, message) => {
    const { call } = setup();
    const result = await call('POST', '/api/uploads', { body });
    expect(result.statusCode).toBe(400);
    expect(result.json.error).toContain(message);
  });

  test('completing an upload publishes it', async () => {
    const { call, s3 } = setup();
    const { plan, video } = await upload(call, s3);
    expect(video).toMatchObject({
      id: plan.id, title: 'My trip', description: 'Line 1\nLine 2', duration: 61.5, width: 1920, height: 1080,
      src: `/v/${plan.id}.mp4`, size: 1234,
    });
    expect(video.poster).toMatch(new RegExp(`^/t/${plan.id}-`));
    expect(s3.objects.has(`pending/${plan.id}.json`)).toBe(false);
    expect(s3.json(`data/videos/${plan.id}.json`)).toEqual(video);
    const catalog = s3.json('data/catalog.json');
    expect(catalog.videos).toHaveLength(1);
    expect(catalog.videos[0]).not.toHaveProperty('description');
    expect(s3.objects.get('data/catalog.json').cacheControl).toBe('no-cache');
    expect((await call('GET', '/api/videos')).json.videos.map((v) => v.id)).toEqual([plan.id]);
  });

  test('a missing poster upload leaves the video without one', async () => {
    const { call, s3 } = setup();
    const created = (await call('POST', '/api/uploads', { body: { title: 'x', contentType: 'video/webm', size: 5, poster: true } })).json;
    const done = await call('POST', '/api/uploads/complete', { body: { id: created.id, uploadId: created.uploadId, parts: [{ partNumber: 1, etag: '"abc"' }] } });
    expect(done.json.video.poster).toBeNull();
    expect(done.json.video.src).toBe(`/v/${created.id}.webm`);
    expect(s3.objects.has('meta/index.json')).toBe(true);
  });

  test('complete needs every part, in order', async () => {
    const { call } = setup();
    const plan = (await call('POST', '/api/uploads', { body: { title: 'x', contentType: 'video/mp4', size: 40 * 1024 * 1024 } })).json;
    const send = (parts) => call('POST', '/api/uploads/complete', { body: { id: plan.id, uploadId: plan.uploadId, parts } });
    expect((await send([{ partNumber: 1, etag: '"a"' }])).statusCode).toBe(400);
    expect((await send([1, 1, 3].map((n) => ({ partNumber: n, etag: '"a"' })))).statusCode).toBe(400);
    expect((await send([1, 2, 3].map((n) => ({ partNumber: n, etag: '<bad>' })))).statusCode).toBe(400);
  });

  test('abort removes the upload, its record and its poster', async () => {
    const { call, s3 } = setup();
    const plan = (await call('POST', '/api/uploads', { body: { title: 'x', contentType: 'video/mp4', size: 10, poster: true } })).json;
    const posterKey = new URL(plan.posterUrl).pathname.slice(1);
    s3.put(posterKey, 'jpeg');
    expect((await call('POST', '/api/uploads/abort', { body: { id: plan.id, uploadId: plan.uploadId } })).statusCode).toBe(200);
    expect(s3.uploads.size).toBe(0);
    expect(s3.objects.has(`pending/${plan.id}.json`)).toBe(false);
    expect(s3.objects.has(posterKey)).toBe(false);
  });

  test('update edits details', async () => {
    const { call, s3 } = setup();
    const { video } = await upload(call, s3);
    const result = await call('POST', '/api/videos/update', { body: { id: video.id, title: 'New' } });
    expect(result.json.video).toMatchObject({ title: 'New', description: 'Line 1\nLine 2' });
    expect(s3.json(`data/videos/${video.id}.json`).title).toBe('New');
    expect(s3.json('data/catalog.json').videos[0].title).toBe('New');
    expect((await call('POST', '/api/videos/update', { body: { id: video.id, title: ' ' } })).statusCode).toBe(400);
    expect((await call('POST', '/api/videos/update', { body: { id: '2020010100', title: 'x' } })).statusCode).toBe(404);
    expect((await call('POST', '/api/videos/update', { body: { id: '../../x', title: 'x' } })).statusCode).toBe(400);
  });

  test('a new poster replaces the old one', async () => {
    const { call, s3 } = setup();
    const { video } = await upload(call, s3);
    const oldKey = video.poster.slice(1);
    const poster = (await call('POST', '/api/videos/poster', { body: { id: video.id } })).json;
    expect((await call('POST', '/api/videos/update', { body: { id: video.id, posterVersion: poster.version } })).statusCode).toBe(400);
    s3.put(new URL(poster.url).pathname.slice(1), 'new-jpeg');
    const result = await call('POST', '/api/videos/update', { body: { id: video.id, posterVersion: poster.version } });
    expect(result.json.video.poster).toBe(`/t/${video.id}-${poster.version}.jpg`);
    expect(s3.objects.has(oldKey)).toBe(false);
  });

  test('delete removes files, details and catalog entry, and invalidates the CDN', async () => {
    const { call, s3, invalidated } = setup();
    const { video } = await upload(call, s3);
    const kept = (await upload(call, s3)).video;
    expect((await call('POST', '/api/videos/delete', { body: { id: video.id } })).statusCode).toBe(200);
    expect(s3.objects.has(video.src.slice(1))).toBe(false);
    expect(s3.objects.has(video.poster.slice(1))).toBe(false);
    expect(s3.objects.has(`data/videos/${video.id}.json`)).toBe(false);
    expect(s3.json('data/catalog.json').videos.map((v) => v.id)).toEqual([kept.id]);
    expect(invalidated).toEqual([video.src, `/t/${video.id}-*`, `/data/videos/${video.id}.json`]);
    expect((await call('POST', '/api/videos/delete', { body: { id: video.id } })).statusCode).toBe(404);
  });

  test('IDs are the UK upload date plus a number for that day', async () => {
    expect(ukDate(Date.UTC(2026, 9, 27, 23, 30))).toBe('20261027'); // GMT
    expect(ukDate(Date.UTC(2026, 6, 1, 23, 30))).toBe('20260702'); // BST: already the next day in the UK
    expect(ukDate(Date.UTC(2026, 11, 31, 23, 59))).toBe('20261231');
    let clock = NOW;
    const { call, s3 } = setup({ now: () => clock });
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push((await upload(call, s3)).video.id);
    expect(ids).toEqual(['2026102700', '2026102701', '2026102702']);
    clock = Date.UTC(2026, 9, 28, 9, 0);
    expect((await upload(call, s3)).video.id).toBe('2026102800');
    expect(s3.json('data/catalog.json').videos.map((v) => v.id)).toEqual(['2026102800', '2026102702', '2026102701', '2026102700']);
  });

  test("a deleted video's number is never given out again; a cancelled upload's number is", async () => {
    const { call, s3 } = setup();
    const first = (await upload(call, s3)).video;
    const second = (await upload(call, s3)).video;
    await call('POST', '/api/videos/delete', { body: { id: second.id } });
    await call('POST', '/api/videos/delete', { body: { id: first.id } });
    expect(s3.json('meta/index.json').last).toEqual({ 20261027: 1 });
    const cancelled = (await call('POST', '/api/uploads', { body: { title: 'x', contentType: 'video/mp4', size: 10 } })).json;
    expect(cancelled.id).toBe('2026102702');
    await call('POST', '/api/uploads/abort', { body: { id: cancelled.id, uploadId: cancelled.uploadId } });
    expect((await upload(call, s3)).video.id).toBe('2026102702');
  });

  test('uploads started together get different numbers', async () => {
    const { call, s3 } = setup();
    const start = () => call('POST', '/api/uploads', { body: { title: 'x', contentType: 'video/mp4', size: 10 } });
    const plans = (await Promise.all([start(), start(), start()])).map((r) => r.json);
    expect(plans.map((p) => p.id).sort()).toEqual(['2026102700', '2026102701', '2026102702']);
    for (const plan of plans) expect(s3.json(`pending/${plan.id}.json`).uploadId).toBe(plan.uploadId);
  });

  test('at most 100 videos a day', async () => {
    const { call, s3 } = setup();
    s3.put('meta/index.json', JSON.stringify({ videos: [], last: { 20261027: 98 } }));
    expect((await call('POST', '/api/uploads', { body: { title: 'x', contentType: 'video/mp4', size: 10 } })).json.id).toBe('2026102799');
    const full = await call('POST', '/api/uploads', { body: { title: 'x', contentType: 'video/mp4', size: 10 } });
    expect(full.statusCode).toBe(400);
    expect(full.json.error).toMatch(/No video numbers left/);
  });

  test('a failed multipart start frees the number', async () => {
    const { call, s3 } = setup();
    const realSend = s3.send;
    s3.send = async (command) => {
      if (command.constructor.name === 'CreateMultipartUploadCommand') throw new Error('S3 down');
      return realSend(command);
    };
    expect((await call('POST', '/api/uploads', { body: { title: 'x', contentType: 'video/mp4', size: 10 } })).statusCode).toBe(500);
    expect([...s3.objects.keys()].filter((k) => k.startsWith('pending/'))).toEqual([]);
  });

  test('the index write retries when another request changed it first', async () => {
    const { call, s3 } = setup();
    await upload(call, s3);
    const realSend = s3.send;
    let raced = false;
    s3.send = async (command) => {
      if (!raced && command.constructor.name === 'PutObjectCommand' && command.input.Key === 'meta/index.json') {
        raced = true;
        s3.put('meta/index.json', JSON.stringify({ videos: s3.json('meta/index.json').videos }));
      }
      return realSend(command);
    };
    await upload(call, s3);
    expect(raced).toBe(true);
    expect(s3.json('meta/index.json').videos).toHaveLength(2);
  });

  test('login keeps a safe return path', async () => {
    const { call } = setup();
    const result = await call('GET', '/auth/login', { signedIn: false, query: { return: '/upload' } });
    expect(result.statusCode).toBe(302);
    expect(new URL(result.headers.location).host).toBe('login.microsoftonline.com');
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', '/a"b']) expect(auth.safeReturnPath(bad)).toBe('/');
    expect(auth.safeReturnPath('/2026102700?t=5')).toBe('/2026102700?t=5');
  });
});
