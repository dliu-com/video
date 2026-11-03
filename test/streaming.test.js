const auth = require('../lambda/api/auth');
const { createHandler } = require('../lambda/api/index');
const { renditions, jobSettings } = require('../lambda/api/streaming');
const { createFakeS3 } = require('./fake-s3');

const SITE = 'https://video.dliu.com';
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const HOUR = 3600 * 1000;
const config = { tenantId: 't', clientId: 'c', clientSecret: 'secret', allowedDomain: 'example.com' };
const FUNCTION_ARN = 'arn:aws:lambda:eu-west-1:123456789012:function:video-api';

Object.assign(process.env, {
  SITE_URL: SITE,
  VIDEO_BUCKET: 'video-bucket',
  AWS_REGION: 'eu-west-1',
  AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret',
  MEDIACONVERT_ROLE_ARN: 'arn:aws:iam::123456789012:role/mediaconvert',
  SCHEDULER_ROLE_ARN: 'arn:aws:iam::123456789012:role/scheduler',
  SCHEDULE_GROUP: 'video-streaming',
  CONVERT_DELAY_MINUTES: '120',
});

const session = auth.sign({ typ: 'session', user: 'me@example.com', name: 'Me', exp: Math.floor(NOW / 1000) + 7 * 86400 }, auth.sessionKey(config));

// Records commands; `fail` makes the named command throw the given error once.
function fakeClient(reply = () => ({})) {
  const calls = [];
  const fail = {};
  return {
    calls,
    fail,
    named: (name) => calls.filter((c) => c.name === name).map((c) => c.input),
    async send(command) {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });
      if (fail[name]) {
        const error = fail[name];
        delete fail[name];
        throw error;
      }
      return reply(name, command.input);
    },
  };
}
const notFound = () => Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });

function setup() {
  let now = NOW;
  const s3 = createFakeS3();
  const invalidated = [];
  let jobs = 0;
  const mediaconvert = fakeClient((name) => (name === 'CreateJobCommand' ? { Job: { Id: `job-${++jobs}` } } : {}));
  const scheduler = fakeClient();
  scheduler.fail.UpdateScheduleCommand = notFound();
  const handler = createHandler({
    loadConfig: async () => config, s3, now: () => now, mediaconvert, scheduler,
    invalidate: async (paths) => { invalidated.push(...paths); },
  });
  const context = { invokedFunctionArn: `${FUNCTION_ARN}:live` };
  const call = (method, path, body) => handler({
    rawPath: path,
    requestContext: { http: { method } },
    headers: { origin: SITE },
    cookies: [`${auth.SESSION_COOKIE}=${session}`],
    body: body === undefined ? undefined : JSON.stringify(body),
  }, context).then((r) => ({ ...r, json: r.body ? JSON.parse(r.body) : undefined }));
  const event = (e) => handler(e, context);
  const jobEvent = (job, status, extra = {}) => event({
    'source': 'aws.mediaconvert',
    'detail-type': 'MediaConvert Job State Change',
    'detail': { status, jobId: job.id, userMetadata: job.meta, ...extra },
  });
  const advance = (ms) => { now += ms; };
  return { s3, call, event, jobEvent, invalidated, mediaconvert, scheduler, advance };
}

async function upload(call, s3, overrides = {}) {
  const plan = (await call('POST', '/api/uploads', {
    title: 'Trip', contentType: 'video/mp4', size: 100 * 1024 * 1024, duration: 200, width: 1920, height: 1080, ...overrides,
  })).json;
  const parts = Array.from({ length: plan.partCount }, (_, i) => ({ partNumber: i + 1, etag: `"${'a'.repeat(32)}"` }));
  const done = await call('POST', '/api/uploads/complete', { id: plan.id, uploadId: plan.uploadId, parts });
  expect(done.statusCode).toBe(200);
  return done.json.video;
}

const conversion = async (call, id) => (await call('GET', '/api/videos')).json.videos.find((v) => v.id === id).conversion;
const lastJob = (mediaconvert) => {
  const input = mediaconvert.named('CreateJobCommand').pop();
  return { id: `job-${mediaconvert.named('CreateJobCommand').length}`, meta: input.UserMetadata, input };
};

