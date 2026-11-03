import { api, captureFrame, copyText, formatDate, formatSize, getData, isOwner, putBlob, renderNav, t } from './common.js';
import { lang } from './i18n.js';
import { createPlayer, fileName } from './player.js';

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
  $('download').href = data.src;
  $('download').download = fileName(data);
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
    status.textContent = t('正在保存…', 'Saving…');
    try {
      const result = await api('/api/videos/update', {
        id: video.id, title: $('edit-title').value, description: $('edit-description').value,
      });
      showVideo(result.video);
      status.className = 'dl-success';
      status.textContent = t('已保存。', 'Saved.');
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
    status.textContent = t('正在保存缩略图…', 'Saving thumbnail…');
    try {
      const player = $('player');
      if (!player.videoWidth) throw new Error(t('请先播放视频或拖动到某个画面。', 'Play or seek the video first.'));
      const blob = await captureFrame(player);
      const upload = await api('/api/videos/poster', { id: video.id });
      await putBlob(upload.url, blob, 'image/jpeg');
      const result = await api('/api/videos/update', { id: video.id, posterVersion: upload.version });
      showVideo(result.video);
      if (plyr) plyr.poster = result.video.poster;
      else player.poster = result.video.poster;
      status.className = 'dl-success';
      status.textContent = t('缩略图已更新。', 'Thumbnail updated.');
    } catch (error) {
      status.className = 'dl-error';
      status.textContent = error.message;
    } finally {
      busy(false);
    }
  });

  setupConversion();

  $('delete').addEventListener('click', async () => {
    if (!confirm(t(`删除“${video.title}”？文件会被永久删除，嵌入的播放器也会失效。`,
      `Delete "${video.title}"? This removes the file for good, and embeds of it stop working.`))) return;
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
  const today = day(date) === day(new Date());
  if (lang === 'zh') {
    const datePart = today ? '' : `${date.toLocaleDateString('zh-CN', { timeZone: UK, month: 'long', day: 'numeric' })} `;
    return `英国时间 ${datePart}${time}`;
  }
  return today
    ? `${time} UK time`
    : `${date.toLocaleDateString('en-GB', { timeZone: UK, day: 'numeric', month: 'short' })} ${time} UK time`;
}
const minutes = (from, to) => Math.max(1, Math.round((new Date(to) - new Date(from)) / 60000));

function conversionText(c) {
  const qualities = (c.qualities || []).join(', ');
  switch (c.status) {
    case 'scheduled': return t(`计划于 ${ukTime(c.scheduledFor)} 开始转换。`, `Scheduled for ${ukTime(c.scheduledFor)}.`);
    case 'converting': return t(`自 ${ukTime(c.startedAt)} 起正在转换${qualities ? `（${qualities}）` : ''}…`,
      `Converting since ${ukTime(c.startedAt)}${qualities ? ` (${qualities})` : ''}…`);
    case 'ready': return t(`已就绪：${qualities}。于 ${ukTime(c.finishedAt)} 转换完成（用时 ${minutes(c.startedAt, c.finishedAt)} 分钟）。`,
      `Ready: ${qualities}. Converted ${ukTime(c.finishedAt)} (took ${minutes(c.startedAt, c.finishedAt)} min).`);
    case 'failed': return t(`转换失败${c.error ? `（${c.error}）` : ''}，观众看到的是原始文件。`,
      `Conversion failed${c.error ? ` (${c.error})` : ''}, so viewers get the original file.`);
    default: return t('还没有，观众看到的是原始文件。', 'None yet, so viewers get the original file.');
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
    button.textContent = conversion.status === 'failed' ? t('重试', 'Retry') : t('立即转换', 'Convert now');
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
  if (!ID_PATTERN.test(id)) throw new Error(t('找不到视频。', 'Video not found.'));
  const data = await getData(`/data/videos/${id}.json`);
  if (!data) throw new Error(t('找不到视频，可能已被删除。', 'Video not found. It may have been deleted.'));
  showVideo(data);
  const player = $('player');
  $('status').hidden = true;
  $('video').hidden = false;
  ({ plyr } = await createPlayer(player, data, { start: Number(new URLSearchParams(location.search).get('t')) || 0 }));

  $('share').addEventListener('click', () => copyText(`${location.origin}/${video.id}`, t('链接已复制', 'Link copied')));
  $('embed-toggle').addEventListener('click', () => { $('embed').hidden = !$('embed').hidden; updateEmbed(); });
  for (const box of ['embed-start', 'embed-autoplay', 'embed-loop']) $(box).addEventListener('change', updateEmbed);
  player.addEventListener('pause', updateEmbed);
  $('embed-copy').addEventListener('click', () => copyText($('embed-code').value, t('嵌入 HTML 已复制', 'Embed HTML copied')));
  if (isOwner()) setupOwner();
}

renderNav();
load().catch((error) => {
  $('status').className = 'dl-error';
  $('status').textContent = error.message;
});
