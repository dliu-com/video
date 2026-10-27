const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'functions', 'pages.js'), 'utf8');
const handler = new Function(`${code}\nreturn handler;`)();
const uriFor = (uri) => handler({ request: { uri } }).uri;

describe('pages CloudFront function', () => {
  test.each([
    ['/watch', '/watch.html'],
    ['/watch/', '/watch.html'],
    ['/upload', '/upload.html'],
    ['/docs', '/docs.html'],
    ['/docs/', '/docs.html'],
    ['/2026102700', '/watch.html'],
    ['/2026102700/', '/watch.html'],
    ['/202610270', '/202610270'],
    ['/20261027000', '/20261027000'],
    ['/2026102700.json', '/2026102700.json'],
    ['/embed/2026102700', '/embed.html'],
    ['/embed/2026102700/', '/embed.html'],
    ['/embed/AbC-_123xyz', '/embed/AbC-_123xyz'],
    ['/', '/'],
    ['/style.css', '/style.css'],
    ['/embed/short', '/embed/short'],
    ['/embed/2026102700/extra', '/embed/2026102700/extra'],
    ['/watch.html', '/watch.html'],
    ['/constructor', '/constructor'],
  ])('%s -> %s', (input, expected) => {
    expect(uriFor(input)).toBe(expected);
  });
});
