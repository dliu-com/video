// A tiny in-memory S3 for the API tests: handles the commands the Lambda sends.
const crypto = require('crypto');

function error(name, status) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function createFakeS3() {
  const objects = new Map();
  const uploads = new Map();
  const calls = [];
  let etagCounter = 0;
  const put = (key, body, extra = {}) => {
    etagCounter += 1;
    const value = { body: Buffer.from(body || ''), etag: `"etag-${etagCounter}"`, ...extra };
    objects.set(key, value);
    return value;
  };

  async function send(command) {
    const name = command.constructor.name;
    const input = command.input;
    calls.push({ name, input });
    switch (name) {
      case 'GetObjectCommand': {
        const object = objects.get(input.Key);
        if (!object) throw error('NoSuchKey', 404);
        return { ETag: object.etag, Body: { transformToString: async () => object.body.toString('utf8') } };
      }
      case 'HeadObjectCommand': {
        const object = objects.get(input.Key);
        if (!object) throw error('NotFound', 404);
        return { ETag: object.etag, ContentLength: object.body.length, ContentType: object.contentType };
      }
      case 'PutObjectCommand': {
        const existing = objects.get(input.Key);
        if (input.IfNoneMatch === '*' && existing) throw error('PreconditionFailed', 412);
        if (input.IfMatch && (!existing || existing.etag !== input.IfMatch)) throw error('PreconditionFailed', 412);
        const object = put(input.Key, input.Body, { contentType: input.ContentType, cacheControl: input.CacheControl });
        return { ETag: object.etag };
      }
      case 'DeleteObjectCommand':
        objects.delete(input.Key);
        return {};
      case 'CreateMultipartUploadCommand': {
        const uploadId = crypto.randomBytes(6).toString('hex');
        uploads.set(uploadId, { key: input.Key, input });
        return { UploadId: uploadId };
      }
      case 'CompleteMultipartUploadCommand': {
        const upload = uploads.get(input.UploadId);
        if (!upload) throw error('NoSuchUpload', 404);
        uploads.delete(input.UploadId);
        put(input.Key, Buffer.alloc(fakeS3.completedSize || 1234), { contentType: upload.input.ContentType });
        return {};
      }
      case 'AbortMultipartUploadCommand':
        if (!uploads.delete(input.UploadId)) throw error('NoSuchUpload', 404);
        return {};
      default:
        throw new Error(`Fake S3 does not handle ${name}`);
    }
  }

  const fakeS3 = { send, objects, uploads, calls, put, json: (key) => JSON.parse(objects.get(key).body.toString('utf8')) };
  return fakeS3;
}

module.exports = { createFakeS3 };