describe('renditions', () => {
  test('1080p source: 1080p, 720p, 480p and 360p, capped at the source bitrate', () => {
    const rungs = renditions({ width: 1920, height: 1080, size: 110e6, duration: 280 });
    expect(rungs.map((r) => [r.name, r.width, r.height])).toEqual([
      ['1080p', 1920, 1080], ['720p', 1280, 720], ['480p', 854, 480], ['360p', 640, 360],
    ]);
    // 110 MB over 280 s is about 3.1 Mbit/s, below the 1080p maximum.
    expect(rungs[0].maxBitrate).toBe(Math.round((110e6 * 8) / 280));
    expect(rungs[1].maxBitrate).toBe(2500000);
  });

  test('portrait phone video keeps its shape; sizes are the short side', () => {
    expect(renditions({ width: 1080, height: 1920 }).map((r) => [r.name, r.width, r.height])).toEqual([
      ['1080p', 1080, 1920], ['720p', 720, 1280], ['480p', 480, 854], ['360p', 360, 640],
    ]);
  });

  test('never upscales; a rung close to the source size is skipped', () => {
    expect(renditions({ width: 1600, height: 900 }).map((r) => r.name)).toEqual(['900p', '720p', '480p', '360p']);
    expect(renditions({ width: 3840, height: 2160 }).map((r) => r.name)).toEqual(['1080p', '720p', '480p', '360p']);
    expect(renditions({ width: 1280, height: 700 }).map((r) => r.name)).toEqual(['700p', '480p', '360p']);
    expect(renditions({ width: 640, height: 360 }).map((r) => r.name)).toEqual(['360p']);
  });

  test('unknown size: one rendition at the source size', () => {
    const [rung] = renditions({});
    expect(rung).toMatchObject({ name: 'source', width: null, height: null });
    expect(jobSettings({ bucket: 'b', input: 'v/x.mp4', prefix: 'h/x/', rungs: [rung] }).OutputGroups[0].Outputs[0].VideoDescription.Width)
      .toBeUndefined();
  });
});

