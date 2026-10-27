import { renderNav } from './common.js';
import { flow, tiers, stats, table, callout, more } from './diagram.js';

renderNav();

const TABS = ['architecture', 'cost', 'security'];
const num = (text) => ({ text, className: 'num' });
const mono = (text) => ({ text, className: 'mono' });

function writer(root) {
  return (tag, text, className) => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    root.append(node);
    return node;
  };
}

function list(items) {
  const ul = document.createElement('ul');
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    ul.append(li);
  }
  return ul;
}

function code(text) {
  const pre = document.createElement('pre');
  pre.className = 'code';
  pre.textContent = text;
  return pre;
}

function source(root, text) {
  const footer = document.createElement('p');
  footer.className = 'source';
  footer.textContent = text;
  root.append(footer);
}

// ---------------------------------------------------------------- Architecture
function architecture(root) {
  const add = writer(root);

  root.append(stats([
    ['0 servers', 'nothing runs while nobody is watching', 'power'],
    ['1 Lambda', 'only for sign-in and owner changes', 'lambda'],
    ['2 S3 buckets', 'site files, and videos with their data', 's3'],
    ['1 CloudFront', 'serves every page, video and API call', 'cloudfront'],
  ]));

  root.append(tiers({
    title: 'Components',
    rows: [
      {
        label: 'People', badge: 'Browser', tone: 'untrusted',
        nodes: [
          { icon: 'users', title: 'Viewers', text: 'Browse the list and watch; no account needed' },
          { icon: 'code', title: 'Other dliu.com sites', text: 'Show the player in an <iframe> (embed)' },
          { icon: 'user', title: 'Owner', text: 'Signs in with Microsoft to upload, edit and delete' },
        ],
      },
      {
        label: 'CloudFront', badge: 'Edge', tone: 'edge', link: 'HTTPS, video.dliu.com',
        nodes: [
          { icon: 'cloudfront', title: 'Distribution', text: 'TLS 1.2+, security headers, caches pages, posters and video bytes at the edge' },
          { icon: 'page', title: 'Pages function', text: 'Clean URLs: /<id>, /embed/<id>, /upload, /docs' },
          { icon: 'cookie', title: 'Visitor ID function', text: 'Shared with the traffic monitor for visit counts' },
        ],
      },
      {
        label: 'API', badge: 'On demand', tone: 'app', link: '/api/* and /auth/* only, signed by CloudFront (OAC)',
        nodes: [
          { icon: 'lambda', title: 'API Lambda', text: 'Node.js 22 on ARM, 256 MB; sign-in, upload URLs, edits and deletes' },
          { icon: 'entra', title: 'Microsoft Entra ID', text: 'Owner sign-in (OpenID Connect)' },
        ],
      },
      {
        label: 'AWS account', badge: 'Private', tone: 'private', link: 'read via CloudFront only; written by the Lambda and presigned uploads',
        nodes: [
          { icon: 's3', title: 'Site bucket', text: 'The HTML, CSS and JavaScript of this site' },
          { icon: 'film', title: 'Video bucket', text: 'Videos, posters and the published catalog JSON' },
          { icon: 'ssm', title: 'Parameter Store', text: 'Entra tenant, client ID and encrypted client secret' },
        ],
      },
    ],
    note: 'Viewers never call the Lambda: pages, the catalog, video details, posters and videos are all plain files that CloudFront serves from S3.',
  }));

  add('h2', 'Watching a video');
  root.append(flow({
    title: 'What a viewer’s browser loads',
    numbered: true,
    steps: [
      { icon: 'page', title: 'Page', text: '/<id> from the site bucket' },
      { icon: 'code', title: 'Details', text: '/data/videos/<id>.json: title, description, poster' },
      { icon: 'eye', title: 'Poster', text: '/t/<id>-<version>.jpg, cached for a year' },
      { icon: 'play', title: 'Video', text: '/v/<id>.mp4 in byte ranges, so seeking works at once', tone: 'good' },
    ],
    note: 'The home page reads /data/catalog.json, the list of all videos. Video files never change once uploaded, so CloudFront and browsers cache them for a year; the JSON files are revalidated on every load, so edits appear at once.',
  }));

  add('h2', 'Uploading a video');
  root.append(flow({
    title: 'The video goes straight from the browser to S3',
    numbered: true,
    steps: [
      { icon: 'entra', title: 'Sign in', text: 'Microsoft sign-in; the Lambda sets a session cookie' },
      { icon: 'film', title: 'Choose file', text: 'The page reads the length and size, and grabs a poster frame' },
      { icon: 'key', title: 'Upload URLs', text: 'The Lambda starts an S3 multipart upload and signs one URL per part' },
      { icon: 'upload', title: 'Parts to S3', text: 'Parts of 16 MiB or more, 4 at a time, PUT directly to S3' },
      { icon: 'check', title: 'Publish', text: 'The Lambda completes the upload and writes the catalog files', tone: 'good' },
    ],
    note: 'The Lambda never handles video bytes, so uploads up to 50 GiB do not need a large or long-running function. Failed parts are retried; an abandoned upload is cleaned up by S3 lifecycle rules.',
  }));

  add('h2', 'Embedding in other sites');
  add('p', 'Each watch page has an Embed box with ready-to-paste code. The embed page is a bare player that fills its frame:');
  root.append(code('<iframe src="https://video.dliu.com/embed/<id>" title="…"\n  style="width:100%;aspect-ratio:16/9;border:0"\n  allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>'));
  add('p', 'Only dliu.com and its subdomains may frame the player (Content-Security-Policy frame-ancestors). Options: ?autoplay=1 (muted, as browsers require), ?muted=1, ?loop=1 and ?t=<seconds> to start part way through.');

  add('h2', 'Video IDs');
  add('p', 'A video’s ID is the date it was uploaded (UK time) followed by a two-digit number for that day: 2026102700 is the first video uploaded on 27 October 2026, 2026102701 the second. Its page is video.dliu.com/2026102700.');
  add('p', 'Each upload reserves its number with a conditional write to S3, so two uploads started at the same moment never get the same one. A number is never reused once a video was published under it, even after that video is deleted, because the video file is cached for a year and embeds must never start showing a different video. A cancelled upload frees its number. Up to 100 videos can be uploaded a day.');

  add('h2', 'URLs and where they come from');
  root.append(table(['Path', 'Served from', 'Caching'], [
    [mono('/ /<id> /upload /docs'), 'Site bucket, via the pages function (/<id> serves watch.html)', 'Revalidated on every load'],
    [mono('/embed/<id>'), 'Site bucket (embed.html), framing allowed for dliu.com sites', 'Revalidated on every load'],
    [mono('/v/<id>.<ext>'), 'Video bucket: the video file', 'One year, immutable; byte ranges'],
    [mono('/t/<id>-<v>.jpg'), 'Video bucket: the poster; a new poster gets a new version', 'One year, immutable'],
    [mono('/data/*.json'), 'Video bucket: catalog.json and videos/<id>.json', 'Revalidated on every load'],
    [mono('/api/* /auth/*'), 'The Lambda, through its function URL', 'Never cached'],
  ]));

  add('h2', 'Data in the video bucket');
  root.append(table(['Key', 'What it holds', 'Public'], [
    [mono('meta/index.json'), 'Source of truth: every video with all its fields. Written with conditional writes, so two edits cannot overwrite each other', 'No'],
    [mono('data/catalog.json'), 'What the home page lists: id, title, length, poster and date of every video', 'Yes'],
    [mono('data/videos/<id>.json'), 'One video’s details for the watch and embed pages', 'Yes'],
    [mono('v/<id>.<ext>'), 'The video, as uploaded (MP4, WebM or QuickTime), in S3 Intelligent-Tiering', 'Yes'],
    [mono('t/<id>-<v>.jpg'), 'The poster (at most 5 MB)', 'Yes'],
    [mono('pending/<id>.json'), 'An upload in progress; deleted on completion, or by S3 after 7 days', 'No'],
  ]));
  add('p', 'There is no database. The owner’s API rewrites the public JSON files after each change; viewers only read files.', 'dg-note');

  add('h2', 'Signing in');
  root.append(flow({
    title: 'Microsoft Entra ID, OpenID Connect with PKCE',
    numbered: true,
    steps: [
      { icon: 'user', title: 'Sign in', text: '/auth/login stores state, nonce and PKCE verifier in a short signed cookie' },
      { icon: 'entra', title: 'Microsoft', text: 'Single-tenant app registration; the user signs in there' },
      { icon: 'lambda', title: 'Callback', text: 'Code exchanged; ID token signature, issuer, tenant, audience, nonce and email domain checked' },
      { icon: 'cookie', title: 'Session', text: 'Signed __Host- cookie for 12 hours', tone: 'good' },
    ],
  }));

  root.append(more('Build, deploy and test',
    list([
      'One AWS CDK stack (TypeScript), Video, in eu-west-1; the certificate is in us-east-1 as CloudFront requires. make deploy builds and deploys it.',
      'The site’s files are uploaded by the stack itself (BucketDeployment), so a deploy updates pages and infrastructure together.',
      'The Entra IDs and client secret are entered once with make set-secrets and stored in Parameter Store, not in the repository.',
      'Unit tests (Jest) cover the API with a fake S3, the presigned URLs against the AWS SDK signer, the pages function and the synthesised stack. make smoke uploads, plays, edits, embeds and deletes a test video on the live site.',
      'Visits are counted by the central traffic monitor (traffic.dliu.com) from CloudFront’s logs; this site runs no analytics code.',
    ])));

  source(root, 'Source: dliu-com/video (lib/video-stack.ts, lambda/api/, web/).');
}

