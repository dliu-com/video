const auth = require('../lambda/api/auth');
const { authorize } = require('../lambda/api/api-access');
const { createHandler } = require('../lambda/api/index');
const { createFakeS3 } = require('./fake-s3');

const NOW = Date.UTC(2026, 9, 31, 12);
const TENANT = '11111111-1111-4111-8111-111111111111';
const AUDIENCE = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const config = { tenantId: 'legacy', clientId: 'legacy', clientSecret: 'secret' };
const originalEnv = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, { API_GATEWAY_ID: 'test-api', API_TENANT_ID: TENANT, API_AUDIENCE: AUDIENCE,
    API_CLIENT_ID: CLIENT, SITE_URL: 'https://video.dliu.com', VIDEO_BUCKET: 'test-bucket',
    AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret' });
});
afterEach(() => { process.env = { ...originalEnv }; });

function event(method = 'GET', path = '/api/videos', scopes = ['video.read']) {
  return {
    rawPath: path,
    headers: {},
    requestContext: {
      apiId: 'test-api', routeKey: `${method} ${path}`, http: { method },
      authorizer: { jwt: { scopes, claims: { ver: '2.0', tid: TENANT, aud: AUDIENCE,
        iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, azp: CLIENT,
        oid: 'assigned-user', sub: 'subject', roles: ['api.access'], name: 'Test user' } } },
    },
  };
}

test('only the configured gateway and Microsoft v2 resource are trusted', () => {
  expect(authorize(event(), 'video.read')).toEqual({ user: 'assigned-user', name: 'Test user' });
  for (const claim of ['ver', 'tid', 'aud', 'iss', 'oid', 'sub']) {
    const request = event();
    delete request.requestContext.authorizer.jwt.claims[claim];
    expect(authorize(request, 'video.read').status).toBe(401);
  }
  const request = event();
  request.requestContext.apiId = 'other-api';
  expect(authorize(request, 'video.read').status).toBe(401);
  delete request.requestContext.authorizer;
  expect(authorize(request, 'video.read').status).toBe(401);
  delete request.requestContext;
  expect(authorize(request, 'video.read').status).toBe(401);
});

test('client permission, user assignment and exact route scope are all required', () => {
  for (const change of [
    (jwt) => { jwt.claims.azp = 'other-client'; },
    (jwt) => { jwt.claims.roles = ['other.access']; },
    (jwt) => { delete jwt.claims.roles; },
    (jwt) => { jwt.claims.roles = '["other,api.access"]'; },
    (jwt) => { jwt.claims.roles = '[broken'; },
    (jwt) => { jwt.claims.roles = '[]'; },
    (jwt) => { jwt.claims.roles = '[other.access]'; },
    (jwt) => { jwt.claims.roles = '[api.access.admin]'; },
    (jwt) => { jwt.claims.roles = '[xapi.access]'; },
    (jwt) => { jwt.claims.roles = '[other,api.access]'; },
    (jwt) => { jwt.claims.roles = '[other  api.access]'; },
    (jwt) => { jwt.claims.roles = '[other\tapi.access]'; },
    (jwt) => { jwt.claims.roles = '["api.access" other]'; },
    (jwt) => { jwt.claims.roles = '[api.access'; },
    (jwt) => { jwt.claims.roles = 'api.access]'; },
    (jwt) => { jwt.claims.roles = 'other api.access'; },
    (jwt) => { jwt.claims.roles = 'api.access.admin'; },
    (jwt) => { jwt.claims.roles = '{"0":"api.access"}'; },
    (jwt) => { jwt.claims.roles = '[1]'; },
    (jwt) => { jwt.claims.roles = [['api.access']]; },
    (jwt) => { jwt.claims.roles = { 0: 'api.access', length: 1 }; },
    (jwt) => { jwt.claims.roles = '[api.access]'; jwt.claims.azp = 'other-client'; },
    (jwt) => { jwt.claims.roles = '[api.access]'; jwt.scopes = ['video.write']; },
    (jwt) => { jwt.scopes = ['video.write']; },
    (jwt) => { jwt.scopes = 'video.read'; },
  ]) {
    const request = event();
    change(request.requestContext.authorizer.jwt);
    expect(authorize(request, 'video.read').status).toBe(403);
  }
  for (const roles of ['api.access', '["api.access"]', '[api.access]', '[other.access api.access]']) {
    const request = event();
    request.requestContext.authorizer.jwt.claims.roles = roles;
    expect(authorize(request, 'video.read').user).toBe('assigned-user');
  }
  delete process.env.API_CLIENT_ID;
  expect(authorize(event(), 'video.read').status).toBe(401);
});

