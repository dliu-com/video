'use strict';

const auth = require('./auth');
const apiAccess = require('./api-access');
const ROUTES = require('./routes.json');
const { loadConfig, NotConfigured } = require('./config');
const { BadRequest, NotFound, createVideos } = require('./videos');
const { createStreaming } = require('./streaming');

const SECURITY_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const MAX_BODY = 64 * 1024;

function json(statusCode, body, cookies) {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
    ...(cookies ? { cookies } : {}),
    body: JSON.stringify(body),
  };
}

function redirect(location, cookies) {
  return { statusCode: 302, headers: { ...SECURITY_HEADERS, location }, ...(cookies ? { cookies } : {}), body: '' };
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function errorPage(statusCode, message, cookies) {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' },
    ...(cookies ? { cookies } : {}),
    body: `<!doctype html><meta charset="utf-8"><title>Video</title><link rel="stylesheet" href="/style.css">
<body><main class="narrow"><h1>Sign-in problem</h1><p>${escapeHtml(message)}</p><p><a href="/auth/login">Try again</a> · <a href="/">Home</a></p></main></body>`,
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > MAX_BODY) throw new BadRequest('Request too large');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new BadRequest('Body must be a JSON object');
  }
}

let clients = {};
const client = (name, make) => clients[name] || (clients[name] = make());
const s3Client = () => client('s3', () => { const { S3Client } = require('@aws-sdk/client-s3'); return new S3Client({}); });
const mediaConvertClient = () => client('mediaconvert', () => {
  const { MediaConvertClient } = require('@aws-sdk/client-mediaconvert');
  return new MediaConvertClient({});
});
const schedulerClient = () => client('scheduler', () => { const { SchedulerClient } = require('@aws-sdk/client-scheduler'); return new SchedulerClient({}); });

// The schedule targets this function. Its own ARN comes from the invocation (the stack cannot pass it in),
// without any alias or version suffix.
const functionArn = (context) => (context && context.invokedFunctionArn ? context.invokedFunctionArn.split(':').slice(0, 7).join(':') : undefined);

// Deletes drop the file from the CDN. The distribution ID is in SSM: the stack cannot pass it to this
// function directly, because the distribution itself points at this function.
async function invalidateWithCloudFront(paths) {
  const prefix = process.env.PARAMETER_PREFIX || '/video';
  const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');
  const ssm = client('ssm', () => new SSMClient({}));
  const result = await ssm.send(new GetParametersCommand({ Names: [`${prefix}/distribution-id`] }));
  const distributionId = result.Parameters && result.Parameters[0] && result.Parameters[0].Value;
  if (!distributionId) {
    console.warn(JSON.stringify({ message: 'No distribution ID; skipped CDN invalidation', paths }));
    return;
  }
  const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
  const cloudfront = client('cloudfront', () => new CloudFrontClient({}));
  await cloudfront.send(new CreateInvalidationCommand({
    DistributionId: distributionId,
    InvalidationBatch: { CallerReference: `${Date.now()}-${Math.random()}`, Paths: { Quantity: paths.length, Items: paths } },
  }));
}

