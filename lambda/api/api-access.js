'use strict';

/**
 * API Gateway HTTP APIs pass array claims to Lambda as a bracketed, space-separated string that is not JSON:
 * Microsoft's "roles": ["api.access", "other"] arrives as "[api.access other]". Entra role values cannot
 * contain spaces, so each role is matched exactly. Real arrays, JSON arrays and a bare single value are also
 * accepted; anything else returns null so the request is denied.
 */
function parseRoles(roles) {
  if (typeof roles === 'string') {
    if (/^\[\s*"/.test(roles)) {
      try { roles = JSON.parse(roles); } catch { return null; }
    } else if (roles.startsWith('[') && roles.endsWith(']')) {
      const inner = roles.slice(1, -1);
      if (!inner) return [];
      roles = inner.split(' ');
      if (roles.some((role) => !role || /["\s]/.test(role))) return null;
    } else if (/^[^\s"[\]]+$/.test(roles)) {
      roles = [roles];
    } else {
      return null;
    }
  }
  return Array.isArray(roles) && roles.every((role) => typeof role === 'string') ? roles : null;
}

// Shared "dliu API user" app role (value api.access) on the dliu API registration; route scopes still gate each operation.
const REQUIRED_ROLE = 'api.access';

function authorize(event, scope) {
  const context = event.requestContext;
  const jwt = context && context.authorizer && context.authorizer.jwt;
  const claims = jwt && jwt.claims;
  const tenant = process.env.API_TENANT_ID;
  const audience = process.env.API_AUDIENCE;
  const client = process.env.API_CLIENT_ID;
  // Only API Gateway supplies this context; viewer headers and cookies are not evidence of JWT validation.
  if (!process.env.API_GATEWAY_ID || !context || context.apiId !== process.env.API_GATEWAY_ID ||
      !tenant || !audience || !client || !claims ||
      claims.ver !== '2.0' || claims.iss !== `https://login.microsoftonline.com/${tenant}/v2.0` ||
      claims.tid !== tenant || claims.aud !== audience ||
      typeof claims.oid !== 'string' || !claims.oid || typeof claims.sub !== 'string' || !claims.sub) {
    return { status: 401, error: 'Microsoft access token required' };
  }
  const roles = parseRoles(claims.roles);
  if (claims.azp !== client || !roles || !roles.includes(REQUIRED_ROLE) ||
      !Array.isArray(jwt.scopes) || !jwt.scopes.includes(scope)) {
    return { status: 403, error: 'Video API permission required' };
  }
  return { user: claims.oid, name: typeof claims.name === 'string' ? claims.name : claims.oid };
}

module.exports = { authorize, parseRoles, REQUIRED_ROLE };
