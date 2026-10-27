import { api, captureFrame, formatDuration, formatSize, isOwner, putBlob, renderNav, signInUrl } from './common.js';

const $ = (id) => document.getElementById(id);
const CONCURRENCY = 4;
const SIGN_BATCH = 20;
const RETRIES = 4;
const TYPES = { mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg' };

let file;
let meta = {};
let posterBlob = null;
let current = null; // the upload in progress: { id, uploadId, cancelled }

function contentTypeOf(f) {
  if (Object.values(TYPES).includes(f.type)) return f.type;
  return TYPES[(f.name.split('.').pop() || '').toLowerCase()] || '';
}

function setStatus(text, kind = 'muted') {
  $('status').className = kind;
  $('status').textContent = text;
}

// Reads duration and size in the browser, and grabs a frame for the thumbnail.
async function probe(f) {
  const video = $('probe');
  const url = URL.createObjectURL(f);
  meta = {};
  posterBlob = null;
  $('poster').removeAttribute('src');
  try {
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('unplayable'));
    });
    meta = { duration: Number.isFinite(video.duration) ? video.duration : undefined, width: video.videoWidth || undefined, height: video.videoHeight || undefined };
    if (video.videoWidth) {
      video.currentTime = Math.min(1, (video.duration || 0) / 10);
      await Promise.race([
        new Promise((resolve) => { video.onseeked = resolve; }),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      posterBlob = await captureFrame(video);
      $('poster').src = URL.createObjectURL(posterBlob);
      $('poster-note').textContent = 'Thumbnail from 1 second in. You can pick another frame on the video page later.';
    } else {
      $('poster-note').textContent = 'Audio only: no thumbnail.';
    }
  } catch {
    $('poster-note').textContent = 'This browser cannot play this file, so viewers may not be able to either. Consider converting it to MP4 (H.264/AAC).';
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function choose(f) {
  if (!f) return;
  if (!contentTypeOf(f)) {
    setStatus('Unsupported file type. Use MP4, M4V, MOV, WebM or OGV.', 'error');
    return;
  }
  file = f;
  setStatus('');
  $('details').hidden = false;
  if (!$('title').value) $('title').value = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
  $('file-info').textContent = `${f.name} · ${formatSize(f.size)}`;
  $('poster-note').textContent = 'Reading the video…';
  await probe(f);
  if (meta.duration) $('file-info').textContent = `${f.name} · ${formatSize(f.size)} · ${formatDuration(meta.duration)}${meta.width ? ` · ${meta.width}×${meta.height}` : ''}`;
}

function putPart(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(Object.assign(new Error(`Part upload failed (${xhr.status})`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new Error('Cancelled'));
    current.xhrs.add(xhr);
    xhr.onloadend = () => current && current.xhrs.delete(xhr);
    xhr.send(blob);
  });
}

async function uploadParts(plan) {
  const loaded = new Array(plan.partCount + 1).fill(0);
  const etags = [];
  const urls = {};
  const started = performance.now();
  const report = () => {
    const done = loaded.reduce((a, b) => a + b, 0);
    const seconds = (performance.now() - started) / 1000;
    const speed = done / Math.max(seconds, 0.1);
    const left = speed > 0 ? (file.size - done) / speed : 0;
    $('bar').style.width = `${((done / file.size) * 100).toFixed(1)}%`;
    $('progress-text').textContent = `${formatSize(done)} of ${formatSize(file.size)} · ${formatSize(speed)}/s · ${formatDuration(left) || '0:00'} left`;
  };

  let signing = null;
  async function urlFor(part, fresh = false) {
    if (fresh) delete urls[part];
    // One signing request at a time; it covers the next SIGN_BATCH parts, so other workers wait for it.
    while (!urls[part]) {
      if (!signing) {
        const wanted = [];
        for (let n = part; n <= plan.partCount && wanted.length < SIGN_BATCH; n += 1) if (!urls[n]) wanted.push(n);
        signing = api('/api/uploads/parts', { id: plan.id, uploadId: plan.uploadId, parts: wanted })
          .then((result) => Object.assign(urls, result.urls))
          .finally(() => { signing = null; });
      }
      await signing;
    }
    return urls[part];
  }

  let next = 1;
  async function worker() {
    while (next <= plan.partCount) {
      const part = next;
      next += 1;
      const blob = file.slice((part - 1) * plan.partSize, Math.min(part * plan.partSize, file.size));
      for (let attempt = 1; ; attempt += 1) {
        if (current.cancelled) throw new Error('Cancelled');
        try {
          // A 403 usually means the signed URL expired, so sign it again.
          const etag = await putPart(await urlFor(part, attempt > 1), blob, (n) => { loaded[part] = n; report(); });
          etags.push({ partNumber: part, etag });
          loaded[part] = blob.size;
          report();
          break;
        } catch (error) {
          loaded[part] = 0;
          if (current.cancelled || attempt >= RETRIES) throw error;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plan.partCount) }, worker));
  return etags;
}

const warnLeave = (event) => { event.preventDefault(); event.returnValue = ''; };

async function submit(event) {
  event.preventDefault();
  if (!file || current) return;
  $('submit').disabled = true;
  $('cancel').hidden = false;
  $('progress-box').hidden = false;
  $('bar').style.width = '0';
  window.addEventListener('beforeunload', warnLeave);
  current = { cancelled: false, xhrs: new Set() };
  try {
    setStatus('Starting…');
    const plan = await api('/api/uploads', {
      title: $('title').value,
      description: $('description').value,
      contentType: contentTypeOf(file),
      size: file.size,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      poster: Boolean(posterBlob),
    });
    Object.assign(current, plan);
    if (plan.posterUrl && posterBlob) await putBlob(plan.posterUrl, posterBlob, 'image/jpeg').catch(() => {});
    setStatus('Uploading… keep this tab open.');
    const parts = await uploadParts(plan);
    setStatus('Finishing…');
    const { video } = await api('/api/uploads/complete', { id: plan.id, uploadId: plan.uploadId, parts });
    window.removeEventListener('beforeunload', warnLeave);
    location.href = `/watch?v=${encodeURIComponent(video.id)}`;
  } catch (error) {
    const plan = current;
    if (plan && plan.uploadId) await api('/api/uploads/abort', { id: plan.id, uploadId: plan.uploadId }).catch(() => {});
    if (error.status === 401) location.href = signInUrl();
    setStatus(plan && plan.cancelled ? 'Upload cancelled.' : `Upload failed: ${error.message}`, plan && plan.cancelled ? 'muted' : 'error');
    $('progress-box').hidden = true;
  } finally {
    current = null;
    $('submit').disabled = false;
    $('cancel').hidden = true;
    window.removeEventListener('beforeunload', warnLeave);
  }
}

if (!isOwner()) {
  location.replace(signInUrl());
} else {
  renderNav();
  $('file').addEventListener('change', () => choose($('file').files[0]));
  const drop = $('drop');
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    if (!current) choose(event.dataTransfer.files[0]);
  });
  $('form').addEventListener('submit', submit);
  $('cancel').addEventListener('click', () => {
    if (!current) return;
    current.cancelled = true;
    current.xhrs.forEach((xhr) => xhr.abort());
  });
}
