const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const DL_CSS = '<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl.css">';
const DL_ICON = 'https://files.dliu.com/dliu.com/favicon.png';

test('every page loads the shared dliu.com stylesheet before its own', () => {
  for (const html of ['index', 'watch', 'upload', 'docs', 'docs-api', 'embed']) {
    const page = read(`web/${html}.html`);
    expect(page).toContain(DL_CSS);
    expect(page.indexOf(DL_CSS)).toBeLessThan(page.indexOf('<link rel="stylesheet" href="/style.css">'));
  }
});

test('every app page has the shared header with the video logo, and the shared footer with the DL logo', () => {
  for (const html of ['index', 'watch', 'upload', 'docs', 'docs-api']) {
    const page = read(`web/${html}.html`);
    expect(page).toContain('<link rel="icon" href="/logo.svg" type="image/svg+xml">');
    expect(page).toContain('<body class="dl-page">');
    expect(page).toContain('<a class="dl-brand" href="/"><img class="dl-logo" src="/logo.svg" alt="" width="32" height="32">Video</a>');
    expect(page).toMatch(/<main class="dl-main[" ]/);
    expect(page).toMatch(new RegExp(`<footer class="dl-footer">\\s*<a class="dl-footer-logo" href="https://dliu.com" aria-label="dliu.com"><img src="${DL_ICON}"`));
  }
  expect(fs.existsSync(path.join(__dirname, '..', 'web/logo.svg'))).toBe(true);
});

test('docs pages load the shared docs stylesheet and tabs, and the app has no docs stylesheet of its own', () => {
  for (const html of ['docs', 'docs-api']) {
    const page = read(`web/${html}.html`);
    expect(page).toContain('<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl-docs.css">');
    expect(page).toContain('<main class="dl-main dl-docs-main">');
    expect(page).toContain('<nav class="dl-tabs" aria-label="Docs sections">');
    expect(page).not.toContain('/docs.css');
  }
  expect(fs.existsSync(path.join(__dirname, '..', 'web/docs.css'))).toBe(false);
});

test('the app stylesheet leaves the header, buttons and palette to the shared stylesheet', () => {
  const css = read('web/style.css');
  expect(css).not.toMatch(/header\.top|\.brand|^\s*button|\.button\b|--accent:/m);
  expect(css).not.toMatch(/var\(--(bg|panel|panel-2|line|text|muted|accent|accent-2|danger|ok|radius)\)/);
});