test('roles arrive from API Gateway as a bracketed, space-separated string and are matched exactly', () => {
  const { parseRoles } = require('../lambda/api/api-access');
  expect(parseRoles('[api.access]')).toEqual(['api.access']);
  expect(parseRoles('[a.b api.access c-d]')).toEqual(['a.b', 'api.access', 'c-d']);
  expect(parseRoles('[]')).toEqual([]);
  expect(parseRoles(['api.access'])).toEqual(['api.access']);
  expect(parseRoles('["api.access"]')).toEqual(['api.access']);
  for (const bad of [undefined, null, 1, '', ' ', '[ api.access]', '[api.access ]', '[a  b]', '[a\nb]', '["a"', '[1]x', 'a b', '"api.access"', [1], {}]) {
    expect(parseRoles(bad)).toBeNull();
  }
  const request = event();
  request.requestContext.authorizer.jwt.claims.roles = '[api.access]';
  delete request.requestContext.authorizer.jwt.claims.ver;
  expect(authorize(request, 'video.read').status).toBe(401);
});

test('a shared SPA client and resource ID still require exact gateway, audience, client, role and scope', () => {
  process.env.API_CLIENT_ID = AUDIENCE;
  const sharedEvent = () => {
    const request = event();
    request.requestContext.authorizer.jwt.claims.azp = AUDIENCE;
    return request;
  };
  expect(authorize(sharedEvent(), 'video.read')).toEqual({ user: 'assigned-user', name: 'Test user' });
  for (const [change, status] of [
    [(request) => { request.requestContext.apiId = 'other-api'; }, 401],
    [(request) => { request.requestContext.authorizer.jwt.claims.aud = CLIENT; }, 401],
    [(request) => { request.requestContext.authorizer.jwt.claims.azp = CLIENT; }, 403],
    [(request) => { delete request.requestContext.authorizer.jwt.claims.roles; }, 403],
    [(request) => { delete request.requestContext.authorizer.jwt.claims.oid; }, 401],
    [(request) => { request.requestContext.authorizer.jwt.scopes = ['video.write']; }, 403],
    [(request) => { request.requestContext.authorizer.jwt.scopes = ['.default']; }, 403],
  ]) {
    const request = sharedEvent();
    change(request);
    expect(authorize(request, 'video.read').status).toBe(status);
  }
  expect(authorize(sharedEvent(), 'video.delete').status).toBe(403);
});

test('managed requests never load browser credentials or accept cookies as fallback', async () => {
  const loadConfig = jest.fn(() => { throw new Error('Must not load a browser secret'); });
  const handler = createHandler({ loadConfig, s3: createFakeS3(), now: () => NOW });
  const request = event('GET', '/api/me');
  expect(JSON.parse((await handler(request)).body).user).toBe('assigned-user');
  request.requestContext.authorizer.jwt.scopes = [];
  request.cookies = [`${auth.SESSION_COOKIE}=${auth.sign({ typ: 'session', user: 'owner@example.com', exp: NOW / 1000 + 300 }, auth.sessionKey(config))}`];
  const denied = await handler(request);
  expect(denied.statusCode).toBe(403);
  expect(denied.cookies).toBeUndefined();
  delete request.requestContext.authorizer;
  expect((await handler(request)).statusCode).toBe(401);
  expect(loadConfig).not.toHaveBeenCalled();
});

test('warm managed invocations do not retain bearer tokens, reuse an identity, persist credentials or log headers', async () => {
  const loadConfig = jest.fn(() => { throw new Error('Must not load browser credentials'); });
  const s3 = createFakeS3();
  const handler = createHandler({ loadConfig, s3, now: () => NOW });
  const logs = ['error', 'warn', 'log'].map((name) => jest.spyOn(console, name).mockImplementation(() => {}));
  const marker = 'synthetic-bearer-retention-marker';
  let headerReads = 0;
  const request = (path = '/api/me') => {
    const value = event('GET', path);
    Object.defineProperty(value.headers, 'authorization', {
      enumerable: true, get() { headerReads += 1; return `Bearer ${marker}`; },
    });
    return value;
  };
  try {
    const first = await handler(request());
    expect(JSON.parse(first.body).user).toBe('assigned-user');
    const another = request();
    another.requestContext.authorizer.jwt.claims.oid = 'another-user';
    expect(JSON.parse((await handler(another)).body).user).toBe('another-user');
    const unsigned = request();
    delete unsigned.requestContext.authorizer;
    const denied = await handler(unsigned);
    expect(denied.statusCode).toBe(401);
    s3.send = jest.fn(async () => { throw new Error('Synthetic storage failure'); });
    const failed = await handler(request('/api/videos'));
    expect(failed.statusCode).toBe(500);
    for (const response of [first, denied, failed]) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.cookies).toBeUndefined();
      expect(JSON.stringify(response)).not.toContain(marker);
    }
    expect(headerReads).toBe(0);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(s3.objects.size).toBe(0);
    expect(s3.send.mock.calls[0][0].constructor.name).toBe('GetObjectCommand');
    expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(marker);
  } finally { logs.forEach((log) => log.mockRestore()); }
});

