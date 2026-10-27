const crypto = require('crypto');
const auth = require('../lambda/api/auth');

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const config = { tenantId: TENANT, clientId: CLIENT, clientSecret: 'secret-value', allowedDomain: 'example.com' };
const SITE = 'https://video.dliu.com';
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', use: 'sig' };
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function idToken(claims, { kid = 'test-kid', key = privateKey } = {}) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid });
  const body = b64(claims);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${signature}`;
}

function claimsFor(nonce, overrides = {}) {
  const seconds = Math.floor(NOW / 1000);
  return {
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    tid: TENANT,
    aud: CLIENT,
    exp: seconds + 3600,
    nbf: seconds - 10,
    nonce,
    oid: 'object-id-1',
    preferred_username: 'user@example.com',
    name: 'Me',
    ...overrides,
  };
}

function fakeFetch(tokenFor) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/discovery/v2.0/keys')) return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
    if (url.endsWith('/oauth2/v2.0/token')) {
      const body = new URLSearchParams(init.body);
      return { ok: true, status: 200, json: async () => ({ id_token: tokenFor(body) }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  impl.calls = calls;
  return impl;
}

function cookieValue(cookies, name) {
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match && match.slice(name.length + 1).split(';')[0];
}

function beginLogin() {
  const login = auth.startLogin(config, SITE, NOW);
  const url = new URL(login.location);
  const transient = cookieValue(login.cookies, auth.AUTH_COOKIE);
  const payload = auth.verifySigned(transient, auth.sessionKey(config), NOW);
  return { url, transient, payload };
}

describe('signed tokens', () => {
  const key = auth.sessionKey(config);

  test('round trip', () => {
    const token = auth.sign({ user: 'me', exp: NOW / 1000 + 60 }, key);
    expect(auth.verifySigned(token, key, NOW).user).toBe('me');
  });

  test('rejects tampering, expiry and wrong key', () => {
    const token = auth.sign({ user: 'me', exp: NOW / 1000 + 60 }, key);
    const [body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ user: 'admin', exp: NOW / 1000 + 60 })).toString('base64url');
    expect(auth.verifySigned(`${forged}.${mac}`, key, NOW)).toBeNull();
    expect(auth.verifySigned(`${body}.${mac}x`, key, NOW)).toBeNull();
    expect(auth.verifySigned(token, key, NOW + 61000)).toBeNull();
    expect(auth.verifySigned(token, auth.sessionKey({ clientSecret: 'other' }), NOW)).toBeNull();
    expect(auth.verifySigned(undefined, key, NOW)).toBeNull();
  });
});

describe('cookie parsing', () => {
  test('reads function URL cookies array and header', () => {
    expect(auth.parseCookies({ cookies: ['a=1', 'b=x=y'] })).toEqual({ a: '1', b: 'x=y' });
    expect(auth.parseCookies({ headers: { cookie: 'a=1; c=3' } })).toEqual({ a: '1', c: '3' });
  });
});

describe('login flow', () => {
  test('startLogin builds an Entra PKCE request', () => {
    const { url, payload } = beginLogin();
    expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT);
    expect(url.searchParams.get('redirect_uri')).toBe(`${SITE}/auth/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(payload.state);
    expect(url.searchParams.get('nonce')).toBe(payload.nonce);
    const challenge = crypto.createHash('sha256').update(payload.verifier).digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
  });

  test('finishLogin issues a session for an allowed user', async () => {
    const { transient, payload } = beginLogin();
    const fetchImpl = fakeFetch((body) => {
      expect(body.get('code_verifier')).toBe(payload.verifier);
      expect(body.get('client_secret')).toBe('secret-value');
      return idToken(claimsFor(payload.nonce));
    });
    const result = await auth.finishLogin({
      queryStringParameters: { code: 'the-code', state: payload.state },
      cookies: [`${auth.AUTH_COOKIE}=${transient}`],
    }, config, SITE, { fetchImpl, now: NOW });
    expect(result.location).toBe('/');
    const session = cookieValue(result.cookies, auth.SESSION_COOKIE);
    const event = { cookies: [`${auth.SESSION_COOKIE}=${session}`] };
    expect(auth.getSession(event, config, NOW).user).toBe('user@example.com');
    expect(result.cookies.find((c) => c.startsWith(auth.SESSION_COOKIE))).toMatch(/HttpOnly; SameSite=Lax/);
  });

  test('finishLogin rejects users from another domain', async () => {
    const { transient, payload } = beginLogin();
    const fetchImpl = fakeFetch(() => idToken(claimsFor(payload.nonce, { preferred_username: 'other@example.org', oid: 'x' })));
    const result = await auth.finishLogin({
      queryStringParameters: { code: 'c', state: payload.state },
      cookies: [`${auth.AUTH_COOKIE}=${transient}`],
    }, config, SITE, { fetchImpl, now: NOW });
    expect(result.status).toBe(403);
    expect(cookieValue(result.cookies, auth.SESSION_COOKIE)).toBeUndefined();
  });

  test('finishLogin rejects a state mismatch or missing transient cookie', async () => {
    const { transient } = beginLogin();
    const fetchImpl = fakeFetch(() => { throw new Error('should not exchange'); });
    const mismatch = await auth.finishLogin({ queryStringParameters: { code: 'c', state: 'other' }, cookies: [`${auth.AUTH_COOKIE}=${transient}`] }, config, SITE, { fetchImpl, now: NOW });
    expect(mismatch.status).toBe(400);
    const missing = await auth.finishLogin({ queryStringParameters: { code: 'c', state: 'x' } }, config, SITE, { fetchImpl, now: NOW });
    expect(missing.status).toBe(400);
  });

  test('finishLogin surfaces Entra errors', async () => {
    const result = await auth.finishLogin({ queryStringParameters: { error: 'access_denied' } }, config, SITE, { now: NOW });
    expect(result.status).toBe(401);
    expect(result.error).toBe('Sign-in failed: access_denied');
  });

  test('finishLogin does not echo arbitrary error text', async () => {
    const result = await auth.finishLogin({ queryStringParameters: { error: 'Your account is locked, call +1 555' } }, config, SITE, { now: NOW });
    expect(result.error).toBe('Sign-in failed: unknown_error');
  });
});

