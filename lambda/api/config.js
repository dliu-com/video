'use strict';

const PREFIX = process.env.PARAMETER_PREFIX || '/video';
const NAMES = ['entra-tenant-id', 'entra-client-id', 'entra-client-secret'];
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
    Names: NAMES.map((name) => `${PREFIX}/${name}`),
    WithDecryption: true,
  }));
  const values = Object.fromEntries((result.Parameters || []).map((p) => [p.Name.slice(PREFIX.length + 1), p.Value]));
  const missing = NAMES.filter((name) => !values[name]);
  if (missing.length) {
    throw new NotConfigured(`Missing SSM parameters under ${PREFIX}: ${missing.join(', ')}. Run "make set-secrets".`);
  }
  cached = {
    tenantId: values['entra-tenant-id'].trim(),
    clientId: values['entra-client-id'].trim(),
    clientSecret: values['entra-client-secret'],
    allowedDomain: (process.env.ALLOWED_DOMAIN || process.env.ROOT_DOMAIN || 'dliu.com').trim().toLowerCase(),
  };
  cachedAt = now;
  return cached;
}

function resetConfigCache() {
  cached = undefined;
  cachedAt = 0;
}

module.exports = { loadConfig, resetConfigCache, NotConfigured };
