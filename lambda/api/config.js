'use strict';

const PREFIX = process.env.PARAMETER_PREFIX || '/video';
// The tenant ID is shared by every dliu.com app (dliu-com/audit); the client ID and secret are this app's own.
const TENANT_PARAMETER = process.env.TENANT_PARAMETER || '/dliu/entra-tenant-id';
const NAMES = {
  tenantId: TENANT_PARAMETER,
  clientId: `${PREFIX}/entra-client-id`,
  clientSecret: `${PREFIX}/entra-client-secret`,
};
const TTL_MS = 5 * 60 * 1000;

let cached;
let cachedAt = 0;

let ssmClient;
function client() {
  if (!ssmClient) {
    const { SSMClient } = require('@aws-sdk/client-ssm');
    ssmClient = new SSMClient({});
  }
  return ssmClient;
}

class NotConfigured extends Error {}

async function loadConfig(ssm = client(), now = Date.now()) {
  if (cached && now - cachedAt < TTL_MS) return cached;
  const { GetParametersCommand } = require('@aws-sdk/client-ssm');
  const result = await ssm.send(new GetParametersCommand({
    Names: Object.values(NAMES),
    WithDecryption: true,
  }));
  const byName = Object.fromEntries((result.Parameters || []).map((p) => [p.Name, p.Value]));
  const missing = Object.values(NAMES).filter((name) => !byName[name]);
  if (missing.length) {
    throw new NotConfigured(`Missing SSM parameters: ${missing.join(', ')}. Run "make set-secrets" (the tenant ID comes from the dliu-com/audit stack).`);
  }
  cached = {
    tenantId: byName[NAMES.tenantId].trim(),
    clientId: byName[NAMES.clientId].trim(),
    clientSecret: byName[NAMES.clientSecret],
    allowedDomain: (process.env.ALLOWED_DOMAIN || process.env.ROOT_DOMAIN || 'dliu.com').trim().toLowerCase(),
  };
  cachedAt = now;
  return cached;
}

function resetConfigCache() {
  cached = undefined;
  cachedAt = 0;
}

module.exports = { loadConfig, resetConfigCache, NotConfigured, TENANT_PARAMETER };
