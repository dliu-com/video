'use strict';

// Streaming versions: MediaConvert turns the uploaded file into HLS (several qualities, 6-second segments) so
// players can start fast and switch quality to suit the connection. Conversion waits until a file has stayed
// unchanged for a while (2 hours by default), because a video is often replaced several times while being edited.
//
// Flow: upload or replace -> one-time EventBridge Scheduler schedule "video-<id>" -> this Lambda ({ task: 'convert' })
// -> MediaConvert job -> EventBridge "MediaConvert Job State Change" -> this Lambda marks the video ready or failed.
// The state lives in the private index as video.stream; the public JSON only gets `hls` once it is ready.

const crypto = require('crypto');
const store = require('./store');

const APP = 'video.dliu.com';
const VERSION_PATTERN = /^[A-Za-z0-9_-]{8}$/;
const ID_PATTERN = /^\d{10}$/;
// Short side in pixels. QVBR spends bits where the picture needs them, up to the maximum bitrate.
const LADDER = [
  { size: 1080, maxBitrate: 4500000, quality: 8, audio: 128000 },
  { size: 720, maxBitrate: 2500000, quality: 7, audio: 128000 },
  { size: 480, maxBitrate: 1200000, quality: 7, audio: 96000 },
  { size: 360, maxBitrate: 600000, quality: 7, audio: 96000 },
];
const MIN_BITRATE = 250000;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const newToken = () => crypto.randomBytes(6).toString('base64url');

/**
 * The qualities to make: 1080p, 720p, 480p and 360p, never larger than the source (a 900p source gets 900p,
 * 720p, ...) and never at a higher bitrate than the source. Sizes are the short side, so portrait videos work too.
 */
function renditions(video) {
  const sourceBitrate = video.size && video.duration ? (video.size * 8) / video.duration : Infinity;
  const cap = (max) => Math.round(Math.max(MIN_BITRATE, Math.min(max, sourceBitrate)));
  if (!video.width || !video.height) {
    // Size unknown (the browser could not read it): one stream at the source size.
    const [top] = LADDER;
    return [{ name: 'source', width: null, height: null, maxBitrate: cap(top.maxBitrate), quality: top.quality, audio: top.audio }];
  }
  const short = Math.min(video.width, video.height);
  const top = Math.min(short, LADDER[0].size);
  const sizes = [top, ...LADDER.map((r) => r.size).filter((s) => s < top * 0.85)];
  return sizes.map((size) => {
    const rung = [...LADDER].reverse().find((r) => r.size >= size) || LADDER[0];
    const scale = size / short;
    return {
      name: `${size}p`,
      width: even(video.width * scale),
      height: even(video.height * scale),
      maxBitrate: cap(rung.maxBitrate),
      quality: rung.quality,
      audio: rung.audio,
    };
  });
}

/** MediaConvert job settings: one HLS group, H.264 + AAC, single-pass (Basic pricing tier). */
function jobSettings({ bucket, input, prefix, rungs }) {
  return {
    TimecodeConfig: { Source: 'ZEROBASED' },
    Inputs: [{
      FileInput: `s3://${bucket}/${input}`,
      TimecodeSource: 'ZEROBASED',
      // Phone videos carry a rotation flag; apply it so outputs play upright everywhere.
      VideoSelector: { Rotate: 'AUTO' },
      AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
    }],
    OutputGroups: [{
      Name: 'HLS',
      OutputGroupSettings: {
        Type: 'HLS_GROUP_SETTINGS',
        HlsGroupSettings: {
          Destination: `s3://${bucket}/${prefix}index`,
          DestinationSettings: { S3Settings: { StorageClass: 'INTELLIGENT_TIERING' } },
          SegmentLength: 6,
          MinSegmentLength: 0,
          SegmentControl: 'SEGMENTED_FILES',
          DirectoryStructure: 'SINGLE_DIRECTORY',
          ManifestDurationFormat: 'FLOATING_POINT',
          OutputSelection: 'MANIFESTS_AND_SEGMENTS',
          CodecSpecification: 'RFC_4281',
          StreamInfResolution: 'INCLUDE',
          ProgramDateTime: 'EXCLUDE',
          ClientCache: 'ENABLED',
        },
      },
      Outputs: rungs.map((r) => ({
        NameModifier: `_${r.name}`,
        ContainerSettings: { Container: 'M3U8', M3u8Settings: {} },
        VideoDescription: {
          ...(r.width ? { Width: r.width, Height: r.height } : {}),
          ScalingBehavior: 'DEFAULT',
          CodecSettings: {
            Codec: 'H_264',
            H264Settings: {
              RateControlMode: 'QVBR',
              QvbrSettings: { QvbrQualityLevel: r.quality },
              MaxBitrate: r.maxBitrate,
              CodecProfile: 'HIGH',
              CodecLevel: 'AUTO',
              QualityTuningLevel: 'SINGLE_PASS',
              // A keyframe every 2 seconds, so every 6-second segment starts with one and qualities switch cleanly.
              GopSize: 2,
              GopSizeUnits: 'SECONDS',
              GopClosedCadence: 1,
              SceneChangeDetect: 'TRANSITION_DETECTION',
              FramerateControl: 'INITIALIZE_FROM_SOURCE',
            },
          },
        },
        AudioDescriptions: [{
          AudioSourceName: 'Audio Selector 1',
          CodecSettings: { Codec: 'AAC', AacSettings: { Bitrate: r.audio, CodingMode: 'CODING_MODE_2_0', SampleRate: 48000 } },
        }],
      })),
    }],
  };
}

