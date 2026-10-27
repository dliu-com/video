import { ApiError, api, el, formatDate, formatDuration, getData, isOwner, renderNav } from './common.js';

function card(video) {
  return el('a', { class: 'card', href: `/watch?v=${encodeURIComponent(video.id)}` },
    el('div', { class: 'thumb' },
      video.poster ? el('img', { src: video.poster, alt: '', loading: 'lazy' }) : el('div', { class: 'play' }, '▶'),
      formatDuration(video.duration) ? el('span', { class: 'badge' }, formatDuration(video.duration)) : null),
    el('h3', {}, video.title),
    el('div', { class: 'meta' }, formatDate(video.createdAt)));
}

async function load() {
  const status = document.getElementById('status');
  let videos;
  if (isOwner()) {
    // The API reads the index directly, so the owner sees new uploads without waiting for the catalog cache.
    try {
      videos = (await api('/api/videos')).videos;
      document.getElementById('heading').textContent = 'All videos';
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
      renderNav();
    }
  }
  if (!videos) videos = ((await getData('/data/catalog.json')) || { videos: [] }).videos;

  const grid = document.getElementById('grid');
  grid.replaceChildren(...videos.map(card));
  document.getElementById('count').textContent = videos.length ? `${videos.length} video${videos.length === 1 ? '' : 's'}` : '';
  status.hidden = videos.length > 0;
  status.className = 'empty';
  status.replaceChildren(isOwner() ? el('span', {}, 'No videos yet. ', el('a', { href: '/upload' }, 'Upload one')) : 'No videos yet.');
}

renderNav();
load().catch((error) => {
  const status = document.getElementById('status');
  status.className = 'error';
  status.textContent = error.message;
});
