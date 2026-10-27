// CloudFront Function (cloudfront-js-2.0), viewer-request on the page behaviors.
// Clean URLs: /<id> and /watch?v=<id> -> /watch.html, /upload -> /upload.html, /docs -> /docs.html,
// /embed/<id> -> /embed.html. A video ID is yyyymmdd plus a two-digit number, e.g. 2026102700.
var PAGES = { '/watch': '/watch.html', '/upload': '/upload.html', '/docs': '/docs.html' };

function handler(event) {
  var request = event.request;
  var uri = request.uri.length > 1 && request.uri.charAt(request.uri.length - 1) === '/' ? request.uri.slice(0, -1) : request.uri;
  if (/^\/[0-9]{10}$/.test(uri)) {
    request.uri = '/watch.html';
  } else if (/^\/embed\/[0-9]{10}$/.test(uri)) {
    request.uri = '/embed.html';
  } else if (Object.prototype.hasOwnProperty.call(PAGES, uri)) {
    request.uri = PAGES[uri];
  }
  return request;
}
