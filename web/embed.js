// The embeddable player: /embed/<id>?t=<seconds>&autoplay=1&muted=1&loop=1
import { getData } from './common.js';

const id = location.pathname.split('/').pop() || '';
const params = new URLSearchParams(location.search);
const player = document.getElementById('player');
const message = document.getElementById('message');

async function load() {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error();
  const video = await getData(`/data/videos/${id}.json`);
  if (!video) throw new Error();
  document.title = `${video.title} · dliu.com`;
  const link = document.getElementById('title');
  link.textContent = video.title;
  link.href = `/watch?v=${encodeURIComponent(video.id)}`;
  link.parentElement.hidden = false;

  if (video.poster) player.poster = video.poster;
  // Browsers only autoplay muted video.
  const autoplay = params.get('autoplay') === '1';
  player.muted = autoplay || params.get('muted') === '1';
  player.loop = params.get('loop') === '1';
  player.autoplay = autoplay;
  const start = Number(params.get('t') || params.get('start'));
  if (start > 0) player.addEventListener('loadedmetadata', () => { player.currentTime = start; }, { once: true });
  player.src = video.src;
  player.addEventListener('play', () => document.body.classList.add('playing'));
  player.addEventListener('pause', () => document.body.classList.remove('playing'));
  player.hidden = false;
  message.hidden = true;
}

load().catch(() => {
  message.textContent = 'This video is unavailable.';
});
