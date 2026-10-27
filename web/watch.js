import { api, captureFrame, copyText, formatDate, formatSize, getData, isOwner, putBlob, renderNav } from './common.js';

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('v') || '';
let video;

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
  $('edit-description').value = video.description || '';
  const status = $('edit-status');
  const busy = (on) => $('owner').querySelectorAll('button').forEach((b) => { b.disabled = on; });

  $('edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    busy(true);
    status.className = 'muted';
    status.textContent = 'Saving…';
    try {
      const result = await api('/api/videos/update', {
        id: video.id, title: $('edit-title').value, description: $('edit-description').value,
      });
      showVideo(result.video);
      status.className = 'success';
      status.textContent = 'Saved.';
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message;
    } finally {
      busy(false);
    }
  });

  $('poster-frame').addEventListener('click', async () => {
    busy(true);
    status.className = 'muted';
    status.textContent = 'Saving thumbnail…';
    try {
      const player = $('player');
      if (!player.videoWidth) throw new Error('Play or seek the video first.');
      const blob = await captureFrame(player);
      const upload = await api('/api/videos/poster', { id: video.id });
      await putBlob(upload.url, blob, 'image/jpeg');
      const result = await api('/api/videos/update', { id: video.id, posterVersion: upload.version });
      showVideo(result.video);
      player.poster = result.video.poster;
      status.className = 'success';
      status.textContent = 'Thumbnail updated.';
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message;
    } finally {
      busy(false);
    }
  });

  $('delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${video.title}"? This removes the file for good, and embeds of it stop working.`)) return;
    busy(true);
    try {
      await api('/api/videos/delete', { id: video.id });
      location.href = '/';
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message;
      busy(false);
    }
  });
}

async function load() {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Video not found.');
  const data = await getData(`/data/videos/${id}.json`);
  if (!data) throw new Error('Video not found. It may have been deleted.');
  showVideo(data);
  const player = $('player');
  if (data.poster) player.poster = data.poster;
  player.src = data.src;
  const start = Number(new URLSearchParams(location.search).get('t'));
  if (start > 0) player.addEventListener('loadedmetadata', () => { player.currentTime = start; }, { once: true });
  $('status').hidden = true;
  $('video').hidden = false;

  $('share').addEventListener('click', () => copyText(`${location.origin}/watch?v=${video.id}`, 'Link copied'));
  $('embed-toggle').addEventListener('click', () => { $('embed').hidden = !$('embed').hidden; updateEmbed(); });
  for (const box of ['embed-start', 'embed-autoplay', 'embed-loop']) $(box).addEventListener('change', updateEmbed);
  player.addEventListener('pause', updateEmbed);
  $('embed-copy').addEventListener('click', () => copyText($('embed-code').value, 'Embed HTML copied'));
  if (isOwner()) setupOwner();
}

renderNav();
load().catch((error) => {
  $('status').className = 'error';
  $('status').textContent = error.message;
});