// ---------------------------------------------------------------- Cost
function cost(root) {
  const add = writer(root);

  root.append(stats([
    ['$0', 'fixed monthly fee', 'budget'],
    ['≈ $0.023', 'per GB of video per month, falling as videos age', 's3'],
    ['1 TB free', 'of CloudFront delivery each month', 'cloudfront'],
    ['≈ $0.04', 'per full view of a 500 MB video beyond the free tier', 'play'],
  ]));

  add('h2', 'What each part costs');
  add('p', 'Prices are list prices for eu-west-1 (Ireland). Free tiers are per AWS account, so they are shared with the other dliu.com sites.');
  root.append(table(['Part', 'How it is billed', 'Idle month'], [
    ['S3 video storage', 'Intelligent-Tiering: $0.023 per GB-month; $0.0125 after 30 days unwatched; $0.004 after 90 days. $0.0025 per 1,000 objects for monitoring; no retrieval fees', num('≈ $0.023 / GB')],
    ['S3 site files, posters and JSON', 'A few MB in S3 Standard ($0.023 per GB-month)', num('< $0.01')],
    ['S3 requests', '$0.005 per 1,000 PUTs (one per 16 MiB part on upload); $0.0004 per 1,000 GETs on CloudFront cache misses', num('$0')],
    ['CloudFront', 'Free each month: 1 TB out, 10 million requests, 2 million function runs. Then $0.085 per GB (Europe and North America) and about $0.01 per 10,000 requests', num('$0')],
    ['CloudFront Functions', 'Pages and visitor ID functions: $0.10 per million runs after the free 2 million', num('$0')],
    ['API Lambda', '$0.20 per million calls and $0.0000133 per GB-second (ARM). Free each month: 1 million calls and 400,000 GB-seconds. Viewers never call it', num('$0')],
    ['CDN invalidations', 'Three paths per delete; the first 1,000 paths a month are free, then $0.005 per path', num('$0')],
    ['Parameter Store', 'Standard parameters; read at most every 5 minutes while the Lambda is warm', num('$0')],
    ['KMS', 'The AWS-managed aws/ssm key decrypts the client secret; 20,000 free requests a month', num('$0')],
    ['CloudWatch Logs', 'Lambda logs kept one month; $0.57 per GB, a few KB a month', num('$0')],
    ['Certificate (ACM) and DNS', 'Public certificates are free; alias records to CloudFront answer free in the existing dliu.com zone', num('$0')],
    ['Traffic logs', 'Billed to the traffic monitor: $0.25 per GB of log lines', num('< $0.01')],
  ]));
  root.append(callout('power', 'There is no EC2, container, load balancer, NAT gateway, database, WAF or transcoding service, so nothing costs money just by existing. Delete every video and the bill is effectively $0.'));

  add('h2', 'Examples');
  root.append(table(['Situation', 'Estimate'], [
    ['Storing 20 videos of 300 MB (6 GB), newly uploaded', num('≈ $0.14 / month')],
    ['The same 6 GB after 30 days without views', num('≈ $0.08 / month')],
    ['The same 6 GB after 90 days without views', num('≈ $0.03 / month')],
    ['Uploading a 1 GB video (64 parts, about 10 Lambda calls)', num('≈ $0.0004')],
    ['1,000 full views of a 500 MB video (0.5 TB, inside the free 1 TB)', num('$0')],
    ['Each full 500 MB view beyond the free 1 TB', num('≈ $0.043')],
    ['Opening the home page (HTML, CSS, JS, catalog, posters)', num('$0 in the free tier')],
  ]));
  add('p', 'A viewer who watches only part of a video is billed only for what the browser downloaded, because the player fetches the file in byte ranges.', 'dg-note');

  root.append(flow({
    title: 'What keeps the bill small',
    steps: [
      { icon: 'power', title: 'No idle servers', text: 'The Lambda runs only for sign-in and owner changes' },
      { icon: 'page', title: 'Static for viewers', text: 'Lists and details are files written when something changes' },
      { icon: 'upload', title: 'Direct uploads', text: 'Videos go from the browser to S3, never through the Lambda' },
      { icon: 'cloudfront', title: 'Edge cache', text: 'Videos and posters are cached for a year; S3 is read once per edge' },
      { icon: 's3', title: 'Intelligent-Tiering', text: 'Videos nobody watches drop to cheaper storage automatically' },
      { icon: 'clock', title: 'Lifecycle', text: 'Unfinished uploads are removed after 2 days', tone: 'good' },
    ],
  }));

  add('p', 'CloudFront uses price class 100 (edge locations in North America, Europe and Israel), the cheapest. Viewers elsewhere still play videos, from the nearest of those locations. Prices checked in October 2026.', 'dg-note');
  source(root, 'Source: dliu-com/video (lib/video-stack.ts, lambda/api/videos.js).');
}

