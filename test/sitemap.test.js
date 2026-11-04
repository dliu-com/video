// /sitemap.xml lists every public, indexable page and is rebuilt by the Lambda whenever a video changes.
const fs = require('fs');
const path = require('path');
const store = require('../lambda/api/store');
const { createFakeS3 } = require('./fake-s3');

const video = (id, createdAt, updatedAt) => ({ id, title: `T ${id}`, description: '', createdAt, updatedAt, ext: 'mp4', duration: 1 });
const index = { videos: [video('2026102700', '2026-10-27T10:00:00Z'), video('2026110300', '2026-11-03T09:00:00Z', '2026-11-03T12:00:00Z')] };

test('the sitemap lists the home page, /docs and each video watch page, newest first, with lastmod', () => {
  const xml = store.sitemapXml(index, 'https://video.dliu.com');
  expect(xml).toBe([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url><loc>https://video.dliu.com/</loc><lastmod>2026-11-03T12:00:00Z</lastmod></url>',
    '  <url><loc>https://video.dliu.com/docs</loc></url>',
    '  <url><loc>https://video.dliu.com/2026110300</loc><lastmod>2026-11-03T12:00:00Z</lastmod></url>',
    '  <url><loc>https://video.dliu.com/2026102700</loc><lastmod>2026-10-27T10:00:00Z</lastmod></url>',
    '</urlset>',
    '',
  ].join('\n'));
  expect(xml).not.toMatch(/upload|embed|auth|api|\.md|\/v\/|\/t\/|\/h\/|\/data\//);
});

test('with no videos the sitemap still lists the home page and /docs', () => {
  expect(store.sitemapXml({ videos: [] }, 'https://video.dliu.com/').match(/<loc>[^<]*<\/loc>/g))
    .toEqual(['<loc>https://video.dliu.com/</loc>', '<loc>https://video.dliu.com/docs</loc>']);
});

test('publish rewrites sitemap.xml with the catalog, as XML that is revalidated on every load', async () => {
  const s3 = createFakeS3();
  await store.publish(s3, 'bucket', index, { changed: ['2026110300'] }, Date.UTC(2026, 10, 4));
  const put = s3.calls.find((c) => c.name === 'PutObjectCommand' && c.input.Key === 'sitemap.xml');
  expect(put.input).toMatchObject({ ContentType: 'application/xml; charset=utf-8', CacheControl: 'no-cache' });
  expect(put.input.Body).toContain('/2026110300</loc>');
  await store.publish(s3, 'bucket', { videos: [index.videos[0]] }, { removed: ['2026110300'] }, Date.UTC(2026, 10, 4));
  const last = s3.calls.filter((c) => c.name === 'PutObjectCommand' && c.input.Key === 'sitemap.xml').pop();
  expect(last.input.Body).not.toContain('2026110300');
});

test('robots.txt allows crawling (the embed player relies on its noindex header) and points at the sitemap', () => {
  const robots = fs.readFileSync(path.join(__dirname, '../web/robots.txt'), 'utf8');
  expect(robots).toMatch(/^User-agent: \*\nAllow: \/\n/);
  expect(robots).toContain('Sitemap: https://video.dliu.com/sitemap.xml');
  // The sitemap comes from the video bucket, not the site files.
  expect(fs.existsSync(path.join(__dirname, '../web/sitemap.xml'))).toBe(false);
});
