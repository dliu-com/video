'use strict';

const crypto = require('crypto');
const { presignUrl } = require('./presign');
const store = require('./store');

const MiB = 1024 * 1024;
const MIN_PART = 16 * MiB;
const MAX_PARTS = 10000;
const PARTS_PER_CALL = 100;
const URL_SECONDS = 60 * 60;
const MAX_POSTER_BYTES = 5 * MiB;

// Served as uploaded, so only containers browsers can play (codecs inside are the uploader's concern).
const CONTENT_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v', 'video/ogg': 'ogv' };
const ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const VERSION_PATTERN = /^[A-Za-z0-9_-]{8}$/;

class BadRequest extends Error {}
class NotFound extends Error {}

const newId = () => crypto.randomBytes(8).toString('base64url');
const newVersion = () => crypto.randomBytes(6).toString('base64url');

function text(value, name, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new BadRequest(`${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new BadRequest(`${name} must be text`);
  // Drop control characters except newline and tab.
  const clean = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  if (required && !clean) throw new BadRequest(`${name} is required`);
  if (clean.length > max) throw new BadRequest(`${name} is longer than ${max} characters`);
  return clean;
}

function number(value, name, { integer = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new BadRequest(`${name} is not valid`);
  }
  return value;
}

function videoId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new BadRequest('Invalid video id');
  return value;
}

function partPlan(size) {
  const partSize = Math.max(MIN_PART, Math.ceil(size / MAX_PARTS / MiB) * MiB);
  return { partSize, partCount: Math.ceil(size / partSize) };
}

function createVideos({ s3, bucket, region, maxBytes, now = Date.now, invalidate = async () => {} }) {
  const sdk = () => require('@aws-sdk/client-s3');
  const sign = (method, key, query) => presignUrl({ method, bucket, region, key, query, expiresIn: URL_SECONDS, now: now() });

  async function readPending(id, uploadId) {
    const found = await store.readJson(s3, bucket, store.pendingKey(videoId(id)));
    if (!found || typeof uploadId !== 'string' || found.value.uploadId !== uploadId) throw new NotFound('Upload not found');
    return found.value;
  }

  async function posterInfo(id, version) {
    if (!version) return null;
    const head = await store.headObject(s3, bucket, store.posterKey(id, version));
    return head && head.ContentLength <= MAX_POSTER_BYTES ? version : null;
  }

  return {
    async list() {
      const index = await store.readIndex(s3, bucket);
      return { videos: index.videos.slice().sort(store.newestFirst).map(store.publicVideo) };
    },

    async createUpload(body) {
      const ext = CONTENT_TYPES[body.contentType];
      if (!ext) throw new BadRequest(`Unsupported file type. Use one of: ${Object.keys(CONTENT_TYPES).join(', ')}`);
      const size = number(body.size, 'size', { integer: true, min: 1, max: maxBytes });
      if (size === null) throw new BadRequest('size is required');
      const id = newId();
      const pending = {
        id,
        ext,
        title: text(body.title, 'title', 200, { required: true }),
        description: text(body.description, 'description', 5000),
        contentType: body.contentType,
        size,
        duration: number(body.duration, 'duration', { max: 7 * 24 * 3600 }),
        width: number(body.width, 'width', { integer: true, max: 16384 }),
        height: number(body.height, 'height', { integer: true, max: 16384 }),
        posterVersion: body.poster ? newVersion() : null,
        ...partPlan(size),
        createdAt: new Date(now()).toISOString(),
      };
      const { CreateMultipartUploadCommand } = sdk();
      const created = await s3.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: store.videoKey(id, ext),
        ContentType: pending.contentType,
        // IDs are never reused and deletes invalidate the CDN, so the file can be cached for good.
        CacheControl: 'public, max-age=31536000, immutable',
        // Rarely watched videos move to cheaper tiers by themselves.
        StorageClass: 'INTELLIGENT_TIERING',
      }));
      pending.uploadId = created.UploadId;
      await store.writeJson(s3, bucket, store.pendingKey(id), pending);
      return {
        id,
        uploadId: pending.uploadId,
        partSize: pending.partSize,
        partCount: pending.partCount,
        posterUrl: pending.posterVersion ? sign('PUT', store.posterKey(id, pending.posterVersion)) : null,
      };
    },

    async signParts(body) {
      const pending = await readPending(body.id, body.uploadId);
      const parts = Array.isArray(body.parts) ? body.parts : [];
      if (!parts.length || parts.length > PARTS_PER_CALL) throw new BadRequest(`Ask for 1 to ${PARTS_PER_CALL} parts at a time`);
      const urls = {};
      for (const part of parts) {
        if (!Number.isInteger(part) || part < 1 || part > pending.partCount) throw new BadRequest('Invalid part number');
        urls[part] = sign('PUT', store.videoKey(pending.id, pending.ext), { partNumber: part, uploadId: pending.uploadId });
      }
      return { urls };
    },

    async completeUpload(body) {
      const pending = await readPending(body.id, body.uploadId);
      const parts = Array.isArray(body.parts) ? body.parts : [];
      if (parts.length !== pending.partCount) throw new BadRequest(`Expected ${pending.partCount} parts, got ${parts.length}`);
      const sorted = parts.map((p) => {
        if (!p || !Number.isInteger(p.partNumber) || typeof p.etag !== 'string' || !/^"?[0-9a-fA-F-]{1,64}"?$/.test(p.etag)) {
          throw new BadRequest('Invalid part list');
        }
        return { PartNumber: p.partNumber, ETag: p.etag };
      }).sort((a, b) => a.PartNumber - b.PartNumber);
      if (sorted.some((p, i) => p.PartNumber !== i + 1)) throw new BadRequest('Invalid part list');

      const key = store.videoKey(pending.id, pending.ext);
      const { CompleteMultipartUploadCommand } = sdk();
      await s3.send(new CompleteMultipartUploadCommand({
        Bucket: bucket, Key: key, UploadId: pending.uploadId, MultipartUpload: { Parts: sorted },
      }));
      const head = await store.headObject(s3, bucket, key);
      if (!head) throw new Error('Uploaded video is missing');
      const stamp = new Date(now()).toISOString();
      const video = {
        id: pending.id,
        ext: pending.ext,
        title: pending.title,
        description: pending.description,
        contentType: pending.contentType,
        size: head.ContentLength,
        duration: pending.duration,
        width: pending.width,
        height: pending.height,
        posterVersion: await posterInfo(pending.id, pending.posterVersion),
        createdAt: stamp,
        updatedAt: stamp,
      };
      const { index } = await store.updateIndex(s3, bucket, (idx) => {
        idx.videos = idx.videos.filter((v) => v.id !== video.id).concat(video);
        return true;
      });
      await store.publish(s3, bucket, index, { changed: [video.id] }, now());
      await store.deleteKeys(s3, bucket, [store.pendingKey(video.id)]);
      return { video: store.publicVideo(video) };
    },

    async abortUpload(body) {
      const pending = await readPending(body.id, body.uploadId);
      const { AbortMultipartUploadCommand } = sdk();
      await s3.send(new AbortMultipartUploadCommand({
        Bucket: bucket, Key: store.videoKey(pending.id, pending.ext), UploadId: pending.uploadId,
      })).catch((error) => { if (!store.isMissing(error) && error.name !== 'NoSuchUpload') throw error; });
      await store.deleteKeys(s3, bucket, [
        store.pendingKey(pending.id),
        pending.posterVersion && store.posterKey(pending.id, pending.posterVersion),
      ]);
      return { aborted: true };
    },

    /** A URL to upload a new poster image; pass its version to update() once the upload is done. */
    async posterUpload(body) {
      const id = videoId(body.id);
      const index = await store.readIndex(s3, bucket);
      if (!index.videos.some((v) => v.id === id)) throw new NotFound('Video not found');
      const version = newVersion();
      return { version, url: sign('PUT', store.posterKey(id, version)) };
    },

    async update(body) {
      const id = videoId(body.id);
      const changes = {};
      if (body.title !== undefined) changes.title = text(body.title, 'title', 200, { required: true });
      if (body.description !== undefined) changes.description = text(body.description, 'description', 5000);
      if (body.posterVersion !== undefined) {
        if (typeof body.posterVersion !== 'string' || !VERSION_PATTERN.test(body.posterVersion)) throw new BadRequest('Invalid poster');
        if (!(await posterInfo(id, body.posterVersion))) throw new BadRequest('Poster upload not found or too large');
        changes.posterVersion = body.posterVersion;
      }
      let oldPoster = null;
      const { index, result } = await store.updateIndex(s3, bucket, (idx) => {
        const video = idx.videos.find((v) => v.id === id);
        if (!video) return undefined;
        oldPoster = video.posterVersion;
        Object.assign(video, changes, { updatedAt: new Date(now()).toISOString() });
        return video;
      });
      if (!result) throw new NotFound('Video not found');
      await store.publish(s3, bucket, index, { changed: [id] }, now());
      if (changes.posterVersion && oldPoster && oldPoster !== changes.posterVersion) {
        await store.deleteKeys(s3, bucket, [store.posterKey(id, oldPoster)]);
      }
      return { video: store.publicVideo(result) };
    },

    async remove(body) {
      const id = videoId(body.id);
      const { index, result } = await store.updateIndex(s3, bucket, (idx) => {
        const video = idx.videos.find((v) => v.id === id);
        if (!video) return undefined;
        idx.videos = idx.videos.filter((v) => v.id !== id);
        return video;
      });
      if (!result) throw new NotFound('Video not found');
      await store.publish(s3, bucket, index, { removed: [id] }, now());
      await store.deleteKeys(s3, bucket, [store.videoKey(id, result.ext), result.posterVersion && store.posterKey(id, result.posterVersion)]);
      // The file is cached for a year, so drop it from the CDN too.
      await invalidate([`/${store.videoKey(id, result.ext)}`, `/t/${id}-*`, `/${store.videoDataKey(id)}`]);
      return { deleted: id };
    },
  };
}

module.exports = { BadRequest, CONTENT_TYPES, NotFound, createVideos, partPlan };