// ---------------------------------------------------------------- Security
function security(root) {
  const add = writer(root);
  const PASS = { text: '✓ Pass', className: 'status' };
  const LOW = { text: 'Low', className: 'risk-low' };
  const MEDIUM = { text: 'Medium', className: 'risk-medium' };

  root.append(callout('shield', 'Reviewed and tested against the live site on 27 October 2026. Every check below passed.'));

  root.append(tiers({
    title: 'Trust boundaries',
    rows: [
      {
        label: 'Anyone', badge: 'Untrusted', tone: 'untrusted',
        nodes: [
          { icon: 'users', title: 'Viewers and other sites', text: 'Can read every published video and its details, and frame the player if they are on dliu.com' },
          { icon: 'bot', title: 'Attackers', text: 'Can call video.dliu.com, its /api and /auth paths, and AWS endpoints directly' },
        ],
      },
      {
        label: 'CloudFront', badge: 'Edge', tone: 'edge', link: 'HTTPS only',
        nodes: [
          { icon: 'cloudfront', title: 'Distribution', text: 'TLS 1.2+, security headers, only GET and HEAD except on /api' },
          { icon: 'page', title: 'Private files', text: 'Only v/, t/ and data/ are reachable in the video bucket; meta/ and pending/ are not' },
        ],
      },
      {
        label: 'API Lambda', badge: 'API', tone: 'app', link: 'signed by CloudFront (IAM, OAC)',
        nodes: [
          { icon: 'lock', title: 'Session check', text: 'Every /api call needs a valid signed session; changes also need Origin https://video.dliu.com' },
          { icon: 'filter', title: 'Input checks', text: 'IDs, titles, sizes, file types and part numbers validated before anything is written' },
        ],
      },
      {
        label: 'AWS account', badge: 'Private', tone: 'private', link: 'least-privilege role',
        nodes: [
          { icon: 's3', title: 'Buckets', text: 'All public access blocked, encrypted, HTTPS only; CloudFront may only read' },
          { icon: 'ssm', title: 'Parameter Store', text: 'Client secret stored encrypted, never in code' },
          { icon: 'entra', title: 'Microsoft Entra ID', text: 'Decides who may sign in (assignment required)' },
        ],
      },
    ],
    note: 'Viewers are meant to see everything that is published, so the job is to protect changes: only the owner may upload, edit or delete, and only through the Lambda.',
  }));

  add('h2', 'Limits');
  root.append(stats([
    ['12 hours', 'session lifetime', 'lock'],
    ['1 hour', 'lifetime of each upload URL', 'key'],
    ['50 GiB', 'largest video', 'film'],
    ['5 MB', 'largest poster', 'eye'],
  ]));

  add('h2', 'Live penetration test');
  add('p', 'Each test was run against https://video.dliu.com with curl, openssl and a small Node script; the signed-in tests used a real, short-lived session.');
  root.append(table(['Test', 'Result', 'Status'], [
    ['HTTP downgrade', 'http:// answers 301 to https://; HSTS is set for one year', PASS],
    ['Old TLS versions', 'TLS 1.0 and 1.1 are refused', PASS],
    ['Security headers', 'CSP allows scripts and styles only from the site itself (no inline code); nosniff; strict referrer policy; Permissions-Policy blocks camera, microphone, location, payment and USB', PASS],
    ['Framing', "Pages: frame-ancestors 'self' and X-Frame-Options SAMEORIGIN. The embed player: only dliu.com and its subdomains, and it is marked noindex", PASS],
    ['Hidden files', '/.git/config, /.env, package.json, cdk.json, meta/index.json and pending/ return 403; no directory listing', PASS],
    ['Other HTTP methods on pages', 'POST, PUT, DELETE and PATCH return 403', PASS],
    ['API without a session', '/api/me and /api/videos return 401; changes without a session are refused', PASS],
    ['Forged sessions', 'Unsigned, expired, wrongly signed and edited cookies return 401', PASS],
    ['Cross-site changes (CSRF)', 'A valid session with Origin evil.example, blog.dliu.com or no Origin gets 403', PASS],
    ['Sign-in callback', 'Missing or forged state returns 400; return addresses must be paths on this site, so there is no open redirect', PASS],
    ['Path tricks in IDs', 'Video IDs such as ../meta/index or __proto__ return 400; unknown IDs 404', PASS],
    ['Upload checks', 'Titles over 200 characters, sizes over 50 GiB or below 1 byte, and non-video types such as text/html return 400', PASS],
    ['Malformed requests', 'Bad JSON returns 400; bodies over 64 KB are refused; GET on a change endpoint does nothing', PASS],
    ['Bypassing CloudFront', 'The Lambda function URL and the S3 bucket return 403 when called directly', PASS],
    ['Script injection', 'Titles and descriptions are shown with textContent, never as HTML, and escaped in the embed code', PASS],
    ['Secrets in the public repo', 'Full git history scanned: no secrets, account, tenant or client IDs', PASS],
    ['Dependencies', 'The Lambda uses only Node.js and the AWS SDK included in the runtime; no third-party packages run in production or in the browser', PASS],
  ]));

  add('h2', 'Threat model');
  root.append(table(['Scenario', 'Residual risk', 'Controls'], [
    ['Someone other than the owner uploads, edits or deletes a video', LOW, 'Every change needs a session cookie signed with a key derived from the Entra client secret; sign-in is limited to assigned users of a single-tenant app, and the Lambda also checks the @dliu.com email domain'],
    ['A session cookie is forged or stolen', LOW, 'HMAC-SHA256 signature compared in constant time, 12-hour expiry, HttpOnly, Secure, SameSite=Lax and the __Host- prefix, so other dliu.com subdomains cannot set or read it'],
    ['Login CSRF, code interception or an open redirect', LOW, 'state, nonce and PKCE (S256) in a short-lived signed cookie; fixed redirect URI; ID token signature (Microsoft’s keys), issuer, tenant, audience and expiry checked; return path restricted to this site'],
    ['Another site makes the signed-in owner delete or change a video (CSRF)', LOW, 'Changes are POSTs that need the session cookie (not sent cross-site with SameSite=Lax) and an Origin header of exactly https://video.dliu.com'],
    ['A malicious title or description runs script on viewers’ pages (XSS)', LOW, 'All text is set with textContent; CSP allows no inline or third-party scripts; the embed code escapes the title'],
    ['A file disguised as a video is served as a web page', LOW, 'Only video/mp4, video/webm and video/quicktime are accepted, and the Lambda sets the stored content type when it starts the upload; videos are served with nosniff from a path no page uses'],
    ['Upload URLs are reused to overwrite other files', LOW, 'Each URL is signed for one key, one upload ID and part number, and expires after an hour; the Lambda chooses the key, never the browser'],
    ['The Lambda or buckets are called without CloudFront', LOW, 'The function URL requires IAM auth, given only to this CloudFront distribution; buckets block public access and allow CloudFront to read only'],
    ['Viewers read unpublished data', LOW, 'meta/ and pending/ are not served by CloudFront; only v/, t/ and data/ are'],
    ['The player is framed by an unknown site for clickjacking or to reuse bandwidth', LOW, 'frame-ancestors allows only dliu.com and its subdomains; pages also send X-Frame-Options SAMEORIGIN'],
    ['Someone hot-links video files from another site to run up the bill', MEDIUM, 'Video URLs are public by design so they can be shared and embedded; the 1 TB free tier absorbs ordinary use; there is no rate limit or WAF'],
    ['Floods of requests to /api or /auth', MEDIUM, 'Unauthenticated calls return 401 cheaply and the Lambda has no fixed cost, but every call still runs it; there is no WAF'],
    ['A deleted video is still reachable', LOW, 'Delete removes the files and invalidates their paths in CloudFront; browsers that already downloaded the file keep their copy'],
    ['Secrets leak through the public repository', LOW, 'The client secret, tenant and client IDs live in Parameter Store (secret encrypted with KMS) and are read at run time; git history scanned'],
    ['Data is lost', LOW, 'The video bucket is retained if the stack is deleted; meta/index.json is updated with conditional writes so concurrent edits cannot lose changes'],
  ]));

  add('h2', 'Accepted residual risks');
  root.append(list([
    'Published videos are public. Anyone with a link can download them; there are no private or unlisted videos.',
    'There is no WAF or rate limit; heavy viewing or hot-linking is paid for per GB after the free tier.',
    'Sessions cannot be revoked on the server; a stolen cookie works until it expires (at most 12 hours). Rotating the client secret revokes all sessions.',
    'Sign-out is a plain link, so another site could sign the owner out. Nothing else can be triggered that way.',
    'Uploaded videos are not scanned or transcoded; they are served exactly as uploaded.',
  ]));

  root.append(more('Response headers on every page',
    table(['Header', 'Value'], [
      [mono('Content-Security-Policy'), "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' <video bucket>; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"],
      [mono('Strict-Transport-Security'), 'max-age=31536000'],
      [mono('X-Frame-Options'), 'SAMEORIGIN (not on the embed player)'],
      [mono('X-Content-Type-Options'), 'nosniff'],
      [mono('Referrer-Policy'), 'strict-origin-when-cross-origin'],
      [mono('Permissions-Policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
      [mono('X-Robots-Tag'), 'noindex (embed player only)'],
    ])));

  source(root, 'Source: dliu-com/video (lib/video-stack.ts, lambda/api/auth.js, lambda/api/index.js).');
}

architecture(document.getElementById('architecture'));
cost(document.getElementById('cost'));
security(document.getElementById('security'));

function show(scroll) {
  const current = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : TABS[0];
  for (const id of TABS) document.getElementById(id).hidden = id !== current;
  for (const link of document.querySelectorAll('.info-tabs a')) {
    if (link.dataset.tab === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const titles = { architecture: 'Technical architecture', cost: 'Cost', security: 'Security' };
  document.title = `${titles[current]} · Docs · Videos · dliu.com`;
  if (scroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => show(true));
show(false);
