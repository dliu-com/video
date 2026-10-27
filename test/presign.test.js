const { SignatureV4 } = require('@smithy/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { presignUrl } = require('../lambda/api/presign');

const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'token/with+chars=' };
const NOW = Date.UTC(2026, 9, 27, 12, 30, 15);

async function reference({ method, bucket, region, key, query, expiresIn }) {
  const signer = new SignatureV4({ credentials, region, service: 's3', sha256: Sha256, uriEscapePath: false, applyChecksum: false });
  const request = new HttpRequest({
    method, protocol: 'https:', hostname: `${bucket}.s3.${region}.amazonaws.com`, path: `/${key}`,
    query: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
    headers: { host: `${bucket}.s3.${region}.amazonaws.com`, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
  });
  const signed = await signer.presign(request, { signingDate: new Date(NOW), expiresIn, unsignableHeaders: new Set(['x-amz-content-sha256']), unhoistableHeaders: new Set(['x-amz-content-sha256']) });
  return new URL(`https://${signed.hostname}${signed.path}?${new URLSearchParams(signed.query)}`);
}

describe('presignUrl', () => {
  test.each([
    ['part upload', { method: 'PUT', key: 'v/AbC-_123xyz.mp4', query: { partNumber: 7, uploadId: 'abc.def~ghi' } }],
    ['poster upload', { method: 'PUT', key: 't/AbC-_123xyz-AbCd_123.jpg', query: {} }],
  ])('matches the AWS SDK signer for a %s', async (_, input) => {
    const opts = { ...input, bucket: 'video-videobucket-abc123', region: 'eu-west-1', expiresIn: 3600 };
    const ours = new URL(presignUrl({ ...opts, credentials, now: NOW }));
    const theirs = await reference(opts);
    expect(ours.host).toBe(theirs.host);
    expect(ours.pathname).toBe(theirs.pathname);
    expect(Object.fromEntries(ours.searchParams)).toEqual(Object.fromEntries(theirs.searchParams));
  });

  test('omits the security token when there is none', () => {
    const url = new URL(presignUrl({
      method: 'PUT', bucket: 'b', region: 'eu-west-1', key: 'k', now: NOW,
      credentials: { accessKeyId: 'A', secretAccessKey: 'S' },
    }));
    expect(url.searchParams.has('X-Amz-Security-Token')).toBe(false);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  });
});
