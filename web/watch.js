import { api, captureFrame, copyText, formatDate, formatSize, getData, isOwner, putBlob, renderNav } from './common.js';
import { createPlayer } from './player.js';

const $ = (id) => document.getElementById(id);
// Videos live at /<id>; old-style /watch?v=<id> links are rewritten to that.
const ID_PATTERN = /^[0-9]{10}$/;
const pathId = location.pathname.replace(/^\/|\/$/g, '');
const query = new URLSearchParams(location.search);
const id = ID_PATTERN.test(pathId) ? pathId : query.get('v') || '';
if (id !== pathId && ID_PATTERN.test(id)) {
  query.delete('v');
  history.replaceState(null, '', `/${id}${query.size ? `?${query}` : ''}`);
}
let video;
let plyr = null;

function showVideo(data) {
  video = data;
  document.title = `${data.title} · dliu.com`;
  $('title').textContent = data.title;
  $('meta').textContent = [formatDate(data.createdAt), isOwner() ? formatSize(data.size) : '']
    .filter(Boolean).join(' · ');
  $('description').textContent = data.description || '';
  if (data.width && data.height) $('player').parentElement.style.setProperty('--ratio', String(data.width / data.height));
  updateEmbed();
}

function embedUrl() {
  const params = new URLSearchParams();
  const player = $('player');
  if ($('embed-start').checked && player.currentTime >= 1) params.set('t', String(Math.floor(player.currentTime)));
  if ($('embed-autoplay').checked) params.set('autoplay', '1');
  if ($('embed-loop').checked) params.set('loop', '1');
  const query = params.toString();
  return `${location.origin}/embed/${video.id}${query ? `?${query}` : ''}`;
}

function updateEmbed() {
  if (!video) return;
  const ratio = video.width && video.height ? `${video.width}/${video.height}` : '16/9';
  const title = video.title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const url = embedUrl();
  $('embed-code').value = `<iframe src="${url}" title="${title}" style="width:100%;aspect-ratio:${ratio};border:0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
  $('embed-open').href = url;
}

function setupOwner() {
  $('owner').hidden = false;
  $('edit-title').value = video.title;
  $('replace').href = `/upload?replace=${encodeURIComponent(video.id)}`;
  $('edit-description').value = video.description || '';
  const status = $('edit-status');
  const busy = (on) => $('owner').querySelectorAll('button').forEach((b) => { b.disabled = on; });

  $('edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(true);
    status.className = 'dl-muted';
    status.textContent = 'Saving…';
    try {
      const result = await api('/api/videos/update', {
        id: video.id, title: $('edit-title').value, description: $('edit-description').value,
      });
      showVideo(result.video);
      status.className = 'dl-success';
      status.textContent = 'Saved.';
    } catch (error) {
      status.className = 'dl-error';
      status.textContent = error.message;
    } finally {
      busy(false);
    }
  });

  $('poster-frame').addEventListener('click', async () => {
    busy(true);
    status.className = 'dl-muted';
    status.textContent = 'Saving thumbnail…';
    try {
      const player = $('player');
      if (!player.videoWidth) throw new Error('Play or seek the video first.');
      const blob = await captureFrame(player);
      const upload = await api('/api/videos/poster', { id: video.id });
      await putBlob(upload.url, blob, 'image/jpeg');
      const result = await api('/api/videos/update', { id: video.id, posterVersion: upload.version });
      showVideo(result.video);
      if (plyr) plyr.poster = result.video.poster;
      else player.poster = result.video.poster;
      status.className = 'dl-success';
      status.textContent = 'Thumbnail updated.';
    } catch (error) {
      status.className = 'dl-error';
      status.textContent = error.message;
    } finally {
      busy(false);
    }
  });

  setupConversion();

  $('delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${video.title}"? This removes the file for good, and embeds of it stop working.`)) return;
    busy(true);
    try {
      await api('/api/videos/delete', { id: video.id });
      location.href = '/';
    } catch (error) {
      status.className = 'dl-error';
      status.textContent = error.message;
      busy(false);
    }
  });
}

// ---------- Streaming versions (owner only; guests just get the best version there is) ----------
const UK = 'Europe/London';
function ukTime(iso) {
  const date = new Date(iso);
  const day = (d) => d.toLocaleDateString('en-GB', { timeZone: UK });
  const time = date.toLocaleTimeString('en-GB', { timeZone: UK, hour: '2-digit', minute: '2-digit' });
  return day(date) === day(new Date())
    ? `${time} UK time`
    : `${date.toLocaleDateString('en-GB', { timeZone: UK, day: 'numeric', month: 'short' })} ${time} UK time`;
}
const minutes = (from, to) => Math.max(1, Math.round((new Date(to) - new Date(from)) / 60000));

function conversionText(c) {
  const qualities = (c.qualities || []).join(', ');
  switch (c.status) {
    case 'scheduled': return `Scheduled for ${ukTime(c.scheduledFor)}.`;
    case 'converting': return `Converting since ${ukTime(c.startedAt)}${qualities ? ` (${qualities})` : ''}…`;
    case 'ready': return `Ready: ${qualities}. Converted ${ukTime(c.finishedAt)} (took ${minutes(c.startedAt, c.finishedAt)} min).`;
    case 'failed': return `Conversion failed${c.error ? ` (${c.error})` : ''}, so viewers get the original file.`;
    default: return 'None yet, so viewers get the original file.';
  }
}

function setupConversion() {
  const text = $('conversion');
  const button = $('convert');
  let timer;
  const show = (conversion) => {
    clearTimeout(timer);
    text.className = conversion.status === 'failed' ? 'dl-error' : '';
    text.textContent = conversionText(conversion);
    button.hidden = !['none', 'scheduled', 'failed'].includes(conversion.status);
    button.textContent = conversion.status === 'failed' ? 'Retry' : 'Convert now';
    if (conversion.status === 'converting') timer = setTimeout(refresh, 20000);
  };
  async function refresh() {
    try {
      const { videos } = await api('/api/videos');
      const mine = videos.find((v) => v.id === video.id);
      if (mine) show(mine.conversion);
    } catch (error) {
      text.className = 'dl-error';
      text.textContent = error.message;
    }
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      show((await api('/api/videos/convert', { id: video.id })).video.conversion);
    } catch (error) {
      text.className = 'dl-error';
      text.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  refresh();
}

async function load() {
  if (!ID_PATTERN.test(id)) throw new Error('Video not found.');
  const data = await getData(`/data/videos/${id}.json`);
  if (!data) throw new Error('Video not found. It may have been deleted.');
  showVideo(data);
  const player = $('player');
  $('status').hidden = true;
  $('video').hidden = false;
  ({ plyr } = await createPlayer(player, data, { start: Number(new URLSearchParams(location.search).get('t')) || 0 }));

  $('share').addEventListener('click', () => copyText(`${location.origin}/${video.id}`, 'Link copied'));
  $('embed-toggle').addEventListener('click', () => { $('embed').hidden = !$('embed').hidden; updateEmbed(); });
  for (const box of ['embed-start', 'embed-autoplay', 'embed-loop']) $(box).addEventListener('change', updateEmbed);
  player.addEventListener('pause', updateEmbed);
  $('embed-copy').addEventListener('click', () => copyText($('embed-code').value, 'Embed HTML copied'));
  if (isOwner()) setupOwner();
}

renderNav();
load().catch((error) => {
  $('status').className = 'dl-error';
  $('status').textContent = error.message;
});