test('bearer client can upload without Origin but cannot write or delete with read permission', async () => {
  const handler = createHandler({ s3: createFakeS3(), now: () => NOW });
  const request = event('POST', '/api/uploads', ['video.write']);
  request.body = JSON.stringify({ title: 'API test', contentType: 'video/mp4', size: 10 });
  expect((await handler(request)).statusCode).toBe(200);
  request.requestContext.authorizer.jwt.scopes = ['video.read'];
  expect((await handler(request)).statusCode).toBe(403);
  const remove = event('POST', '/api/videos/delete', ['video.write']);
  expect((await handler(remove)).statusCode).toBe(403);
});

test('HTTP API has no login or logout routes, and default Function URL context stays on browser auth', async () => {
  const handler = createHandler({ loadConfig: async () => config, s3: createFakeS3(), now: () => NOW });
  expect((await handler(event('GET', '/auth/login'))).statusCode).toBe(404);
  expect((await handler(event('GET', '/api/unknown'))).statusCode).toBe(404);
  const request = event('GET', '/auth/login');
  request.requestContext = { apiId: 'function-url-id', routeKey: '$default',
    domainName: 'example.lambda-url.eu-west-1.on.aws', http: { method: 'GET' }, authorizer: { iam: {} } };
  expect((await handler(request)).statusCode).toBe(302);
  request.rawPath = '/api/videos';
  request.headers = { 'x-jwt-claims': JSON.stringify(event().requestContext.authorizer.jwt.claims) };
  expect((await handler(request)).statusCode).toBe(401);
  request.cookies = [`${auth.SESSION_COOKIE}=${auth.sign({ typ: 'session', user: 'owner@example.com', exp: NOW / 1000 + 300 }, auth.sessionKey(config))}`];
  expect((await handler(request)).statusCode).toBe(200);
  request.rawPath = '/api/uploads';
  request.requestContext.http.method = 'POST';
  request.body = '{}';
  expect((await handler(request)).statusCode).toBe(403);
});

test('production-shaped gateway events (shared client, bracketed roles) reach /api/me and /api/videos; wrong role does not', async () => {
  process.env.API_CLIENT_ID = AUDIENCE;
  const loadConfig = jest.fn(() => { throw new Error('Must not load browser credentials'); });
  const handler = createHandler({ loadConfig, s3: createFakeS3(), now: () => NOW });
  const gatewayEvent = (path, roles) => {
    const request = event('GET', path);
    Object.assign(request.requestContext.authorizer.jwt.claims, { azp: AUDIENCE, roles, scp: 'video.delete video.read video.write' });
    request.requestContext.authorizer.jwt.scopes = ['video.delete', 'video.read', 'video.write'];
    return request;
  };
  const me = await handler(gatewayEvent('/api/me', '[api.access]'));
  expect(me.statusCode).toBe(200);
  expect(JSON.parse(me.body).user).toBe('assigned-user');
  const list = await handler(gatewayEvent('/api/videos', '[api.access]'));
  expect(list.statusCode).toBe(200);
  expect(JSON.parse(list.body).videos).toEqual([]);
  for (const roles of ['[other.access]', '[api.access.extra]', '[]']) {
    const denied = await handler(gatewayEvent('/api/videos', roles));
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).error).toBe('Video API permission required');
  }
  expect(loadConfig).not.toHaveBeenCalled();
});

