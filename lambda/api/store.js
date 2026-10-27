'use strict';

// Everything lives in the video bucket; there is no database.
//   v/<id>.<ext>             the video file, served as uploaded
//   t/<id>-<version>.jpg     poster image (a new version gets a new key, so caches never go stale)
//   meta/index.json          every video, public and unlisted: the source of truth (not reachable from CloudFront)
//   pending/<id>.json        an upload in progress (not reachable from CloudFront)
//   data/catalog.json        public videos, for the home page (served by CloudFront)
//   data/videos/<id>.json    one video's details, public or unlisted, for the watch and embed pages
const INDEX_KEY = 'meta/index.json';
const CATALOG_KEY = 'data/catalog.json';
const videoDataKey = (id) => `data/videos/${id}.json`;
const pendingKey = (id) => `pending/${id}.json`;
const videoKey = (id, ext) => `v/${id}.${ext}`;
const posterKey = (id, version) => `t/${id}-${version}.jpg`;

const s3sdk = () => require('@aws-sdk/client-s3');

const isMissing = (error) => error && (error.name === 'NoSuchKey' || error.name === 'NotFound' || (error.$metadata && error.$metadata.httpStatusCode === 404));
const isConflict = (error) => error && (error.name === 'PreconditionFailed' || error.name === 'ConditionalRequestConflict'
  || (error.$metadata && [409, 412].includes(error.$metadata.httpStatusCode)));

async function readJson(s3, bucket, key) {
  const { GetObjectCommand } = s3sdk();
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return { value: JSON.parse(await result.Body.transformToString()), etag: result.ETag };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function writeJson(s3, bucket, key, value, extra = {}) {
  const { PutObjectCommand } = s3sdk();
  return s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: JSON.stringify(value), ContentType: 'application/json; charset=utf-8', ...extra,
  }));
}

async function deleteKeys(s3, bucket, keys) {
  const { DeleteObjectCommand } = s3sdk();
  await Promise.all(keys.filter(Boolean).map((Key) => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }))));
}

async function headObject(s3, bucket, key) {
  const { HeadObjectCommand } = s3sdk();
  try {
    return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readIndex(s3, bucket) {
  const found = await readJson(s3, bucket, INDEX_KEY);
  return found ? found.value : { videos: [] };
}

/**
 * Changes meta/index.json with a conditional write, retrying if another request changed it first.
 * `change(index)` mutates the index and returns a result; return `undefined` from it to skip the write.
 */
async function updateIndex(s3, bucket, change, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    const found = await readJson(s3, bucket, INDEX_KEY);
    const index = found ? found.value : { videos: [] };
    const result = await change(index);
    if (result === undefined) return { index, result };
    try {
      await writeJson(s3, bucket, INDEX_KEY, index, found ? { IfMatch: found.etag } : { IfNoneMatch: '*' });
      return { index, result };
    } catch (error) {
      if (!isConflict(error) || attempt >= attempts) throw error;
    }
  }
}

const publicVideo = (video) => ({
  id: video.id,
  title: video.title,
  description: video.description,
  visibility: video.visibility,
  createdAt: video.createdAt,
  updatedAt: video.updatedAt,
  duration: video.duration,
  width: video.width,
  height: video.height,
  size: video.size,
  contentType: video.contentType,
  src: `/${videoKey(video.id, video.ext)}`,
  poster: video.posterVersion ? `/${posterKey(video.id, video.posterVersion)}` : null,
});

const newestFirst = (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

/** Rewrites the public files after an index change: the catalog, plus data/videos/<id>.json for the given IDs. */
async function publish(s3, bucket, index, { changed = [], removed = [] } = {}, now = Date.now()) {
  const noCache = { CacheControl: 'no-cache' };
  const catalog = {
    updatedAt: new Date(now).toISOString(),
    videos: index.videos.filter((v) => v.visibility === 'public').sort(newestFirst).map((video) => {
      const { description: _, contentType: __, size: ___, visibility: ____, ...summary } = publicVideo(video);
      return summary;
    }),
  };
  const byId = new Map(index.videos.map((v) => [v.id, v]));
  await Promise.all([
    writeJson(s3, bucket, CATALOG_KEY, catalog, noCache),
    ...changed.filter((id) => byId.has(id)).map((id) => writeJson(s3, bucket, videoDataKey(id), publicVideo(byId.get(id)), noCache)),
    deleteKeys(s3, bucket, removed.map(videoDataKey)),
  ]);
}

module.exports = {
  CATALOG_KEY,
  INDEX_KEY,
  deleteKeys,
  headObject,
  isConflict,
  isMissing,
  newestFirst,
  pendingKey,
  posterKey,
  publicVideo,
  publish,
  readIndex,
  readJson,
  updateIndex,
  videoDataKey,
  videoKey,
  writeJson,
};
