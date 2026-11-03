// The video player for the watch and embed pages: Plyr controls, with hls.js for the streaming versions.
// The ⚙ menu has Quality (Auto shows the level it is playing), Speed and Download.
// Both libraries are self-hosted (web/vendor/, see scripts/vendor.js) and loaded only when a video is shown.
// If they cannot load, the browser's own controls play the original file.

const PLYR = '3.8.5';
const HLS = '1.7.4';
const VENDOR = '/vendor';

// How far ahead hls.js downloads: enough to ride out a slow network, without fetching the whole video
// for someone who stops watching (the same in every browser, unlike the original file).
const BUFFER = { maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 30 };

const shortSide = (level) => Math.min(level.width || 0, level.height || 0) || level.height || 0;

function addStylesheet() {
  const href = `${VENDOR}/plyr-${PLYR}.css`;
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  // Before style.css, so the site's own rules win.
  const site = document.querySelector('link[href="/style.css"]');
  document.head.insertBefore(link, site);
}

function startAt(media, start) {
  if (start > 0) media.addEventListener('loadedmetadata', () => { media.currentTime = start; }, { once: true });
}

/** Attaches hls.js; resolves once the list of qualities is known, or null when it cannot be used. */
async function attachHls(media, url, start) {
  if (!url || !window.MediaSource) return null;
  let Hls;
  try {
    Hls = (await import(`${VENDOR}/hls.light-${HLS}.min.js`)).default;
  } catch {
    return null;
  }
  if (!Hls.isSupported()) return null;
  const hls = new Hls({
    ...BUFFER,
    workerPath: `${VENDOR}/hls.worker-${HLS}.js`,
    startPosition: start > 0 ? start : -1,
    // Auto never picks more pixels than the player shows (manual choices are not capped).
    capLevelToPlayerSize: true,
  });
  const ready = await new Promise((resolve) => {
    hls.once(Hls.Events.MANIFEST_PARSED, () => resolve(true));
    hls.once(Hls.Events.ERROR, (event, data) => { if (data.fatal) resolve(false); });
    hls.loadSource(url);
    hls.attachMedia(media);
  });
  if (!ready) {
    hls.destroy();
    return null;
  }
  return { hls, Hls };
}

function menuItem(tag, label, attrs = {}) {
  const item = document.createElement(tag);
  item.className = 'plyr__control';
  item.setAttribute('role', 'menuitem');
  for (const [name, value] of Object.entries(attrs)) item.setAttribute(name, value);
  const span = document.createElement('span');
  span.textContent = label;
  item.append(span);
  return item;
}

function fileName(video) {
  const ext = (video.src.match(/\.([a-z0-9]+)$/i) || [, 'mp4'])[1];
  const name = (video.title || video.id).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || video.id;
  return `${name}.${ext}`;
}

/**
 * Sets up `media` (a <video>) to play `video` (the public JSON). Returns { plyr, media } once ready to play.
 * Options: start (seconds), autoplay (muted), muted, loop.
 */
export async function createPlayer(media, video, { start = 0, autoplay = false, muted = false, loop = false } = {}) {
  media.muted = autoplay || muted;
  media.loop = loop;
  if (video.poster) media.poster = video.poster;

  let Plyr = null;
  try {
    addStylesheet();
    Plyr = (await import(`${VENDOR}/plyr-${PLYR}.min.js`)).default;
  } catch {
    // Plain browser controls below.
  }

  // Streaming versions: hls.js where the browser has Media Source (desktop, Android, iPad), Safari's own HLS
  // on iPhone (it picks the quality itself), otherwise the original file.
  const streaming = await attachHls(media, video.hls, start);
  if (!streaming) {
    media.src = video.hls && media.canPlayType('application/vnd.apple.mpegurl') ? video.hls : video.src;
    startAt(media, start);
  }

  if (!Plyr) {
    media.controls = true;
    if (autoplay) media.play().catch(() => {});
    return { plyr: null, media };
  }

  const heights = streaming
    ? [...new Set(streaming.hls.levels.map(shortSide))].filter(Boolean).sort((a, b) => b - a)
    : [];
  const byHeight = (height) => streaming.hls.levels.findIndex((level) => shortSide(level) === height);
  let plyr;

  const autoLabel = (level) => {
    const height = level >= 0 && streaming.hls.levels[level] ? shortSide(streaming.hls.levels[level]) : 0;
    return height ? `Auto (${height}p)` : 'Auto';
  };
  // Shows the level Auto is playing, in the quality list and on the main menu.
  const showAutoLevel = (level) => {
    const label = autoLabel(level);
    plyr.config.i18n.qualityLabel[0] = label;
    const option = plyr.elements.container.querySelector('[data-plyr="quality"][value="0"] > span');
    if (option && option.firstChild) option.firstChild.nodeValue = label;
    const value = plyr.elements.settings.buttons.quality?.querySelector('.plyr__menu__value');
    if (value && plyr.config.quality.selected === 0) value.textContent = label;
  };

  const options = {
    iconUrl: `${VENDOR}/plyr-${PLYR}.svg`,
    blankVideo: '',
    controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'settings', 'fullscreen'],
    settings: heights.length > 1 ? ['quality', 'speed'] : ['speed'],
    speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
    fullscreen: { enabled: true, fallback: true, iosNative: true },
    keyboard: { focused: true, global: false },
    tooltips: { controls: false, seek: true },
    // Every visit starts on Auto and normal speed.
    storage: { enabled: false },
    autoplay,
    muted: media.muted,
    loop: { active: loop },
    i18n: { qualityLabel: { 0: 'Auto' } },
  };
  if (heights.length > 1) {
    options.quality = {
      default: 0,
      options: [0, ...heights],
      forced: true,
      onChange: (height) => {
        if (!plyr) return;
        streaming.hls.currentLevel = height ? byHeight(height) : -1;
        if (!height) showAutoLevel(streaming.hls.currentLevel);
      },
    };
  }
  plyr = new Plyr(media, options);

  if (streaming) {
    const { hls, Hls } = streaming;
    hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
      if (hls.autoLevelEnabled && heights.length > 1) showAutoLevel(data.level);
    });
    let recovered = false;
    hls.on(Hls.Events.ERROR, (event, data) => {
      if (!data.fatal) return;
      if (!recovered && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        recovered = true;
        hls.recoverMediaError();
      } else if (!recovered && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        recovered = true;
        hls.startLoad();
      } else {
        // Give up on streaming and carry on with the original file.
        const time = media.currentTime;
        const paused = media.paused;
        hls.destroy();
        media.src = video.src;
        startAt(media, time);
        if (!paused) media.play().catch(() => {});
      }
    });
  }

  plyr.on('ready', () => {
    const list = plyr.elements.settings?.panels?.home?.querySelector('[role="menu"]');
    if (!list) return;
    const close = () => plyr.elements.buttons.settings?.click();
    const download = menuItem('a', 'Download', { href: video.src, download: fileName(video) });
    download.addEventListener('click', close);
    list.append(download);
  });
  return { plyr, media };
}