describe('id_token validation', () => {
  const fetchImpl = fakeFetch(() => '');

  test.each([
    ['issuer', { iss: 'https://login.microsoftonline.com/common/v2.0' }, /issuer/],
    ['tenant', { tid: 'other' }, /tenant/],
    ['audience', { aud: 'other' }, /audience/],
    ['expiry', { exp: Math.floor(NOW / 1000) - 3600 }, /Expired/],
    ['not before', { nbf: Math.floor(NOW / 1000) + 3600 }, /not yet valid/],
    ['nonce', { nonce: 'other' }, /Nonce/],
  ])('rejects bad %s', async (_label, overrides, message) => {
    await expect(auth.verifyIdToken(idToken(claimsFor('n', overrides)), config, 'n', { fetchImpl, now: NOW })).rejects.toThrow(message);
  });

  test('rejects a forged signature', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await expect(auth.verifyIdToken(idToken(claimsFor('n'), { key: other }), config, 'n', { fetchImpl, now: NOW })).rejects.toThrow(/signature/);
  });

  test('rejects unknown key ids and alg none', async () => {
    await expect(auth.verifyIdToken(idToken(claimsFor('n'), { kid: 'nope' }), config, 'n', { fetchImpl, now: NOW })).rejects.toThrow(/Unknown signing key/);
    const none = `${b64({ alg: 'none', kid: 'test-kid' })}.${b64(claimsFor('n'))}.`;
    await expect(auth.verifyIdToken(none, config, 'n', { fetchImpl, now: NOW })).rejects.toThrow(/algorithm/);
  });

  test('accepts a valid token', async () => {
    const claims = await auth.verifyIdToken(idToken(claimsFor('n')), config, 'n', { fetchImpl, now: NOW });
    expect(claims.preferred_username).toBe('user@example.com');
  });
});

describe('domain check', () => {
  test('allows any account in the domain, case-insensitively', () => {
    expect(auth.isAllowed({ preferred_username: 'User@EXAMPLE.com' }, config)).toBe(true);
    expect(auth.isAllowed({ email: 'someone@example.com' }, config)).toBe(true);
    expect(auth.isAllowed({ preferred_username: 'other@example.org' }, config)).toBe(false);
    expect(auth.isAllowed({ preferred_username: 'evil@notexample.com' }, config)).toBe(false);
    expect(auth.isAllowed({ preferred_username: 'x@example.com.evil.org' }, config)).toBe(false);
    expect(auth.isAllowed({ oid: 'abc' }, config)).toBe(false);
  });
});
