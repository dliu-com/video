// CloudFront Function (cloudfront-js-2.0), viewer-request on the page behaviors.
// Clean URLs: /watch?v=<id> -> /watch.html, /upload -> /upload.html, /embed/<id> -> /embed.html.
var PAGES = { '/watch': '/watch.html', '/upload': '/upload.html' };

function handler(event) {
  var request = event.request;
  var uri = request.uri.length > 1 && request.uri.charAt(request.uri.length - 1) === '/' ? request.uri.slice(0, -1) : request.uri;
  if (/^\/embed\/[A-Za-z0-9_-]{11}$/.test(uri)) {
    request.uri = '/embed.html';
  } else if (Object.prototype.hasOwnProperty.call(PAGES, uri)) {
    request.uri = PAGES[uri];
  }
  return request;
}
