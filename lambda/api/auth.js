'use strict';

const crypto = require('crypto');

const SESSION_COOKIE = '__Host-video_session';
const AUTH_COOKIE = '__Host-video_auth';
// Readable by page scripts: tells them to show the owner controls. It grants nothing; the API checks the session.
const OWNER_HINT_COOKIE = 'video_owner';
const SESSION_SECONDS = 12 * 60 * 60;
const AUTH_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 120;
const JWKS_TTL_MS = 60 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');
const nowSeconds = (now) => Math.floor(now / 1000);

function sessionKey(config) {
  return crypto.createHmac('sha256', config.clientSecret).update('video-session-v1').digest();
}

function sign(payload, key) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', key).update(body).digest());
  return `${body}.${mac}`;
}

function verifySigned(token, key, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = crypto.createHmac('sha256', key).update(body).digest();
  const given = fromB64url(mac);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp <= nowSeconds(now)) return null;
  return payload;
}

function parseCookies(event) {
  const list = Array.isArray(event.cookies) ? event.cookies : [];
  const header = event.headers && (event.headers.cookie || event.headers.Cookie);
  const parts = header ? list.concat(header.split(';')) : list;
  const cookies = {};
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!(name in cookies)) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}

function cookie(name, value, maxAge, { httpOnly = true } = {}) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure;${httpOnly ? ' HttpOnly;' : ''} SameSite=Lax`;
}

// Only same-site relative paths, so the sign-in cannot be used as an open redirect.
function safeReturnPath(value) {
  return typeof value === 'string' && /^\/(?![\/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%\/?]{0,500}$/.test(value) ? value : '/';
}

function authority(config) {
  return `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}`;
}

function getSession(event, config, now = Date.now()) {
  return verifySigned(parseCookies(event)[SESSION_COOKIE], sessionKey(config), now);
}

function startLogin(config, siteUrl, now = Date.now(), returnTo = '/') {
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const transient = sign({ state, nonce, verifier, returnTo: safeReturnPath(returnTo), exp: nowSeconds(now) + AUTH_SECONDS }, sessionKey(config));
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: `${siteUrl}/auth/callback`,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return {
    location: `${authority(config)}/oauth2/v2.0/authorize?${params}`,
    cookies: [cookie(AUTH_COOKIE, transient, AUTH_SECONDS)],
  };
}

const jwksCache = new Map();

async function getSigningKey(config, kid, fetchImpl, now) {
  const url = `${authority(config)}/discovery/v2.0/keys`;
  let entry = jwksCache.get(url);
  const find = () => entry && entry.keys.find((key) => key.kid === kid);
  if (!entry || now - entry.at > JWKS_TTL_MS || !find()) {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`JWKS request failed with ${response.status}`);
    entry = { at: now, keys: (await response.json()).keys || [] };
    jwksCache.set(url, entry);
  }
  const jwk = find();
  if (!jwk) throw new Error('Unknown signing key');
  return crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
}

async function verifyIdToken(idToken, config, expectedNonce, { fetchImpl = fetch, now = Date.now() } = {}) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');
  const header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unsupported id_token algorithm');
  const key = await getSigningKey(config, header.kid, fetchImpl, now);
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, fromB64url(parts[2]));
  if (!valid) throw new Error('Invalid id_token signature');

  const claims = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  const seconds = nowSeconds(now);
  if (claims.iss !== `https://login.microsoftonline.com/${config.tenantId}/v2.0`) throw new Error('Unexpected issuer');
  if (claims.tid !== config.tenantId) throw new Error('Unexpected tenant');
  if (claims.aud !== config.clientId) throw new Error('Unexpected audience');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < seconds) throw new Error('Expired id_token');
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > seconds) throw new Error('id_token not yet valid');
  if (claims.nonce !== expectedNonce) throw new Error('Nonce mismatch');
  return claims;
}

// Microsoft decides who may sign in (Entra user assignment); the app also checks the email domain.
function isAllowed(claims, config) {
  const suffix = `@${config.allowedDomain}`;
  return [claims.preferred_username, claims.email, claims.upn]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().endsWith(suffix));
}

async function finishLogin(event, config, siteUrl, { fetchImpl = fetch, now = Date.now() } = {}) {
  const query = event.queryStringParameters || {};
  const clearAuth = cookie(AUTH_COOKIE, '', 0);
  // Only show well-formed OAuth error codes, so the page cannot be used to display attacker text.
  if (query.error) {
    const code = /^[a-z_]{1,64}$/.test(query.error) ? query.error : 'unknown_error';
    return { error: `Sign-in failed: ${code}`, status: 401, cookies: [clearAuth] };
  }

  const transient = verifySigned(parseCookies(event)[AUTH_COOKIE], sessionKey(config), now);
  if (!transient || !query.state || query.state !== transient.state || !query.code) {
    return { error: 'Sign-in expired or invalid. Please try again.', status: 400, cookies: [clearAuth] };
  }

  const tokenResponse = await fetchImpl(`${authority(config)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: `${siteUrl}/auth/callback`,
      code_verifier: transient.verifier,
      scope: 'openid profile email',
    }).toString(),
  });
  const tokens = await tokenResponse.json();
  if (!tokenResponse.ok || !tokens.id_token) {
    console.warn(JSON.stringify({ message: 'Token exchange failed', status: tokenResponse.status, error: tokens.error }));
    return { error: 'Sign-in failed during token exchange.', status: 401, cookies: [clearAuth] };
  }

  const claims = await verifyIdToken(tokens.id_token, config, transient.nonce, { fetchImpl, now });
  if (!isAllowed(claims, config)) {
    console.warn(JSON.stringify({ message: 'User domain not allowed', user: claims.preferred_username, oid: claims.oid }));
    return { error: `${claims.preferred_username || 'This account'} is not allowed to manage videos.`, status: 403, cookies: [clearAuth] };
  }

  const session = sign({
    user: claims.preferred_username || claims.email || claims.oid,
    name: claims.name,
    oid: claims.oid,
    exp: nowSeconds(now) + SESSION_SECONDS,
  }, sessionKey(config));
  return {
    location: safeReturnPath(transient.returnTo),
    cookies: [clearAuth, cookie(SESSION_COOKIE, session, SESSION_SECONDS), cookie(OWNER_HINT_COOKIE, '1', SESSION_SECONDS, { httpOnly: false })],
  };
}

function logoutCookies() {
  return [cookie(SESSION_COOKIE, '', 0), cookie(AUTH_COOKIE, '', 0), cookie(OWNER_HINT_COOKIE, '', 0, { httpOnly: false })];
}

module.exports = {
  SESSION_COOKIE,
  AUTH_COOKIE,
  OWNER_HINT_COOKIE,
  finishLogin,
  getSession,
  isAllowed,
  logoutCookies,
  parseCookies,
  safeReturnPath,
  sessionKey,
  sign,
  startLogin,
  verifyIdToken,
  verifySigned,
};