const isNotFound = (error) => error && (error.name === 'ResourceNotFoundException' || error.name === 'NotFoundException'
  || (error.$metadata && error.$metadata.httpStatusCode === 404));

/**
 * settings: { roleArn (MediaConvert), schedulerRoleArn, scheduleGroup, delayMinutes, targetArn (this function) }.
 * Without a MediaConvert role it is switched off: uploads are not scheduled and players use the original file.
 */
function createStreaming({ s3, bucket, mediaconvert, scheduler, settings = {}, now = Date.now, invalidate = async () => {} }) {
  const mc = () => require('@aws-sdk/client-mediaconvert');
  const sch = () => require('@aws-sdk/client-scheduler');
  const enabled = Boolean(settings.roleArn && mediaconvert && scheduler);
  const delayMs = (Number(settings.delayMinutes) || 120) * 60 * 1000;
  const iso = (ms = now()) => new Date(ms).toISOString();
  const scheduleName = (id) => `video-${id}`;
  const log = (message, fields) => console.log(JSON.stringify({ message, ...fields }));

  /** Sets video.stream; returns false when the video is gone or `expect` says the state moved on. */
  async function setStream(id, expect, next) {
    const { index, result } = await store.updateIndex(s3, bucket, (idx) => {
      const video = idx.videos.find((v) => v.id === id);
      if (!video || !expect(video.stream || {})) return undefined;
      if (next) video.stream = next(video.stream || {});
      else delete video.stream;
      return video;
    });
    if (!result) return null;
    await store.publish(s3, bucket, index, { changed: [id] }, now());
    return result;
  }

  async function cancelJob(stream) {
    if (!stream || stream.status !== 'converting' || !stream.jobId) return;
    const { CancelJobCommand } = mc();
    await mediaconvert.send(new CancelJobCommand({ Id: stream.jobId }))
      .catch((error) => log('Could not cancel conversion', { jobId: stream.jobId, error: error.message }));
  }

  async function unschedule(id) {
    const { DeleteScheduleCommand } = sch();
    await scheduler.send(new DeleteScheduleCommand({ Name: scheduleName(id), GroupName: settings.scheduleGroup }))
      .catch((error) => { if (!isNotFound(error)) throw error; });
  }

  const failed = (error) => (stream) => ({
    status: 'failed', token: stream.token, startedAt: stream.startedAt, finishedAt: iso(), error,
  });

  return {
    enabled,

    /** The state for a new or replaced file, stored with it in the index; null when conversion is off. */
    plan() {
      return enabled ? { status: 'scheduled', token: newToken(), scheduledFor: iso(now() + delayMs) } : null;
    },

    /** Creates or moves the one-time schedule that starts the conversion. */
    async schedule(id, stream) {
      if (!enabled || !stream) return;
      const { CreateScheduleCommand, UpdateScheduleCommand } = sch();
      const input = {
        Name: scheduleName(id),
        GroupName: settings.scheduleGroup,
        Description: `Convert video ${id} to streaming versions`,
        ScheduleExpression: `at(${stream.scheduledFor.slice(0, 19)})`,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: settings.targetArn,
          RoleArn: settings.schedulerRoleArn,
          Input: JSON.stringify({ task: 'convert', id, token: stream.token }),
          RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
        },
      };
      try {
        await scheduler.send(new UpdateScheduleCommand(input)).catch(async (error) => {
          if (!isNotFound(error)) throw error;
          await scheduler.send(new CreateScheduleCommand(input));
        });
      } catch (error) {
        console.error(JSON.stringify({ message: 'Could not schedule conversion', id, error: error.message }));
        await setStream(id, (s) => s.token === stream.token, failed('Could not schedule the conversion'));
      }
    },

    /**
     * Starts the MediaConvert job now. `token` is the state the caller saw; if the file was replaced (or a job
     * started) in the meantime, nothing happens.
     */
    async start(id, token) {
      if (!enabled) return null;
      const index = await store.readIndex(s3, bucket);
      const video = index.videos.find((v) => v.id === id);
      const current = (video && video.stream) || {};
      if (!video || (current.token || null) !== (token || null) || ['converting', 'ready'].includes(current.status)) {
        log('Conversion skipped: state changed', { id });
        return null;
      }
      const version = newToken();
      const rungs = renditions(video);
      const stream = {
        status: 'converting',
        token: current.token || newToken(),
        version,
        startedAt: iso(),
        qualities: rungs.map((r) => r.name),
      };
      let jobId;
      try {
        const { CreateJobCommand } = mc();
        const result = await mediaconvert.send(new CreateJobCommand({
          Role: settings.roleArn,
          Settings: jobSettings({ bucket, input: store.videoKey(id, video.ext, video.fileVersion), prefix: store.streamPrefix(id, version), rungs }),
          UserMetadata: { app: APP, videoId: id, version },
          StatusUpdateInterval: 'SECONDS_60',
        }));
        jobId = result.Job.Id;
      } catch (error) {
        console.error(JSON.stringify({ message: 'Could not start conversion', id, error: error.message }));
        return setStream(id, (s) => (s.token || null) === (token || null), failed(`Could not start: ${error.message}`.slice(0, 300)));
      }
      const saved = await setStream(id, (s) => (s.token || null) === (token || null) && !['converting', 'ready'].includes(s.status),
        () => ({ ...stream, jobId }));
      if (!saved) await cancelJob({ status: 'converting', jobId });
      log('Conversion started', { id, jobId, qualities: stream.qualities });
      return saved;
    },

    /** EventBridge "MediaConvert Job State Change" (COMPLETE, ERROR, or CANCELED after a replace or delete). */
    async onJobEvent(detail = {}) {
      const meta = detail.userMetadata || {};
      const id = meta.videoId;
      const { version } = meta;
      if (meta.app !== APP || !ID_PATTERN.test(id || '') || !VERSION_PATTERN.test(version || '')) return;
      const matches = (s) => s.status === 'converting' && s.jobId === detail.jobId && s.version === version;
      let saved = null;
      if (detail.status === 'COMPLETE') {
        saved = await setStream(id, matches, (s) => ({
          status: 'ready', token: s.token, version, startedAt: s.startedAt, finishedAt: iso(), qualities: s.qualities,
        }));
      } else if (detail.status === 'ERROR') {
        saved = await setStream(id, matches, failed(String(detail.errorMessage || `Error ${detail.errorCode || ''}`).slice(0, 300)));
      }
      log('Conversion finished', { id, jobId: detail.jobId, status: detail.status, current: Boolean(saved) });
      // Failed, cancelled or superseded output is never linked; remove it.
      if (!saved || detail.status !== 'COMPLETE') await store.deletePrefix(s3, bucket, store.streamPrefix(id, version));
    },

    /** "Convert now" (or Retry after a failure), for the owner. */
    async convertNow(id) {
      if (!enabled) return { error: 'Streaming conversion is not set up' };
      const index = await store.readIndex(s3, bucket);
      const video = index.videos.find((v) => v.id === id);
      if (!video) return { notFound: true };
      const stream = video.stream || {};
      if (stream.status === 'converting') return { error: 'Already converting' };
      if (stream.status === 'ready') return { error: 'The streaming versions are already made' };
      await unschedule(id);
      const saved = await this.start(id, stream.token);
      if (!saved) return { error: 'The video changed meanwhile; try again' };
      return { video: saved };
    },

    /** After a file is replaced: stop the old conversion, remove its output and schedule the new file. */
    async replaced(id, previous, next) {
      if (previous) {
        await cancelJob(previous);
        await store.deletePrefix(s3, bucket, `h/${id}-`);
        if (previous.status === 'ready') await invalidate([`/h/${id}-*`]);
      }
      if (next) await this.schedule(id, next);
      else if (enabled) await unschedule(id);
    },

    /** After a video is deleted. */
    async removed(id, previous) {
      if (enabled) await unschedule(id);
      await cancelJob(previous);
      await store.deletePrefix(s3, bucket, `h/${id}-`);
    },
  };
}

module.exports = { APP, LADDER, createStreaming, jobSettings, renditions };
