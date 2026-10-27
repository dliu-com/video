#!/usr/bin/env node
// End-to-end test against the deployed site: upload (multipart, straight to S3), publish, serve,
// edit, embed and delete a throwaway video. It signs a short-lived owner session with
// the session key derived from the Entra client secret in SSM, so it needs AWS credentials.
// Usage: node scripts/smoke-test.js [--keep]
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const auth = require('../lambda/api/auth');

const SITE = process.env.SITE_URL || 'https://video.dliu.com';
const REGION = process.env.AWS_REGION || 'eu-west-1';
const PREFIX = process.env.PARAMETER_PREFIX || '/video';
const keep = process.argv.includes('--keep');

const param = (name) => execFileSync('aws', ['ssm', 'get-parameter', '--region', REGION, '--name', `${PREFIX}/${name}`,
  '--with-decryption', '--query', 'Parameter.Value', '--output', 'text']).toString().trim();
const config = { tenantId: param('entra-tenant-id'), clientId: param('entra-client-id'), clientSecret: param('entra-client-secret') };
const session = auth.sign({ user: `smoke-test@${new URL(SITE).hostname}`, name: 'Smoke test', exp: Math.floor(Date.now() / 1000) + 600 }, auth.sessionKey(config));
const cookie = `${auth.SESSION_COOKIE}=${session}`;

function check(condition, message) {
  if (!condition) throw new Error(`not ok - ${message}`);
  console.log(`ok - ${message}`);
}

async function api(path, body) {
  const text = JSON.stringify(body);
  const response = await fetch(SITE + path, {
    method: 'POST',
    headers: { cookie, origin: SITE, 'content-type': 'application/json', 'x-amz-content-sha256': crypto.createHash('sha256').update(text).digest('hex') },
    body: text,
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${json.error || ''}`);
  return json;
}

async function main() {
  check((await (await fetch(`${SITE}/api/me`, { headers: { cookie } })).json()).user, 'owner session accepted');

  // S3 doesn't look inside the file, so random bytes are enough to exercise two upload parts.
  const file = crypto.randomBytes(20 * 1024 * 1024);
  const plan = await api('/api/uploads', {
    title: 'Smoke test', description: 'Automated end-to-end test', contentType: 'video/mp4',
    size: file.length, duration: 12, width: 1280, height: 720, poster: true,
  });
  check(plan.partCount === 2, `upload planned as ${plan.partCount} parts`);
  try {
    const preflight = await fetch(plan.posterUrl, { method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' } });
    check(preflight.headers.get('access-control-allow-origin') === SITE, 'S3 CORS allows uploads from the site');
    check((await fetch(plan.posterUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: crypto.randomBytes(2048) })).ok, 'poster uploaded to S3');

    const { urls } = await api('/api/uploads/parts', { id: plan.id, uploadId: plan.uploadId, parts: [1, 2] });
    const parts = [];
    for (const n of [1, 2]) {
      const response = await fetch(urls[n], { method: 'PUT', body: file.subarray((n - 1) * plan.partSize, n * plan.partSize) });
      check(response.ok && response.headers.get('etag'), `part ${n} uploaded to S3`);
      parts.push({ partNumber: n, etag: response.headers.get('etag') });
    }
    var { video } = await api('/api/uploads/complete', { id: plan.id, uploadId: plan.uploadId, parts });
  } catch (error) {
    await api('/api/uploads/abort', { id: plan.id, uploadId: plan.uploadId }).catch(() => {});
    throw error;
  }
  check(video.size === file.length, `published ${video.id}`);

  try {
    const range = await fetch(SITE + video.src, { headers: { range: 'bytes=100-199' } });
    const bytes = Buffer.from(await range.arrayBuffer());
    check(range.status === 206 && bytes.equals(file.subarray(100, 200)), 'video served with byte ranges');
    check((await fetch(SITE + video.poster)).headers.get('content-type') === 'image/jpeg', 'poster served');
    check((await (await fetch(`${SITE}/data/videos/${video.id}.json`)).json()).title === 'Smoke test', 'details published');
    check((await (await fetch(`${SITE}/data/catalog.json`)).json()).videos.some((v) => v.id === video.id), 'video listed in the catalog');
    const embed = await fetch(`${SITE}/embed/${video.id}`);
    check(embed.ok && /frame-ancestors 'self' /.test(embed.headers.get('content-security-policy')), 'embed page can be framed');
    await api('/api/videos/update', { id: video.id, title: 'Smoke test (edited)' });
    check((await (await fetch(`${SITE}/data/videos/${video.id}.json`)).json()).title === 'Smoke test (edited)', 'edit published');
  } finally {
    if (keep) {
      console.log(`kept ${SITE}/${video.id}`);
    } else {
      await api('/api/videos/delete', { id: video.id });
      check((await fetch(`${SITE}/data/videos/${video.id}.json`)).status !== 200, 'deleted');
    }
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
