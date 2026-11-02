const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readConfig, readAccessToken, createClient } = require('../scripts/api-client');

const env = { VIDEO_API_URL: 'https://example.execute-api.eu-west-1.amazonaws.com' };
const retiredNativeIds = { VIDEO_API_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  VIDEO_API_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
  VIDEO_API_AUDIENCE: '33333333-3333-4333-8333-333333333333',
  VIDEO_API_SCOPES: 'video.read video.write video.delete' };

function setup(config = readConfig({ ...env, VIDEO_API_ACCESS_TOKEN: 'copied-test-token' })) {
  const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  return { fetchImpl, client: createClient(config, { fetchImpl }) };
}

test('requires an HTTPS API origin', () => {
  expect(() => readConfig({ ...env, VIDEO_API_URL: '' })).toThrow();
  for (const url of ['http://example.com', 'https://example.com/path', 'https://user:pass@example.com',
    'https://example.com?query=x', 'https://example.com/#fragment']) {
    expect(() => readConfig({ ...env, VIDEO_API_URL: url })).toThrow();
  }
});

test('has no native Microsoft sign-in: retired client IDs are ignored and only auth.dliu.com tokens are used', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/api-client.js'), 'utf8');
  expect(source).not.toMatch(/msal|PublicClientApplication|acquireToken|login\.microsoftonline\.com/i);
  const home = '/tmp/video-no-native-home';
  expect(readConfig({ ...env, ...retiredNativeIds, HOME: home }))
    .toEqual({ endpoint: env.VIDEO_API_URL, credentialFile: path.join(home, '.dliu_token') });
  expect(readConfig({ ...env, ...retiredNativeIds, VIDEO_API_ACCESS_TOKEN: 'copied-test-token' }))
    .toEqual({ endpoint: env.VIDEO_API_URL, accessToken: 'copied-test-token' });
});

test('never sends tokens to arbitrary paths or follows redirects; API failures are explicit', async () => {
  const { fetchImpl, client } = setup();
  for (const path of ['https://evil.example/api/me', '//evil.example/api/me', '/auth/login', '/api/../auth/login']) {
    await expect(client.request('GET', path)).rejects.toThrow('Unknown Video API');
  }
  expect(fetchImpl).not.toHaveBeenCalled();
  fetchImpl.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) });
  await expect(client.request('POST', '/api/videos/delete', { id: '2026103100' })).rejects.toThrow('403: Forbidden');
});

