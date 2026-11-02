#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const routes = require('../lambda/api/routes.json');

function readConfig(env = process.env) {
  const endpoint = new URL(env.VIDEO_API_URL);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('VIDEO_API_URL must be an HTTPS API origin without a path or credentials');
  }
  if (Object.hasOwn(env, 'VIDEO_API_ACCESS_TOKEN')) {
    if (typeof env.VIDEO_API_ACCESS_TOKEN !== 'string' ||
        !/^[A-Za-z0-9._~+\/-]+=*$/.test(env.VIDEO_API_ACCESS_TOKEN)) {
      throw new Error('VIDEO_API_ACCESS_TOKEN must contain only bearer-token characters');
    }
    return { endpoint: endpoint.origin, accessToken: env.VIDEO_API_ACCESS_TOKEN };
  }
  // Tokens come only from auth.dliu.com (copied, or saved with Save file); this client never signs in itself.
  const credentialFile = Object.hasOwn(env, 'VIDEO_API_TOKEN_FILE') ? env.VIDEO_API_TOKEN_FILE :
    path.join(env.HOME || os.homedir(), '.dliu_token');
  if (typeof credentialFile !== 'string' || !path.isAbsolute(credentialFile) || credentialFile.includes('\0')) {
    throw new Error('VIDEO_API_TOKEN_FILE must be an absolute credential-file path');
  }
  return { endpoint: endpoint.origin, credentialFile };
}

function readAccessToken(config, now = Date.now()) {
  if (config.accessToken) return config.accessToken;
  if (!config.credentialFile) throw new Error('Use a saved or copied token from auth.dliu.com for this request');
  let content;
  try {
    content = fs.readFileSync(config.credentialFile, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read credential file (${error.code || 'read failed'}); use Save file at auth.dliu.com`);
  }
  const fields = {};
  for (const line of content.split(/\r?\n/).filter((value) => value !== '')) {
    const index = line.indexOf('=');
    const name = line.slice(0, index);
    if (index < 1 || !['token', 'expires_at'].includes(name) || Object.hasOwn(fields, name)) {
      throw new Error('Credential file needs exactly one token= line and one expires_at= UTC line; use Save file at auth.dliu.com');
    }
    fields[name] = line.slice(index + 1);
  }
  if (Object.keys(fields).length !== 2) {
    throw new Error('Credential file needs exactly one token= line and one expires_at= UTC line; use Save file at auth.dliu.com');
  }
  const token = fields.token;
  const parts = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token.split('.') : [];
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0] || '', 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1] || '', 'base64url').toString('utf8'));
  } catch {
    throw new Error('Credential file token must be a JWT access token with an integer exp; save a fresh file at auth.dliu.com');
  }
  if (!header || typeof header.alg !== 'string' || !header.alg ||
      !claims || !Number.isSafeInteger(claims.exp) || claims.exp <= 0 || !Number.isSafeInteger(claims.exp * 1000)) {
    throw new Error('Credential file token must be a JWT access token with an integer exp; save a fresh file at auth.dliu.com');
  }
  const expiresAt = Date.parse(fields.expires_at);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(fields.expires_at) ||
      !Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !==
      (fields.expires_at.includes('.') ? fields.expires_at : fields.expires_at.replace('Z', '.000Z'))) {
    throw new Error('Credential file expires_at must be a valid ISO UTC timestamp; use Save file at auth.dliu.com');
  }
  // Local expiry checks do not verify the JWT signature or replace gateway authorization.
  if (Math.min(expiresAt, claims.exp * 1000) <= now) {
    throw new Error('Saved Microsoft access token has expired; obtain a fresh token and save the file again at auth.dliu.com');
  }
  return token;
}

function createClient(config, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const token = async () => readAccessToken(config, (deps.now || Date.now)());

  async function request(method, path, body) {
    if (!Object.hasOwn(routes, `${method} ${path}`)) throw new Error('Unknown Video API method or path');
    const response = await fetchImpl(config.endpoint + path, {
      method,
      redirect: 'error',
      headers: { authorization: `Bearer ${await token()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Video API ${response.status}: ${result.error || result.message || 'Request failed'}`);
    return result;
  }
  return { request };
}

async function main(args = process.argv.slice(2)) {
  const [method = 'GET', path = '/api/me', text] = args;
  if (args.length > 3) throw new Error('Usage: node scripts/api-client.js [GET|POST /api/path [JSON]]');
  const client = createClient(readConfig());
  console.log(JSON.stringify(await client.request(method, path, text === undefined ? undefined : JSON.parse(text)), null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { readConfig, readAccessToken, createClient, main };
