// Shared helpers for the video.dliu.com pages.
import { languageSwitcher, locale, t, translateError } from './i18n.js';

export { t };

// The owner hint cookie only decides whether to show owner controls; the API checks the real session.
export const isOwner = () => document.cookie.split(';').some((c) => c.trim() === 'video_owner=1');

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** GET when body is undefined, otherwise POST JSON. CloudFront (OAC) needs the body hash for POSTs to Lambda. */
export async function api(path, body) {
  const init = { credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    const text = JSON.stringify(body);
    init.method = 'POST';
    init.body = text;
    init.headers['content-type'] = 'application/json';
    init.headers['x-amz-content-sha256'] = await sha256Hex(text);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(translateError(data.error || `Request failed (${response.status})`), response.status);
  return data;
}

/** Public JSON written by the API (catalog and video details). Returns null when missing. */
export async function getData(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  // S3 behind CloudFront answers 403 for keys that do not exist.
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(t(`无法加载 ${path}（${response.status}）`, `Could not load ${path} (${response.status})`));
  return response.json();
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Creates an element: el('a', { href: '/' }, 'text', child). Text is always set as text, never as HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export function toast(message) {
  const node = el('div', { class: 'toast', role: 'status' }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), 2500);
}

export async function copyText(text, message = t('已复制', 'Copied')) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast(t('复制失败，请自己选中文字后复制', 'Copy failed; select the text and copy it yourself'));
  }
}

/** Fills the header's nav: Docs for everyone, Upload and Sign out for the owner or Sign in for viewers, then the language switch. */
export function renderNav() {
  const nav = document.querySelector('.dl-header .dl-nav');
  if (!nav) return;
  nav.replaceChildren();
  const docs = el('a', { class: 'dl-button', href: '/docs' }, t('文档', 'Docs'));
  const page = location.pathname.replace(/\/$/, '');
  if (page === '/docs' || page === '/docs/api') docs.setAttribute('aria-current', 'page');
  nav.append(docs);
  if (isOwner()) {
    nav.append(
      el('a', { class: 'dl-button dl-button-primary', href: '/upload' }, t('＋ 上传', '＋ Upload')),
      el('a', { class: 'dl-button', href: '/auth/logout' }, t('退出', 'Sign out')),
    );
  } else {
    nav.append(el('a', { class: 'dl-button dl-signin', href: signInUrl() }, t('登录', 'Sign in')));
  }
  nav.append(languageSwitcher());
}

export const signInUrl = () => `/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`;

/** A poster as a JPEG blob from a playing or seeked <video> (at most 1280 px wide). */
export function captureFrame(video, maxWidth = 1280) {
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t('无法截取画面', 'Could not capture the frame')))), 'image/jpeg', 0.85));
}

/** PUT a blob to a presigned S3 URL. */
export async function putBlob(url, blob, contentType) {
  const response = await fetch(url, { method: 'PUT', body: blob, headers: { 'content-type': contentType } });
  if (!response.ok) throw new Error(t(`上传失败（${response.status}）`, `Upload failed (${response.status})`));
  return response;
}