function createHandler(deps = {}) {
  const getConfig = deps.loadConfig || loadConfig;
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
  const clock = deps.now || Date.now;

  function services(context) {
    const s3 = deps.s3 || s3Client();
    const bucket = process.env.VIDEO_BUCKET;
    const invalidate = deps.invalidate || invalidateWithCloudFront;
    const streaming = createStreaming({
      s3,
      bucket,
      mediaconvert: deps.mediaconvert || (process.env.MEDIACONVERT_ROLE_ARN ? mediaConvertClient() : null),
      scheduler: deps.scheduler || (process.env.MEDIACONVERT_ROLE_ARN ? schedulerClient() : null),
      settings: {
        roleArn: process.env.MEDIACONVERT_ROLE_ARN,
        schedulerRoleArn: process.env.SCHEDULER_ROLE_ARN,
        scheduleGroup: process.env.SCHEDULE_GROUP,
        delayMinutes: process.env.CONVERT_DELAY_MINUTES,
        targetArn: functionArn(context),
      },
      now: clock,
      invalidate,
    });
    const videos = createVideos({
      s3,
      bucket,
      region: process.env.AWS_REGION,
      maxBytes: Number(process.env.MAX_UPLOAD_BYTES) || 50 * 1024 ** 3,
      now: clock,
      invalidate,
      streaming,
    });
    return { streaming, videos };
  }

  // Not a web request: the conversion schedule or MediaConvert's job state change. Only AWS can send these
  // (direct invokes need IAM permission; the function URL and API Gateway always add requestContext).
  async function task(event, context) {
    const { streaming } = services(context);
    if (event.source === 'aws.mediaconvert' && event['detail-type'] === 'MediaConvert Job State Change') {
      await streaming.onJobEvent(event.detail);
      return { ok: true };
    }
    if (event.task === 'convert' && /^\d{10}$/.test(event.id || '')) {
      await streaming.start(event.id, event.token);
      return { ok: true };
    }
    console.warn(JSON.stringify({ message: 'Ignored event', keys: Object.keys(event || {}) }));
    return { ok: false };
  }

  return async function handler(event, lambdaContext) {
    if (event && !event.requestContext) return task(event, lambdaContext);
    const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET';
    const path = event.rawPath || '/';
    const params = event.queryStringParameters || {};
    const siteUrl = process.env.SITE_URL;
    const route = ROUTES[`${method} ${path}`];
    const context = event.requestContext;
    const managedApi = Boolean(context && ((context.authorizer && context.authorizer.jwt) ||
      (context.apiId && context.routeKey !== '$default')));
    if (managedApi && !route) return json(404, { error: 'Not found' });
    if (!route && method !== 'GET') return json(405, { error: 'Method not allowed' });

    try {
      const config = managedApi ? null : await getConfig();

      if (!managedApi && path === '/auth/login') {
        const login = auth.startLogin(config, siteUrl, clock(), params.return);
        return redirect(login.location, login.cookies);
      }
      if (!managedApi && path === '/auth/callback') {
        const result = await auth.finishLogin(event, config, siteUrl, { fetchImpl, now: clock() });
        return result.location ? redirect(result.location, result.cookies) : errorPage(result.status, result.error, result.cookies);
      }
      if (!managedApi && path === '/auth/logout') return redirect('/', auth.logoutCookies());

      if (!path.startsWith('/api/')) return json(404, { error: 'Not found' });
      const session = managedApi ? apiAccess.authorize(event, route.scope) : auth.getSession(event, config, clock());
      if (session && session.status) return json(session.status, { error: session.error });
      // Clearing the hint cookie makes the pages hide the owner controls again.
      if (!session) return json(401, { error: 'Not signed in' }, auth.logoutCookies());

      const { videos } = services(lambdaContext);

      if (route && route.action) {
        // Cross-site requests carry no session (SameSite=Lax); the Origin check is a second guard.
        const origin = (event.headers && event.headers.origin) || '';
        if (!managedApi && origin !== siteUrl) return json(403, { error: 'Forbidden' });
        return json(200, await videos[route.action](parseBody(event)));
      }
      if (path === '/api/me') return json(200, { user: session.user, name: session.name });
      if (path === '/api/videos') return json(200, await videos.list());
      return json(404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof BadRequest) return json(400, { error: error.message });
      if (error instanceof NotFound) return json(404, { error: error.message });
      if (error instanceof NotConfigured) {
        console.error(JSON.stringify({ message: 'Sign-in not configured', path, error: error.message }));
        const text = 'Sign-in is not configured yet. Run "make set-secrets".';
        return path.startsWith('/auth/') ? errorPage(503, text) : json(503, { error: text });
      }
      console.error(JSON.stringify({ message: 'Request failed', path, error: error.message, stack: error.stack }));
      if (path.startsWith('/auth/')) return errorPage(500, 'Something went wrong while signing in.');
      return json(500, { error: 'Internal error' });
    }
  };
}

module.exports = { createHandler, handler: createHandler() };