describe('streaming versions', () => {
  test('an upload is converted 2 hours later; the public JSON links the stream only once it is ready', async () => {
    const { s3, call, event, jobEvent, invalidated, mediaconvert, scheduler, advance } = setup();
    const video = await upload(call, s3);
    expect(video.hls).toBeUndefined();
    expect(JSON.stringify(s3.json(`data/videos/${video.id}.json`))).not.toMatch(/stream|token|conversion/);

    // Update first (it may exist from an earlier upload), then create.
    expect(scheduler.calls.map((c) => c.name)).toEqual(['UpdateScheduleCommand', 'CreateScheduleCommand']);
    const schedule = scheduler.named('CreateScheduleCommand')[0];
    expect(schedule).toMatchObject({
      Name: `video-${video.id}`,
      GroupName: 'video-streaming',
      ScheduleExpression: 'at(2026-10-27T14:00:00)',
      ScheduleExpressionTimezone: 'UTC',
      ActionAfterCompletion: 'DELETE',
      Target: { Arn: FUNCTION_ARN, RoleArn: process.env.SCHEDULER_ROLE_ARN },
    });
    expect(await conversion(call, video.id)).toEqual({ status: 'scheduled', scheduledFor: '2026-10-27T14:00:00.000Z' });

    advance(2 * HOUR);
    expect(await event(JSON.parse(schedule.Target.Input))).toEqual({ ok: true });
    const job = lastJob(mediaconvert);
    expect(job.input.Role).toBe(process.env.MEDIACONVERT_ROLE_ARN);
    expect(job.meta).toMatchObject({ app: 'video.dliu.com', videoId: video.id });
    const group = job.input.Settings.OutputGroups[0];
    expect(job.input.Settings.Inputs[0].FileInput).toBe(`s3://video-bucket${video.src}`);
    expect(group.OutputGroupSettings.HlsGroupSettings.Destination).toBe(`s3://video-bucket/h/${video.id}-${job.meta.version}/index`);
    expect(group.Outputs.map((o) => o.NameModifier)).toEqual(['_1080p', '_720p', '_480p', '_360p']);
    expect(await conversion(call, video.id)).toEqual({
      status: 'converting', startedAt: '2026-10-27T14:00:00.000Z', qualities: ['1080p', '720p', '480p', '360p'],
    });
    expect(s3.json(`data/videos/${video.id}.json`).hls).toBeUndefined();

    // A repeated schedule delivery does not start a second job.
    await event(JSON.parse(schedule.Target.Input));
    expect(mediaconvert.named('CreateJobCommand')).toHaveLength(1);

    advance(5 * 60 * 1000);
    await jobEvent(job, 'COMPLETE');
    expect(s3.json(`data/videos/${video.id}.json`).hls).toBe(`/h/${video.id}-${job.meta.version}/index.m3u8`);
    expect(await conversion(call, video.id)).toEqual({
      status: 'ready', startedAt: '2026-10-27T14:00:00.000Z', finishedAt: '2026-10-27T14:05:00.000Z',
      qualities: ['1080p', '720p', '480p', '360p'],
    });
    expect(invalidated).toEqual([]);
  });

  test('a failed job is reported to the owner, its output removed, and Retry starts again', async () => {
    const { s3, call, jobEvent, mediaconvert } = setup();
    const video = await upload(call, s3);
    expect((await call('POST', '/api/videos/convert', { id: video.id })).json.video.conversion.status).toBe('converting');
    const job = lastJob(mediaconvert);
    s3.put(`h/${video.id}-${job.meta.version}/index_1080p_00001.ts`, 'partial');
    await jobEvent(job, 'ERROR', { errorCode: 1030, errorMessage: 'Input has no video' });
    expect(await conversion(call, video.id)).toMatchObject({ status: 'failed', error: 'Input has no video' });
    expect([...s3.objects.keys()].some((k) => k.startsWith('h/'))).toBe(false);
    expect(s3.json(`data/videos/${video.id}.json`).hls).toBeUndefined();

    const retry = await call('POST', '/api/videos/convert', { id: video.id });
    expect(retry.json.video.conversion.status).toBe('converting');
    expect(mediaconvert.named('CreateJobCommand')).toHaveLength(2);
    expect((await call('POST', '/api/videos/convert', { id: video.id })).statusCode).toBe(400);
  });

  test('Convert now skips the wait; a stale schedule or event changes nothing', async () => {
    const { s3, call, event, jobEvent, mediaconvert, scheduler } = setup();
    const video = await upload(call, s3);
    const schedule = scheduler.named('CreateScheduleCommand')[0];
    await call('POST', '/api/videos/convert', { id: video.id });
    expect(scheduler.named('DeleteScheduleCommand')).toEqual([{ Name: `video-${video.id}`, GroupName: 'video-streaming' }]);
    const job = lastJob(mediaconvert);
    await jobEvent(job, 'COMPLETE');
    expect((await call('POST', '/api/videos/convert', { id: video.id })).statusCode).toBe(400);
    // The schedule fires anyway (for example, it was already running): the video is ready, so no new job.
    await event(JSON.parse(schedule.Target.Input));
    expect(mediaconvert.named('CreateJobCommand')).toHaveLength(1);
    // An event for some other job is ignored.
    await jobEvent({ id: 'job-other', meta: job.meta }, 'ERROR');
    expect(await conversion(call, video.id)).toMatchObject({ status: 'ready' });
    expect((await call('POST', '/api/videos/convert', { id: '2020010100' })).statusCode).toBe(404);
  });

  test('cost caps: jobs are clipped to the declared length, long videos are skipped, 12 hours a day', async () => {
    const { s3, call, mediaconvert, advance } = setup();
    const short = await upload(call, s3, { duration: 200 });
    await call('POST', '/api/videos/convert', { id: short.id });
    expect(lastJob(mediaconvert).input.Settings.Inputs[0].InputClippings).toEqual([{ EndTimecode: '00:04:20:00' }]);

    const long = await upload(call, s3, { duration: 6 * 3600 + 1 });
    const refused = await call('POST', '/api/videos/convert', { id: long.id });
    expect(refused.json.video.conversion).toMatchObject({ status: 'failed', error: 'Videos longer than 6 hours are not converted' });
    expect(mediaconvert.named('CreateJobCommand')).toHaveLength(1);

    const first = await upload(call, s3, { duration: 5 * 3600 });
    const second = await upload(call, s3, { duration: 5 * 3600 });
    const third = await upload(call, s3, { duration: 2 * 3600 });
    await call('POST', '/api/videos/convert', { id: first.id });
    await call('POST', '/api/videos/convert', { id: second.id });
    expect(mediaconvert.named('CreateJobCommand')).toHaveLength(3);
    expect(lastJob(mediaconvert).input.Settings.Inputs[0].InputClippings).toEqual([{ EndTimecode: '05:01:00:00' }]);
    await call('POST', '/api/videos/convert', { id: third.id });
    expect(mediaconvert.named('CreateJobCommand')).toHaveLength(3);
    expect(await conversion(call, third.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('Daily conversion limit') });
    // The next UTC day, Retry works.
    advance(24 * 3600 * 1000);
    expect((await call('POST', '/api/videos/convert', { id: third.id })).json.video.conversion.status).toBe('converting');
    expect(mediaconvert.named('CreateJobCommand')).toHaveLength(4);
  });

  test('an unknown length is clipped at the 6-hour limit', async () => {
    const { s3, call, mediaconvert } = setup();
    const video = await upload(call, s3, { duration: undefined });
    await call('POST', '/api/videos/convert', { id: video.id });
    expect(lastJob(mediaconvert).input.Settings.Inputs[0].InputClippings).toEqual([{ EndTimecode: '06:01:00:00' }]);
  });

  test('replacing the file cancels the conversion, removes the old versions and waits 2 hours again', async () => {
    const { s3, call, jobEvent, invalidated, mediaconvert, scheduler, advance } = setup();
    const video = await upload(call, s3);
    await call('POST', '/api/videos/convert', { id: video.id });
    const first = lastJob(mediaconvert);
    await jobEvent(first, 'COMPLETE');
    s3.put(`h/${video.id}-${first.meta.version}/index.m3u8`, '#EXTM3U');

    advance(HOUR);
    const replaced = await upload(call, s3, { replace: video.id, title: undefined });
    expect(replaced.hls).toBeUndefined();
    expect([...s3.objects.keys()].some((k) => k.startsWith('h/'))).toBe(false);
    expect(invalidated).toContain(`/h/${video.id}-*`);
    expect(await conversion(call, video.id)).toEqual({ status: 'scheduled', scheduledFor: '2026-10-27T15:00:00.000Z' });
    expect(scheduler.named('UpdateScheduleCommand').pop().ScheduleExpression).toBe('at(2026-10-27T15:00:00)');

    // Replaced again while converting: the job is cancelled and its late COMPLETE is ignored.
    await call('POST', '/api/videos/convert', { id: video.id });
    const second = lastJob(mediaconvert);
    await upload(call, s3, { replace: video.id, title: undefined });
    expect(mediaconvert.named('CancelJobCommand')).toEqual([{ Id: second.id }]);
    await jobEvent(second, 'COMPLETE');
    expect(s3.json(`data/videos/${video.id}.json`).hls).toBeUndefined();
    expect(await conversion(call, video.id)).toMatchObject({ status: 'scheduled' });
  });

  test('deleting a video removes its schedule, job and streaming versions', async () => {
    const { s3, call, invalidated, jobEvent, mediaconvert, scheduler } = setup();
    const video = await upload(call, s3);
    await call('POST', '/api/videos/convert', { id: video.id });
    const job = lastJob(mediaconvert);
    await jobEvent(job, 'COMPLETE');
    s3.put(`h/${video.id}-${job.meta.version}/index.m3u8`, '#EXTM3U');
    expect((await call('POST', '/api/videos/delete', { id: video.id })).statusCode).toBe(200);
    expect([...s3.objects.keys()].some((k) => k.startsWith('h/'))).toBe(false);
    expect(scheduler.named('DeleteScheduleCommand').length).toBeGreaterThan(0);
    expect(invalidated).toContain(`/h/${video.id}-*`);
  });

  test('a job that cannot start is shown as failed; other events are ignored', async () => {
    const { s3, call, event, mediaconvert } = setup();
    const video = await upload(call, s3);
    mediaconvert.fail.CreateJobCommand = new Error('AccessDenied');
    const result = await call('POST', '/api/videos/convert', { id: video.id });
    expect(result.json.video.conversion).toMatchObject({ status: 'failed', error: 'Could not start: AccessDenied' });
    expect(await event({ task: 'convert', id: '../x' })).toEqual({ ok: false });
    expect(await event({ hello: 1 })).toEqual({ ok: false });
  });
});
