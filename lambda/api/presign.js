'use strict';

// SigV4 query-string presigning for S3 (virtual-hosted URLs), so the browser can upload straight to the
// bucket. Written out here so the Lambda needs no bundled presigner package.
const crypto = require('crypto');

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function credentialsFromEnv(env = process.env) {
  return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN };
}

/**
 * @param {object} opts
 * @param {string} opts.method   HTTP method, e.g. PUT
 * @param {string} opts.bucket
 * @param {string} opts.region
 * @param {string} opts.key      object key (not encoded)
 * @param {object} [opts.query]  extra query parameters, e.g. { partNumber: '1', uploadId }
 * @param {object} [opts.headers] headers the uploader must send unchanged, e.g. { 'content-type': 'image/jpeg' }
 * @param {number} [opts.expiresIn] seconds
 * @param {number} [opts.now]    epoch ms
 * @param {object} [opts.credentials]
 */
function presignUrl({ method, bucket, region, key, query = {}, headers = {}, expiresIn = 3600, now = Date.now(), credentials = credentialsFromEnv() }) {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const amzDate = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const signed = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host };
  const signedHeaders = Object.keys(signed).sort();
  const params = {
    ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': signedHeaders.join(';'),
  };
  if (credentials.sessionToken) params['X-Amz-Security-Token'] = credentials.sessionToken;
  const canonicalQuery = Object.keys(params).sort().map((k) => `${encode(k)}=${encode(params[k])}`).join('&');
  const path = '/' + key.split('/').map(encode).join('/');
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${signed[name]}\n`).join('');
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), 's3'), 'aws4_request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

module.exports = { presignUrl, credentialsFromEnv };