test('a copied console token needs only the managed API origin', async () => {
  const config = readConfig({ VIDEO_API_URL: env.VIDEO_API_URL, VIDEO_API_ACCESS_TOKEN: 'copied-test-token' });
  expect(config).toEqual({ endpoint: env.VIDEO_API_URL, accessToken: 'copied-test-token' });
  const { fetchImpl, client } = setup(config);
  await client.request('GET', '/api/me');
  await client.request('POST', '/api/videos/update', { id: '2026103100', title: 'Updated title' });
  expect(fetchImpl.mock.calls).toEqual([
    [`${env.VIDEO_API_URL}/api/me`, { method: 'GET', redirect: 'error',
      headers: { authorization: 'Bearer copied-test-token' } }],
    [`${env.VIDEO_API_URL}/api/videos/update`, { method: 'POST', redirect: 'error',
      headers: { authorization: 'Bearer copied-test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ id: '2026103100', title: 'Updated title' }) }],
  ]);
});

test('invalid copied tokens fail explicitly', () => {
  for (const token of ['', ' ', 'Bearer copied-test-token', 'test\ntoken', 'test\rtoken', 'test\0token', null]) {
    expect(() => readConfig({ ...env, VIDEO_API_ACCESS_TOKEN: token })).toThrow('VIDEO_API_ACCESS_TOKEN');
  }
  expect(() => readConfig({ ...env, VIDEO_API_URL: 'http://example.com',
    VIDEO_API_ACCESS_TOKEN: 'copied-test-token' })).toThrow('HTTPS API origin');
});

test('copied-token expiry and permission failures never fall back to website cookies', async () => {
  const { fetchImpl, client } = setup();
  for (const status of [401, 403]) {
    fetchImpl.mockResolvedValueOnce({ ok: false, status, json: async () => ({ error: 'Denied' }) });
    await expect(client.request('GET', '/api/videos')).rejects.toThrow(`${status}: Denied`);
  }
  await expect(client.request('GET', '/auth/login')).rejects.toThrow('Unknown Video API');
  await expect(client.request('GET', 'https://other.example/api/me')).rejects.toThrow('Unknown Video API');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  for (const [, request] of fetchImpl.mock.calls) {
    expect(request.redirect).toBe('error');
    expect(request.headers).toEqual({ authorization: 'Bearer copied-test-token' });
  }
});

describe('saved console credentials', () => {
  const now = Date.UTC(2026, 10, 1, 12);
  const jwt = (claims = { exp: now / 1000 + 3600 }) => [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-signature',
  ].join('.');
  let home;
  let file;
  let savedEnv;
  const contents = (token = jwt(), expiry = new Date(now + 3600000).toISOString()) =>
    `token=${token}\nexpires_at=${expiry}\n`;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'video-credential-test-'));
    file = path.join(home, '.dliu_token');
    savedEnv = { HOME: home, VIDEO_API_URL: env.VIDEO_API_URL };
  });
  afterEach(() => { fs.rmSync(home, { recursive: true }); });

  test('defaults to an isolated home file and never creates credentials or reads them during configuration', () => {
    const config = readConfig(savedEnv);
    expect(config).toEqual({ endpoint: env.VIDEO_API_URL, credentialFile: file });
    expect(() => readAccessToken(config, now)).toThrow('Cannot read credential file (ENOENT)');
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, contents(), { mode: 0o600 });
    expect(readAccessToken(config, now)).toBe(jwt());
    expect(fs.readFileSync(file, 'utf8')).toBe(contents());
    fs.writeFileSync(file, contents().replace(/\n/g, '\r\n'));
    expect(readAccessToken(config, now)).toBe(jwt());
  });

  test('explicit environment tokens and file destinations take precedence without accessing a default file', () => {
    fs.writeFileSync(file, 'malformed credentials');
    const override = readConfig({ ...savedEnv, VIDEO_API_ACCESS_TOKEN: 'override-test-token',
      VIDEO_API_TOKEN_FILE: '' });
    expect(readAccessToken(override, now)).toBe('override-test-token');
    const alternate = path.join(home, 'chosen-token');
    fs.writeFileSync(alternate, contents());
    const selected = readConfig({ ...env, ...savedEnv, VIDEO_API_TOKEN_FILE: alternate });
    expect(selected).toEqual({ endpoint: env.VIDEO_API_URL, credentialFile: alternate });
    expect(readAccessToken(selected, now)).toBe(jwt());
    for (const value of ['', '.dliu_token', '~/.dliu_token', 'bad\0path', null]) {
      expect(() => readConfig({ ...savedEnv, VIDEO_API_TOKEN_FILE: value })).toThrow('absolute credential-file path');
    }
    expect(readConfig({ ...savedEnv, ...retiredNativeIds })).toEqual({ endpoint: env.VIDEO_API_URL, credentialFile: file });
    expect(fs.readFileSync(file, 'utf8')).toBe('malformed credentials');
  });

  test('rejects raw legacy JWTs and malformed records without exposing their contents', () => {
    for (const value of [
      '', jwt(), `token=${jwt()}`, `expires_at=${new Date(now + 3600000).toISOString()}`,
      contents() + 'token=secret-marker\n', contents() + 'unknown=secret-marker\n',
      contents(''), contents('not-a-jwt'), contents('abc.!.signature'),
      contents(`abc.${jwt().split('.')[1]}.signature`),
      contents(`${Buffer.from('null').toString('base64url')}.${jwt().split('.')[1]}.signature`),
      contents(jwt(null)), contents(jwt({})), contents(jwt({ exp: 'soon' })),
      contents(jwt({ exp: 1.5 })), contents(jwt({ exp: Number.MAX_SAFE_INTEGER })),
      contents(jwt(), 'tomorrow'), contents(jwt(), '2026-11-01T13:00:00+00:00'),
      contents(jwt(), '2026-02-30T13:00:00Z'), contents(jwt(), '2026-11-01T25:00:00Z'),
      contents() + ' \n', contents(jwt() + '\0'),
    ]) {
      fs.writeFileSync(file, value);
      let error;
      try { readAccessToken(readConfig(savedEnv), now); } catch (failure) { error = failure; }
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/Credential file/);
      expect(error.message).not.toContain(jwt());
      expect(error.message).not.toContain('secret-marker');
      expect(fs.readFileSync(file, 'utf8')).toBe(value);
    }
  });

  test('both saved expiry and JWT exp are checked, including the exact expiration boundary', () => {
    for (const [token, expiry] of [
      [jwt(), new Date(now).toISOString()],
      [jwt(), new Date(now - 1).toISOString()],
      [jwt({ exp: now / 1000 }), new Date(now + 3600000).toISOString()],
      [jwt({ exp: now / 1000 - 1 }), new Date(now + 3600000).toISOString()],
    ]) {
      fs.writeFileSync(file, contents(token, expiry));
      expect(() => readAccessToken(readConfig(savedEnv), now)).toThrow('has expired');
    }
    fs.writeFileSync(file, contents(jwt(), '2026-11-01T13:00:00Z'));
    expect(readAccessToken(readConfig(savedEnv), now)).toBe(jwt());
  });

  test('each request rereads the saved file, checks expiry and never falls back to cookies', async () => {
    let clock = now;
    fs.writeFileSync(file, contents());
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    const client = createClient(readConfig(savedEnv), { fetchImpl, now: () => clock });
    await client.request('GET', '/api/videos');
    const renewed = jwt({ exp: now / 1000 + 7200 });
    fs.writeFileSync(file, contents(renewed, new Date(now + 7200000).toISOString()));
    await client.request('GET', '/api/me');
    expect(fetchImpl.mock.calls.map(([, request]) => request.headers.authorization)).toEqual([
      `Bearer ${jwt()}`, `Bearer ${renewed}`,
    ]);
    clock += 7200000;
    await expect(client.request('GET', '/api/videos')).rejects.toThrow('has expired');
    fs.writeFileSync(file, 'invalid file');
    await expect(client.request('GET', '/api/videos')).rejects.toThrow('Credential file');
    fs.unlinkSync(file);
    await expect(client.request('GET', '/api/videos')).rejects.toThrow('Cannot read credential file');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('the executable CLI reports missing or malformed credentials without printing tokens or making requests', () => {
    for (const value of [undefined, contents() + 'unknown=secret-marker\n']) {
      if (value !== undefined) fs.writeFileSync(file, value);
      const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/api-client.js'), 'GET', '/api/me'],
        { env: savedEnv, encoding: 'utf8', timeout: 10000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('auth.dliu.com');
      expect(result.stderr).not.toContain(jwt());
      expect(result.stderr).not.toContain('secret-marker');
    }
  });
});