describe('shared API user role (api.access) replaces video.access', () => {
  const { REQUIRED_ROLE } = require('../lambda/api/api-access');
  const withClaims = (roles, scopes = ['video.read']) => {
    const request = event();
    request.requestContext.authorizer.jwt.claims.roles = roles;
    request.requestContext.authorizer.jwt.scopes = scopes;
    return request;
  };

  test('the guard requires exactly api.access', () => {
    expect(REQUIRED_ROLE).toBe('api.access');
  });

  test('the retired video.access role alone never authorizes, in any claim shape', () => {
    for (const roles of ['[video.access]', 'video.access', '["video.access"]', ['video.access'],
      '[video.access files.access blog.access trip.access]', '[video.access other.access]']) {
      expect(authorize(withClaims(roles), 'video.read')).toEqual({ status: 403, error: 'Video API permission required' });
    }
  });

  test('near-miss and case variants of api.access are denied', () => {
    for (const roles of ['[API.access]', '[Api.Access]', '[api.access.video]', '[video.api.access]', '[apiaccess]',
      '[api_access]', '[api.access2]', '[api.acces]', '[ api.access]', '[api.access video.access ]', 'API user',
      '[API user]', '["API user"]', 'dliu API user', '[dliu API user]', '["dliu API user"]']) {
      expect(authorize(withClaims(roles), 'video.read').status).toBe(403);
    }
  });

  test('production-shaped bracketed multi-role claims with api.access authorize, including during rollout', () => {
    for (const roles of ['[api.access]', '[video.access api.access]', '[api.access video.access]',
      '[other.role api.access files.extra]']) {
      expect(authorize(withClaims(roles), 'video.read')).toEqual({ user: 'assigned-user', name: 'Test user' });
    }
  });

  test('the shared role grants nothing without the exact Video route scope', () => {
    const roles = '[api.access]';
    for (const [scopes, required] of [
      [[], 'video.read'],
      [['files.read', 'blog.read', 'trip.read'], 'video.read'],
      [['files.write', 'files.delete', 'blog.delete', 'trip.delete'], 'video.delete'],
      [['video.read'], 'video.write'],
      [['video.read', 'video.write'], 'video.delete'],
      [['video.read.all'], 'video.read'],
      [['Video.Read'], 'video.read'],
    ]) {
      expect(authorize(withClaims(roles, scopes), required).status).toBe(403);
    }
    expect(authorize(withClaims(roles, ['video.delete']), 'video.delete').user).toBe('assigned-user');
  });

  test('api.access never bypasses gateway, issuer, tenant, audience, client or user checks', () => {
    for (const [change, status] of [
      [(r) => { r.requestContext.apiId = 'other-api'; }, 401],
      [(r) => { r.requestContext.authorizer.jwt.claims.ver = '1.0'; }, 401],
      [(r) => { r.requestContext.authorizer.jwt.claims.iss = 'https://sts.windows.net/x/'; }, 401],
      [(r) => { r.requestContext.authorizer.jwt.claims.tid = 'other-tenant'; }, 401],
      [(r) => { r.requestContext.authorizer.jwt.claims.aud = 'other-audience'; }, 401],
      [(r) => { delete r.requestContext.authorizer.jwt.claims.oid; }, 401],
      [(r) => { r.requestContext.authorizer.jwt.claims.sub = ''; }, 401],
      [(r) => { r.requestContext.authorizer.jwt.claims.azp = 'other-client'; }, 403],
      [(r) => { delete r.requestContext.authorizer.jwt.claims.azp; }, 403],
    ]) {
      const request = withClaims('[api.access video.access]');
      change(request);
      expect(authorize(request, 'video.read').status).toBe(status);
    }
  });
});

test('production-shaped handler: api.access reaches /api/me and /api/videos; video.access alone gets 403', async () => {
  process.env.API_CLIENT_ID = AUDIENCE;
  const loadConfig = jest.fn(() => { throw new Error('Must not load browser credentials'); });
  const handler = createHandler({ loadConfig, s3: createFakeS3(), now: () => NOW });
  const gatewayEvent = (path, roles, scopes = ['video.delete', 'video.read', 'video.write']) => {
    const request = event('GET', path);
    Object.assign(request.requestContext.authorizer.jwt.claims, { azp: AUDIENCE, roles, scp: scopes.join(' ') });
    request.requestContext.authorizer.jwt.scopes = scopes;
    return request;
  };
  for (const roles of ['[api.access]', '[video.access api.access]']) {
    for (const path of ['/api/me', '/api/videos']) expect((await handler(gatewayEvent(path, roles))).statusCode).toBe(200);
  }
  for (const [roles, scopes] of [['[video.access]', undefined], ['[api.access]', ['files.read', 'blog.read', 'trip.read']]]) {
    const denied = await handler(gatewayEvent('/api/videos', roles, scopes));
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).error).toBe('Video API permission required');
  }
  const cookieOnly = gatewayEvent('/api/videos', '[video.access]');
  cookieOnly.cookies = ['__Host-video-session=forged'];
  cookieOnly.headers = { cookie: '__Host-video-session=forged', 'x-jwt-claims': '{"roles":["api.access"]}' };
  expect((await handler(cookieOnly)).statusCode).toBe(403);
  expect(loadConfig).not.toHaveBeenCalled();
});
