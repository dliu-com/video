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
    ['/embed/AbC-_123xyz', '/embed.html'],
    ['/embed/AbC-_123xyz/', '/embed.html'],
    ['/', '/'],
    ['/style.css', '/style.css'],
    ['/embed/short', '/embed/short'],
    ['/embed/AbC-_123xyz/extra', '/embed/AbC-_123xyz/extra'],
    ['/watch.html', '/watch.html'],
    ['/constructor', '/constructor'],
  ])('%s -> %s', (input, expected) => {
    expect(uriFor(input)).toBe(expected);
  });
});
