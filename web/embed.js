// The embeddable player: /embed/<id>?t=<seconds>&autoplay=1&muted=1&loop=1
import { getData, t } from './common.js';
import { createPlayer } from './player.js';

const id = location.pathname.split('/').pop() || '';
const params = new URLSearchParams(location.search);
const player = document.getElementById('player');
const message = document.getElementById('message');

async function load() {
  if (!/^[0-9]{10}$/.test(id)) throw new Error();
  const video = await getData(`/data/videos/${id}.json`);
  if (!video) throw new Error();
  document.title = `${video.title} · dliu.com`;
  const link = document.getElementById('title');
  link.textContent = video.title;
  link.href = `/${encodeURIComponent(video.id)}`;
  link.parentElement.hidden = false;

  player.addEventListener('play', () => document.body.classList.add('playing'));
  player.addEventListener('pause', () => document.body.classList.remove('playing'));
  player.hidden = false;
  message.hidden = true;
  // Browsers only autoplay muted video.
  await createPlayer(player, video, {
    start: Number(params.get('t') || params.get('start')) || 0,
    autoplay: params.get('autoplay') === '1',
    muted: params.get('muted') === '1',
    loop: params.get('loop') === '1',
  });
}

load().catch(() => {
  message.textContent = t('此视频无法播放。', 'This video is unavailable.');
});
