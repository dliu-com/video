import { renderNav, t } from './common.js';
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
    [t('0 台服务器', '0 servers'), t('没人观看时什么都不运行', 'nothing runs while nobody is watching'), 'power'],
    [t('1 个 Lambda', '1 Lambda'), t('只用于登录、管理员修改和转换', 'only for sign-in, owner changes and conversions'), 'lambda'],
    [t('2 个 S3 存储桶', '2 S3 buckets'), t('网站文件，以及视频和视频数据', 'site files, and videos with their data'), 's3'],
    [t('1 个 CloudFront', '1 CloudFront'), t('提供页面、视频和网站 API', 'serves pages, videos and the website API'), 'cloudfront'],
  ]));

  root.append(tiers({
    title: t('组件', 'Components'),
    rows: [
      {
        label: t('用户', 'People'), badge: t('浏览器', 'Browser'), tone: 'untrusted',
        nodes: [
          { icon: 'users', title: t('观众', 'Viewers'), text: t('浏览列表并观看，无需账户', 'Browse the list and watch; no account needed') },
          { icon: 'code', title: t('其他 dliu.com 网站', 'Other dliu.com sites'), text: t('用 <iframe> 显示播放器（嵌入）', 'Show the player in an <iframe> (embed)') },
          { icon: 'user', title: t('管理员', 'Owner'), text: t('用 Microsoft 登录后上传、编辑和删除', 'Signs in with Microsoft to upload, edit and delete') },
        ],
      },
      {
        label: t('CloudFront', 'CloudFront'), badge: t('边缘', 'Edge'), tone: 'edge', link: t('HTTPS，video.dliu.com', 'HTTPS, video.dliu.com'),
        nodes: [
          { icon: 'cloudfront', title: t('分发', 'Distribution'), text: t('TLS 1.2+、安全响应头，在边缘缓存页面、封面和视频数据', 'TLS 1.2+, security headers, caches pages, posters and video bytes at the edge') },
          { icon: 'page', title: t('页面函数', 'Pages function'), text: t('简洁网址：/<id>、/embed/<id>、/upload、/docs', 'Clean URLs: /<id>, /embed/<id>, /upload, /docs') },
          { icon: 'cookie', title: t('访客 ID 函数', 'Visitor ID function'), text: t('与流量监控共用，用于统计访问量', 'Shared with the traffic monitor for visit counts') },
        ],
      },
      {
        label: 'API', badge: t('按需', 'On demand'), tone: 'app', link: t('仅 /api/* 和 /auth/*，由 CloudFront 签名（OAC）', '/api/* and /auth/* only, signed by CloudFront (OAC)'),
        nodes: [
          { icon: 'lambda', title: t('API Lambda', 'API Lambda'), text: t('ARM 上的 Node.js 22，256 MB；负责登录、上传网址、编辑和删除', 'Node.js 22 on ARM, 256 MB; sign-in, upload URLs, edits and deletes') },
          { icon: 'entra', title: t('Microsoft Entra ID', 'Microsoft Entra ID'), text: t('管理员登录（OpenID Connect）', 'Owner sign-in (OpenID Connect)') },
          { icon: 'film', title: t('MediaConvert', 'MediaConvert'), text: t('制作流媒体版本；由一次性 EventBridge 计划启动，通过 EventBridge 规则回报结果', 'Makes the streaming versions; started by a one-time EventBridge schedule, reports back through an EventBridge rule') },
        ],
      },
      {
        label: t('AWS 账户', 'AWS account'), badge: t('私有', 'Private'), tone: 'private', link: t('只能通过 CloudFront 读取；由 Lambda 和预签名上传写入', 'read via CloudFront only; written by the Lambda and presigned uploads'),
        nodes: [
          { icon: 's3', title: t('网站存储桶', 'Site bucket'), text: t('本站的 HTML、CSS 和 JavaScript', 'The HTML, CSS and JavaScript of this site') },
          { icon: 'film', title: t('视频存储桶', 'Video bucket'), text: t('视频、封面和发布的目录 JSON', 'Videos, posters and the published catalog JSON') },
          { icon: 'ssm', title: t('Parameter Store', 'Parameter Store'), text: t('Entra 租户、客户端 ID 和加密的客户端密钥', 'Entra tenant, client ID and encrypted client secret') },
        ],
      },
    ],
    note: t('观众从不调用 Lambda：页面、目录、视频详情、封面和视频都是 CloudFront 从 S3 提供的普通文件。', 'Viewers never call the Lambda: pages, the catalog, video details, posters and videos are all plain files that CloudFront serves from S3.'),
  }));

  add('h2', t('观看视频', 'Watching a video'));
  root.append(flow({
    title: t('观众的浏览器加载了什么', 'What a viewer’s browser loads'),
    numbered: true,
    steps: [
      { icon: 'page', title: t('页面', 'Page'), text: t('从网站存储桶加载 /<id>', '/<id> from the site bucket') },
      { icon: 'code', title: t('详情', 'Details'), text: t('/data/videos/<id>.json：标题、简介、封面', '/data/videos/<id>.json: title, description, poster') },
      { icon: 'eye', title: t('封面', 'Poster'), text: t('/t/<id>-<version>.jpg，缓存一年', '/t/<id>-<version>.jpg, cached for a year') },
      { icon: 'code', title: t('播放器', 'Player'), text: t('/player.js，然后从 /vendor/ 加载 Plyr 和 hls.js，缓存一年', '/player.js, then Plyr and hls.js from /vendor/, cached for a year') },
      { icon: 'play', title: t('视频', 'Video'), text: t('从 /h/<id>-<version>/ 按 6 秒一段加载流媒体版本，或按字节范围加载原始文件', 'Streaming versions from /h/<id>-<version>/ in 6-second pieces, or the original file in byte ranges'), tone: 'good' },
    ],
    note: t('首页读取 /data/catalog.json，即所有视频的列表。视频文件上传后不再改变，所以 CloudFront 和浏览器把它们缓存一年；JSON 文件每次加载都会重新验证，所以修改会立即生效。', 'The home page reads /data/catalog.json, the list of all videos. Video files never change once uploaded, so CloudFront and browsers cache them for a year; the JSON files are revalidated on every load, so edits appear at once.'),
  }));

  add('h2', t('流媒体版本和播放器', 'Streaming versions and the player'));
  add('p', t('每次上传都会由 AWS MediaConvert 转换为 1080p、720p、480p 和 360p 的 HLS（不会超过原文件的尺寸和码率）。文件 2 小时内没有被替换后才开始转换，因为视频在剪辑期间常常要替换好几次；每次替换都会重新计时、取消正在运行的任务，并丢弃用旧文件制作的版本。在版本准备好之前，观众看到的是原始文件。管理员在观看页面能看到转换状态，并可以“立即转换”或“重试”；访客看不到这些。', 'Each upload is converted by AWS MediaConvert into HLS in 1080p, 720p, 480p and 360p (never larger than the file, and never at a higher bitrate). The conversion starts once the file has not been replaced for 2 hours, because a video is often replaced several times while being edited; each replacement restarts the wait, cancels a running job and discards versions made from the old file. Until the versions are ready, viewers get the original file. The owner sees the status on the watch page and can Convert now or Retry; guests do not see it.'));
  add('p', t('播放器是 Plyr 加 hls.js，都由本站提供。画质默认为“自动”，会显示正在播放的画质（例如“自动 (720p)”），根据网速选择画质，且不会超过播放器显示的像素。⚙ 菜单里还有“速度”和“下载”（原始文件）。hls.js 会提前下载 30 到 60 秒，在所有浏览器中都一样。iPhone 上的 Safari 使用自带的 HLS 播放器，自行选择画质。如果播放器库无法加载，就用浏览器自带的控件播放原始文件。', 'The player is Plyr with hls.js, both served from this site. Quality defaults to Auto, which shows the level it is playing (for example "Auto (720p)"), picks a level to suit the connection, and never more pixels than the player shows. The ⚙ menu also has Speed and Download (the original file). hls.js keeps 30 to 60 seconds downloaded ahead, the same in every browser. Safari on iPhone uses its own HLS player and picks the quality itself. If the player libraries cannot load, the browser’s own controls play the original file.'));

  add('h2', t('上传视频', 'Uploading a video'));
  root.append(flow({
    title: t('视频从浏览器直接传到 S3', 'The video goes straight from the browser to S3'),
    numbered: true,
    steps: [
      { icon: 'entra', title: t('登录', 'Sign in'), text: t('Microsoft 登录；Lambda 设置会话 Cookie', 'Microsoft sign-in; the Lambda sets a session cookie') },
      { icon: 'film', title: t('选择文件', 'Choose file'), text: t('页面读取时长和大小，并截取一帧作为封面', 'The page reads the length and size, and grabs a poster frame') },
      { icon: 'key', title: t('上传网址', 'Upload URLs'), text: t('Lambda 开始 S3 分段上传，并为每个分段签发一个网址', 'The Lambda starts an S3 multipart upload and signs one URL per part') },
      { icon: 'upload', title: t('分段传到 S3', 'Parts to S3'), text: t('每段至少 16 MiB，同时传 4 段，直接 PUT 到 S3', 'Parts of 16 MiB or more, 4 at a time, PUT directly to S3') },
      { icon: 'check', title: t('发布', 'Publish'), text: t('Lambda 完成上传并写入目录文件', 'The Lambda completes the upload and writes the catalog files'), tone: 'good' },
    ],
    note: t('Lambda 从不处理视频数据，所以上传最大 50 GiB 的视频也不需要大型或长时间运行的函数。失败的分段会重试；放弃的上传由 S3 生命周期规则清理。', 'The Lambda never handles video bytes, so uploads up to 50 GiB do not need a large or long-running function. Failed parts are retried; an abandoned upload is cleaned up by S3 lifecycle rules.'),
  }));

  add('h2', t('嵌入其他网站', 'Embedding in other sites'));
  add('p', t('每个观看页面都有“嵌入”框，提供可直接粘贴的代码。嵌入页面只有一个填满框架的播放器：', 'Each watch page has an Embed box with ready-to-paste code. The embed page is a bare player that fills its frame:'));
  root.append(code('<iframe src="https://video.dliu.com/embed/<id>" title="…"\n  style="width:100%;aspect-ratio:16/9;border:0"\n  allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>'));
  add('p', t('只有 dliu.com 及其子域名可以嵌入播放器（Content-Security-Policy frame-ancestors）。选项：?autoplay=1（按浏览器要求静音播放）、?muted=1、?loop=1，以及 ?t=<秒数> 从中途开始播放。', 'Only dliu.com and its subdomains may frame the player (Content-Security-Policy frame-ancestors). Options: ?autoplay=1 (muted, as browsers require), ?muted=1, ?loop=1 and ?t=<seconds> to start part way through.'));

  add('h2', t('视频编号', 'Video IDs'));
  add('p', t('视频编号是上传日期（英国时间）加上当天的两位序号：2026102700 是 2026 年 10 月 27 日上传的第一个视频，2026102701 是第二个。它的页面是 video.dliu.com/2026102700。', 'A video’s ID is the date it was uploaded (UK time) followed by a two-digit number for that day: 2026102700 is the first video uploaded on 27 October 2026, 2026102701 the second. Its page is video.dliu.com/2026102700.'));
  add('p', t('每次上传都通过 S3 条件写入预留编号，所以同时开始的两次上传绝不会拿到同一个编号。编号一旦用于发布视频就不会再被使用，即使该视频已删除，因为视频文件会缓存一年，嵌入的地方绝不能变成另一个视频。取消的上传会释放编号。每天最多上传 100 个视频。', 'Each upload reserves its number with a conditional write to S3, so two uploads started at the same moment never get the same one. A number is never reused once a video was published under it, even after that video is deleted, because the video file is cached for a year and embeds must never start showing a different video. A cancelled upload frees its number. Up to 100 videos can be uploaded a day.'));
  add('p', t('管理员可以用更新的文件替换视频。视频保留编号、网址、标题和简介，所以链接和嵌入都会显示新文件；新文件用新的版本名保存，因此不会有缓存继续提供旧文件，旧文件也会被删除。', 'The owner can replace a video with an updated file. The video keeps its number, address, title and description, so links and embeds show the new file; the new file is stored under a new versioned name, so no cache keeps serving the old one, and the old file is deleted.'));

  add('h2', t('网址及其来源', 'URLs and where they come from'));
  root.append(table([t('路径', 'Path'), t('来源', 'Served from'), t('缓存', 'Caching')], [
    [mono('/ /<id> /upload /docs'), t('网站存储桶，经过页面函数（/<id> 提供 watch.html）', 'Site bucket, via the pages function (/<id> serves watch.html)'), t('每次加载都重新验证', 'Revalidated on every load')],
    [mono('/embed/<id>'), t('网站存储桶（embed.html），允许 dliu.com 网站嵌入', 'Site bucket (embed.html), framing allowed for dliu.com sites'), t('每次加载都重新验证', 'Revalidated on every load')],
    [mono('/v/<id>.<ext>'), t('视频存储桶：视频文件；替换的文件使用新版本 /v/<id>-<v>.<ext>', 'Video bucket: the video file; a replacement file gets a new version, /v/<id>-<v>.<ext>'), t('一年，不可变；支持字节范围', 'One year, immutable; byte ranges')],
    [mono('/t/<id>-<v>.jpg'), t('视频存储桶：封面；新封面使用新版本', 'Video bucket: the poster; a new poster gets a new version'), t('一年，不可变', 'One year, immutable')],
    [mono('/data/*.json'), t('视频存储桶：catalog.json 和 videos/<id>.json', 'Video bucket: catalog.json and videos/<id>.json'), t('每次加载都重新验证', 'Revalidated on every load')],
    [mono('/api/* /auth/*'), t('Lambda，通过它的函数网址', 'The Lambda, through its function URL'), t('从不缓存', 'Never cached')],
  ]));

  add('h2', t('清除 CDN 缓存', 'Clearing the CDN'));
  add('p', t('只有视频文件和封面保存在边缘，而且从不以相同名称重写：替换的文件或新封面会使用新的版本名。替换或删除视频时会在 CloudFront 中让旧路径失效。页面、脚本、样式和 JSON 文件每次加载都会重新验证，所以无需清除。', 'Only video files and posters are kept at the edge, and they are never rewritten under the same name: a replacement file or new poster gets a new versioned name. Replacing or deleting a video invalidates the old paths in CloudFront. Pages, scripts, styles and the JSON files are revalidated on every load, so there is nothing to clear.'));
  add('p', t('因此本站没有自动清除（由 S3 事件触发 CloudFront 失效）。那样大多会因新上传而触发，而新上传从未被缓存过，还会用掉所有 dliu.com 网站共用的每月 1,000 条免费失效路径。请通过网站或 API 修改视频，不要用 S3 控制台：以相同名称覆盖的文件会在观众的浏览器里保留长达一年。', 'So this site has no automatic clearing (S3 events triggering CloudFront invalidations). It would mostly fire for new uploads, which were never cached, and would use up the 1,000 free invalidation paths a month that all the dliu.com sites share. Change videos through the website or API, not the S3 console: a file overwritten under the same name stays in viewers’ browsers for up to a year.'));

  add('h2', t('视频存储桶中的数据', 'Data in the video bucket'));
  root.append(table([t('键', 'Key'), t('内容', 'What it holds'), t('公开', 'Public')], [
    [mono('meta/index.json'), t('权威数据：每个视频及其所有字段。使用条件写入，所以两次编辑不会互相覆盖', 'Source of truth: every video with all its fields. Written with conditional writes, so two edits cannot overwrite each other'), t('否', 'No')],
    [mono('data/catalog.json'), t('首页列出的内容：每个视频的编号、标题、时长、封面和日期', 'What the home page lists: id, title, length, poster and date of every video'), t('是', 'Yes')],
    [mono('data/videos/<id>.json'), t('观看和嵌入页面使用的单个视频详情', 'One video’s details for the watch and embed pages'), t('是', 'Yes')],
    [mono('v/<id>.<ext>'), t('上传的原始视频（MP4、WebM 或 QuickTime），存放在 S3 智能分层中', 'The video, as uploaded (MP4, WebM or QuickTime), in S3 Intelligent-Tiering'), t('是', 'Yes')],
    [mono('t/<id>-<v>.jpg'), t('封面（最大 5 MB）', 'The poster (at most 5 MB)'), t('是', 'Yes')],
    [mono('pending/<id>.json'), t('正在进行的上传；完成后删除，或 7 天后由 S3 删除', 'An upload in progress; deleted on completion, or by S3 after 7 days'), t('否', 'No')],
  ]));
  add('p', t('没有数据库。每次修改后，管理员的 API 会重写公开的 JSON 文件；观众只读取文件。', 'There is no database. The owner’s API rewrites the public JSON files after each change; viewers only read files.'), 'dg-note');

  add('h2', t('登录', 'Signing in'));
  root.append(flow({
    title: t('Microsoft Entra ID，带 PKCE 的 OpenID Connect', 'Microsoft Entra ID, OpenID Connect with PKCE'),
    numbered: true,
    steps: [
      { icon: 'user', title: t('登录', 'Sign in'), text: t('/auth/login 把 state、nonce 和 PKCE 校验码存入短时效的签名 Cookie', '/auth/login stores state, nonce and PKCE verifier in a short signed cookie') },
      { icon: 'entra', title: t('Microsoft', 'Microsoft'), text: t('单租户应用注册；用户在那里登录', 'Single-tenant app registration; the user signs in there') },
      { icon: 'lambda', title: t('回调', 'Callback'), text: t('交换授权码；检查 ID 令牌的签名、颁发者、租户、受众、nonce 和邮箱域名', 'Code exchanged; ID token signature, issuer, tenant, audience, nonce and email domain checked') },
      { icon: 'cookie', title: t('会话', 'Session'), text: t('签名的 __Host- Cookie，有效 12 小时', 'Signed __Host- cookie for 12 hours'), tone: 'good' },
    ],
  }));

  add('h2', t('Microsoft 颁发的 API 访问（可选）', 'Microsoft-issued API access (optional)'));
  add('p', t('一个独立的 API Gateway HTTP API 可以接受共享 dliu API 资源的 Microsoft 访问令牌。它复用视频 Lambda，不改变网站登录、公开播放或嵌入。请使用部署输出中的网关端点，而不是网站 API 网址。', 'A separate API Gateway HTTP API can accept Microsoft access tokens for the shared dliu API resource. It reuses the Video Lambda without changing website sign-in, public playback or embeddings. Use the gateway endpoint from the deployment outputs, not the website API URL.'));
  const authDocsLink = document.createElement('a');
  authDocsLink.href = 'https://auth.dliu.com/docs/api';
  authDocsLink.textContent = t('需要身份验证：请按照 Auth API 文档配置请求程序', 'Authentication is required: configure your requester using the Auth API documentation');
  const authParagraph = add('p', '');
  authParagraph.append(authDocsLink);
  add('p', t('令牌获取、凭据存储/查找、过期/续期以及带身份验证的请求设置，都集中记录在 Auth API 文档中。视频网站在 /docs/api 记录自己的路由、权限、请求内容和上传流程。', 'Token acquisition, credential storage/lookup, expiry/renewal and authenticated request setup are documented centrally in the Auth API documentation. Video documents its own routes, permissions, payloads and upload workflow at /docs/api.'));
  add('p', t('共享的应用/客户端 ID 既是资源受众（aud），也是批准的 SPA 客户端（azp）；两个声明仍会分别检查。普通用户通过网关成功调用尚未验证。', 'The shared application/client ID is both the resource audience (aud) and the approved SPA client (azp); both claims are still checked independently. Authenticated standard-user gateway success remains unverified.'));
  root.append(table([t('权限', 'Permission'), t('操作', 'Operations')], [
    [mono('video.read'), t('读取 API 身份并列出视频', 'Read API identity and list videos')],
    [mono('video.write'), t('开始、完成或中止上传；编辑视频和封面', 'Start, complete or abort uploads; edit videos and posters')],
    [mono('video.delete'), t('删除视频', 'Delete videos')],
  ]));
  add('p', t('API Gateway 验证 Microsoft 签名、租户专属的 v2 颁发者、受众、过期时间和路由权限范围。Lambda 还要求批准的客户端，以及 Microsoft 颁发的共享 dliu API 用户角色（值为 api.access）。只有被明确分配的用户才有该角色；管理员在 dliu API 企业应用中管理分配。只分配批准的 dliu.com 账户，不分配访客。没有 API 用户白名单，也没有网站颁发的 API 令牌。', 'API Gateway validates Microsoft signatures, the tenant-specific v2 issuer, audience, expiry and route scopes. The Lambda additionally requires the approved client and the shared dliu API user role (value api.access) issued by Microsoft. Only explicitly assigned users have that role; administrators manage assignments on the dliu API Enterprise application. Assign only approved dliu.com accounts, not guests. There is no API user allowlist or site-issued API token.'));
  add('p', t('把视频部署输出中的 MicrosoftApiUrl 用作已配置请求程序的 VIDEO_API_URL。这是 AWS 生成的 API Gateway 端点；没有配置公开的托管 API 主机名。托管请求不要使用 https://video.dliu.com/api/*：该入口需要单独的网站会话。', 'Use MicrosoftApiUrl from the Video deployment outputs as VIDEO_API_URL for your configured requester. This is the AWS-generated API Gateway endpoint; no public managed API hostname is configured. Do not use https://video.dliu.com/api/* for managed requests: that entry point requires the separate website session.'));
  add('p', t('GET /api/me 和 GET /api/videos 需要 video.read。上传和编辑的 POST 路由需要 video.write；POST /api/videos/delete 需要 video.delete。写入权限不包括删除。API 强制执行 Microsoft 实际颁发的权限范围和已分配用户的 api.access 角色。共享角色本身不授予任何操作；每个路由仍需要对应的视频权限范围。', 'GET /api/me and GET /api/videos need video.read. Upload and edit POST routes need video.write; POST /api/videos/delete needs video.delete. A write permission does not include delete. The API enforces the scopes Microsoft actually issued and the assigned-user api.access role. The shared role grants no operation by itself; each route still needs its exact Video scope.'));
  add('p', t('托管视频代码没有跨 Lambda 调用的全局 Bearer 令牌缓存、API 令牌持久化，也不记录原始 Bearer 请求头或完整事件。复用的 AWS 客户端、网站配置和公开签名密钥缓存都不是 API 令牌缓存。请求内的值和热运行时内存可能保留到垃圾回收；这不是取证级清零保证。', 'Managed Video code has no application-global bearer-token cache, API-token persistence or raw bearer-header/full-event logging across Lambda invocations. Reused AWS clients, website configuration and public signing-key caches are not API-token caches. Request-local values and warm-runtime memory may remain until garbage collection; this is not a forensic zeroization guarantee.'));
  root.append(code('node scripts/api-client.js GET /api/videos'));
  add('p', t('遇到 401 时，请按照 Auth API 文档检查端点和请求程序设置。遇到 403 时，请检查批准的 SPA 客户端、已分配用户的 api.access 角色和所需的路由权限范围。托管请求绝不回退到网站 Cookie。令牌只来自 auth.dliu.com 的中央 Microsoft 登录：只批准唯一配置的客户端 azp。', 'A 401 requires checking the endpoint and requester setup using the Auth API documentation. A 403 requires checking the approved SPA client, the assigned-user api.access role and the required route scope. Managed requests never fall back to website cookies. Tokens come only from Central Microsoft sign-in at auth.dliu.com: only the single configured client azp is approved.'));
  add('p', t('托管 API 已在视频配置中启用。请使用明确批准的部署中的 MicrosoftApiUrl，该部署把共享的应用/客户端 ID 同时配置为受众和批准的客户端。网站会话 Cookie、Microsoft 登录、公开播放和嵌入都保持不变。', 'The managed API is enabled in Video configuration. Use MicrosoftApiUrl from an explicitly approved deployment with the shared application/client ID configured as both audience and approved client. The website session cookies, Microsoft login, public playback and embeds remain unchanged.'));

  root.append(more(t('构建、部署和测试', 'Build, deploy and test'),
    list([
      t('一个 AWS CDK 堆栈（TypeScript）Video，位于 eu-west-1；按 CloudFront 的要求，证书在 us-east-1。make deploy 负责构建和部署。', 'One AWS CDK stack (TypeScript), Video, in eu-west-1; the certificate is in us-east-1 as CloudFront requires. make deploy builds and deploys it.'),
      t('网站文件由堆栈本身上传（BucketDeployment），所以一次部署会同时更新页面和基础设施。', 'The site’s files are uploaded by the stack itself (BucketDeployment), so a deploy updates pages and infrastructure together.'),
      t('Entra ID 和客户端密钥用 make set-secrets 输入一次，保存在 Parameter Store 中，而不是代码库里。', 'The Entra IDs and client secret are entered once with make set-secrets and stored in Parameter Store, not in the repository.'),
      t('单元测试（Jest）覆盖：使用模拟 S3 的 API、与 AWS SDK 签名器对照的预签名网址、页面函数和合成的堆栈。make smoke 在线上网站上传、播放、编辑、嵌入并删除一个测试视频。', 'Unit tests (Jest) cover the API with a fake S3, the presigned URLs against the AWS SDK signer, the pages function and the synthesised stack. make smoke uploads, plays, edits, embeds and deletes a test video on the live site.'),
      t('访问量由中央流量监控（traffic.dliu.com）根据 CloudFront 日志统计；本站不运行任何统计代码。', 'Visits are counted by the central traffic monitor (traffic.dliu.com) from CloudFront’s logs; this site runs no analytics code.'),
    ])));

  source(root, t('源代码：dliu-com/video（lib/video-stack.ts、lambda/api/、web/）。', 'Source: dliu-com/video (lib/video-stack.ts, lambda/api/, web/).'));
}

// ---------------------------------------------------------------- Cost
function cost(root) {
  const add = writer(root);

  root.append(stats([
    ['$0', t('每月固定费用', 'fixed monthly fee'), 'budget'],
    ['≈ $0.023', t('每 GB 视频每月，随视频变旧而降低', 'per GB of video per month, falling as videos age'), 's3'],
    [t('1 TB 免费', '1 TB free'), t('每月 CloudFront 分发流量', 'of CloudFront delivery each month'), 'cloudfront'],
    ['≈ $0.04', t('超出免费额度后，完整观看一次 500 MB 视频', 'per full view of a 500 MB video beyond the free tier'), 'play'],
  ]));

  add('h2', t('各部分的费用', 'What each part costs'));
  add('p', t('价格为 eu-west-1（爱尔兰）的标价。免费额度按 AWS 账户计算，所以与其他 dliu.com 网站共用。', 'Prices are list prices for eu-west-1 (Ireland). Free tiers are per AWS account, so they are shared with the other dliu.com sites.'));
  root.append(table([t('部分', 'Part'), t('计费方式', 'How it is billed'), t('闲置月份', 'Idle month')], [
    [t('S3 视频存储', 'S3 video storage'), t('智能分层：每 GB 每月 $0.023；30 天无人观看后 $0.0125；90 天后 $0.004。监控费每 1,000 个对象 $0.0025；无取回费', 'Intelligent-Tiering: $0.023 per GB-month; $0.0125 after 30 days unwatched; $0.004 after 90 days. $0.0025 per 1,000 objects for monitoring; no retrieval fees'), num('≈ $0.023 / GB')],
    [t('S3 网站文件、封面和 JSON', 'S3 site files, posters and JSON'), t('S3 标准存储中几 MB（每 GB 每月 $0.023）', 'A few MB in S3 Standard ($0.023 per GB-month)'), num('< $0.01')],
    [t('S3 请求', 'S3 requests'), t('每 1,000 次 PUT $0.005（上传时每 16 MiB 分段一次）；CloudFront 缓存未命中时每 1,000 次 GET $0.0004', '$0.005 per 1,000 PUTs (one per 16 MiB part on upload); $0.0004 per 1,000 GETs on CloudFront cache misses'), num('$0')],
    [t('CloudFront', 'CloudFront'), t('每月免费：1 TB 流出流量、1000 万次请求、200 万次函数运行。超出后每 GB $0.085（欧洲和北美），每 10,000 次请求约 $0.01', 'Free each month: 1 TB out, 10 million requests, 2 million function runs. Then $0.085 per GB (Europe and North America) and about $0.01 per 10,000 requests'), num('$0')],
    [t('CloudFront Functions', 'CloudFront Functions'), t('页面函数和访客 ID 函数：免费 200 万次之后每百万次 $0.10', 'Pages and visitor ID functions: $0.10 per million runs after the free 2 million'), num('$0')],
    [t('MediaConvert', 'MediaConvert'), t('基础层、单遍编码：四种流媒体画质合计每分钟视频约 $0.05，每个最终文件只转换一次（5 分钟视频 ≈ $0.25）。闲置时不收费', 'Basic tier, single pass: about $0.05 per minute of video for the four streaming qualities, once per final file (a 5-minute video ≈ $0.25). Nothing while idle'), num('$0')],
    [t('EventBridge Scheduler', 'EventBridge Scheduler'), t('每次上传或替换一个一次性计划；每月 1400 万次免费运行。MediaConvert 任务事件免费', 'One one-time schedule per upload or replacement; 14 million free runs a month. MediaConvert job events are free'), num('$0')],
    [t('API Lambda', 'API Lambda'), t('每百万次调用 $0.20，每 GB 秒 $0.0000133（ARM）。每月免费：100 万次调用和 400,000 GB 秒。观众从不调用它', '$0.20 per million calls and $0.0000133 per GB-second (ARM). Free each month: 1 million calls and 400,000 GB-seconds. Viewers never call it'), num('$0')],
    [t('API Gateway HTTP API（可选）', 'API Gateway HTTP API (optional)'), t('使用 Microsoft 令牌的 API 调用按请求额外计费；无每月固定费用。公开视频播放不使用它', 'Additional per-request charges for Microsoft-token API calls; no fixed monthly fee. Public video playback does not use it'), num('$0')],
    [t('CDN 失效', 'CDN invalidations'), t('每次删除三到四条路径；每月前 1,000 条免费，之后每条 $0.005', 'Three or four paths per delete; the first 1,000 paths a month are free, then $0.005 per path'), num('$0')],
    [t('Parameter Store', 'Parameter Store'), t('标准参数；Lambda 保持热状态时最多每 5 分钟读取一次', 'Standard parameters; read at most every 5 minutes while the Lambda is warm'), num('$0')],
    [t('KMS', 'KMS'), t('由 AWS 托管的 aws/ssm 密钥解密客户端密钥；每月 20,000 次免费请求', 'The AWS-managed aws/ssm key decrypts the client secret; 20,000 free requests a month'), num('$0')],
    [t('CloudWatch 日志', 'CloudWatch Logs'), t('Lambda 日志保留一个月；每 GB $0.57，每月只有几 KB', 'Lambda logs kept one month; $0.57 per GB, a few KB a month'), num('$0')],
    [t('证书（ACM）和 DNS', 'Certificate (ACM) and DNS'), t('公有证书免费；现有 dliu.com 区域中指向 CloudFront 的别名记录查询免费', 'Public certificates are free; alias records to CloudFront answer free in the existing dliu.com zone'), num('$0')],
    [t('流量日志', 'Traffic logs'), t('计入流量监控：每 GB 日志 $0.25', 'Billed to the traffic monitor: $0.25 per GB of log lines'), num('< $0.01')],
  ]));
  root.append(callout('power', t('没有 EC2、容器、负载均衡器、NAT 网关、数据库或 WAF，MediaConvert 也只按转换的分钟数计费，所以没有任何东西仅因存在而花钱。删除所有视频后，账单实际上为 $0。', 'There is no EC2, container, load balancer, NAT gateway, database or WAF, and MediaConvert is billed only per minute converted, so nothing costs money just by existing. Delete every video and the bill is effectively $0.')));

  add('h2', t('示例', 'Examples'));
  root.append(table([t('情况', 'Situation'), t('估算', 'Estimate')], [
    [t('存储 20 个 300 MB 的视频（6 GB），刚上传', 'Storing 20 videos of 300 MB (6 GB), newly uploaded'), num(t('≈ $0.14 / 月', '≈ $0.14 / month'))],
    [t('同样的 6 GB，30 天无人观看后', 'The same 6 GB after 30 days without views'), num(t('≈ $0.08 / 月', '≈ $0.08 / month'))],
    [t('同样的 6 GB，90 天无人观看后', 'The same 6 GB after 90 days without views'), num(t('≈ $0.03 / 月', '≈ $0.03 / month'))],
    [t('上传一个 1 GB 的视频（64 个分段，约 10 次 Lambda 调用）', 'Uploading a 1 GB video (64 parts, about 10 Lambda calls)'), num('≈ $0.0004')],
    [t('一个 500 MB 视频完整观看 1,000 次（0.5 TB，在免费的 1 TB 内）', '1,000 full views of a 500 MB video (0.5 TB, inside the free 1 TB)'), num('$0')],
    [t('超出免费 1 TB 后，每次完整观看 500 MB', 'Each full 500 MB view beyond the free 1 TB'), num('≈ $0.043')],
    [t('打开首页（HTML、CSS、JS、目录、封面）', 'Opening the home page (HTML, CSS, JS, catalog, posters)'), num(t('免费额度内 $0', '$0 in the free tier'))],
  ]));
  add('p', t('只看了一部分的观众只按浏览器下载的部分计费：播放器按 6 秒一段（或按原始文件的字节范围）获取，最多提前约一分钟。手机或慢速网络的观众会得到较小的画质，所以一次观看的费用往往比原始文件大小所显示的更低。', 'A viewer who watches only part of a video is billed only for what the browser downloaded: the player fetches 6-second pieces (or byte ranges of the original file) and keeps at most about a minute ahead. Viewers on phones or slow connections get a smaller quality, so a view often costs less than the original file size suggests.'), 'dg-note');

  root.append(flow({
    title: t('账单为何这么低', 'What keeps the bill small'),
    steps: [
      { icon: 'power', title: t('没有闲置服务器', 'No idle servers'), text: t('Lambda 只在登录和管理员修改时运行', 'The Lambda runs only for sign-in and owner changes') },
      { icon: 'page', title: t('对观众是静态的', 'Static for viewers'), text: t('列表和详情是在有变化时写入的文件', 'Lists and details are files written when something changes') },
      { icon: 'upload', title: t('直接上传', 'Direct uploads'), text: t('视频从浏览器直接传到 S3，从不经过 Lambda', 'Videos go from the browser to S3, never through the Lambda') },
      { icon: 'cloudfront', title: t('边缘缓存', 'Edge cache'), text: t('视频和封面缓存一年；每个边缘节点只读取 S3 一次', 'Videos and posters are cached for a year; S3 is read once per edge') },
      { icon: 's3', title: t('智能分层', 'Intelligent-Tiering'), text: t('没人看的视频会自动转到更便宜的存储', 'Videos nobody watches drop to cheaper storage automatically') },
      { icon: 'clock', title: t('生命周期', 'Lifecycle'), text: t('未完成的上传 2 天后删除', 'Unfinished uploads are removed after 2 days'), tone: 'good' },
    ],
  }));

  add('p', t('CloudFront 从所有边缘站点提供服务（price class All），使用 HTTP/2 和 HTTP/3，因为大多数观众在欧洲和亚洲。在每月免费的 1 TB 之内不额外收费。价格核对于 2026 年 10 月。', 'CloudFront serves from all edge locations (price class All), over HTTP/2 and HTTP/3, because most viewers are in Europe and Asia. Within the free 1 TB a month it costs nothing extra. Prices checked in October 2026.'), 'dg-note');
  source(root, t('源代码：dliu-com/video（lib/video-stack.ts、lambda/api/videos.js）。', 'Source: dliu-com/video (lib/video-stack.ts, lambda/api/videos.js).'));
}

// ---------------------------------------------------------------- Security
function security(root) {
  const add = writer(root);
  const PASS = { text: t('✓ 通过', '✓ Pass'), className: 'status' };
  const LOW = { text: t('低', 'Low'), className: 'risk-low' };
  const MEDIUM = { text: t('中', 'Medium'), className: 'risk-medium' };

  root.append(callout('shield', t('2026 年 10 月 27 日针对线上网站进行了审查和测试。以下每项检查都已通过。', 'Reviewed and tested against the live site on 27 October 2026. Every check below passed.')));

  root.append(tiers({
    title: t('信任边界', 'Trust boundaries'),
    rows: [
      {
        label: t('任何人', 'Anyone'), badge: t('不受信任', 'Untrusted'), tone: 'untrusted',
        nodes: [
          { icon: 'users', title: t('观众和其他网站', 'Viewers and other sites'), text: t('可以读取每个已发布的视频及其详情；如果在 dliu.com 上，还可以嵌入播放器', 'Can read every published video and its details, and frame the player if they are on dliu.com') },
          { icon: 'bot', title: t('攻击者', 'Attackers'), text: t('可以直接调用 video.dliu.com、它的 /api 和 /auth 路径以及 AWS 端点', 'Can call video.dliu.com, its /api and /auth paths, and AWS endpoints directly') },
        ],
      },
      {
        label: t('CloudFront', 'CloudFront'), badge: t('边缘', 'Edge'), tone: 'edge', link: t('仅 HTTPS', 'HTTPS only'),
        nodes: [
          { icon: 'cloudfront', title: t('分发', 'Distribution'), text: t('TLS 1.2+、安全响应头，除 /api 外只允许 GET 和 HEAD', 'TLS 1.2+, security headers, only GET and HEAD except on /api') },
          { icon: 'page', title: t('私有文件', 'Private files'), text: t('视频存储桶中只能访问 v/、t/ 和 data/；meta/ 和 pending/ 不能访问', 'Only v/, t/ and data/ are reachable in the video bucket; meta/ and pending/ are not') },
        ],
      },
      {
        label: t('API Lambda', 'API Lambda'), badge: 'API', tone: 'app', link: t('由 CloudFront 签名（IAM、OAC）', 'signed by CloudFront (IAM, OAC)'),
        nodes: [
          { icon: 'lock', title: t('会话检查', 'Session check'), text: t('网站的 /api 调用需要签名会话；修改还需要 Origin 为 https://video.dliu.com。可选网关则使用 Microsoft 令牌、权限范围和已分配用户角色', 'Website /api calls need a signed session; changes also need Origin https://video.dliu.com. The optional gateway uses Microsoft tokens, scopes and assigned-user roles instead') },
          { icon: 'filter', title: t('输入检查', 'Input checks'), text: t('写入任何内容之前先验证编号、标题、大小、文件类型和分段号', 'IDs, titles, sizes, file types and part numbers validated before anything is written') },
        ],
      },
      {
        label: t('AWS 账户', 'AWS account'), badge: t('私有', 'Private'), tone: 'private', link: t('最小权限角色', 'least-privilege role'),
        nodes: [
          { icon: 's3', title: t('存储桶', 'Buckets'), text: t('阻止所有公开访问、加密、仅 HTTPS；CloudFront 只能读取', 'All public access blocked, encrypted, HTTPS only; CloudFront may only read') },
          { icon: 'ssm', title: t('Parameter Store', 'Parameter Store'), text: t('客户端密钥加密存储，从不写在代码中', 'Client secret stored encrypted, never in code') },
          { icon: 'entra', title: t('Microsoft Entra ID', 'Microsoft Entra ID'), text: t('决定谁可以登录（需要分配）', 'Decides who may sign in (assignment required)') },
        ],
      },
    ],
    note: t('观众本来就应该看到所有已发布的内容，所以重点是保护修改：只有管理员可以上传、编辑或删除，而且只能通过 Lambda。', 'Viewers are meant to see everything that is published, so the job is to protect changes: only the owner may upload, edit or delete, and only through the Lambda.'),
  }));

  add('h2', t('限制', 'Limits'));
  add('p', t('以下历史线上检查针对网站入口。可选的 Microsoft 令牌 API 还会在 API Gateway 拒绝缺失或无效的令牌，并要求委托权限范围、批准的客户端和已分配用户的 api.access 角色。浏览器 Cookie 无法绕过这些检查。', 'The historical live checks below cover the website entry point. The optional Microsoft-token API additionally rejects missing/invalid tokens at API Gateway and requires delegated scopes, the approved client and the assigned-user api.access role. Browser cookies cannot bypass these checks.'));
  root.append(stats([
    [t('12 小时', '12 hours'), t('会话有效期', 'session lifetime'), 'lock'],
    [t('1 小时', '1 hour'), t('每个上传网址的有效期', 'lifetime of each upload URL'), 'key'],
    ['50 GiB', t('最大视频', 'largest video'), 'film'],
    ['5 MB', t('最大封面', 'largest poster'), 'eye'],
  ]));

  add('h2', t('线上渗透测试', 'Live penetration test'));
  add('p', t('每项测试都用 curl、openssl 和一个小型 Node 脚本针对 https://video.dliu.com 运行；登录状态的测试使用了真实的短时会话。', 'Each test was run against https://video.dliu.com with curl, openssl and a small Node script; the signed-in tests used a real, short-lived session.'));
  root.append(table([t('测试', 'Test'), t('结果', 'Result'), t('状态', 'Status')], [
    [t('HTTP 降级', 'HTTP downgrade'), t('http:// 返回 301 跳转到 https://；HSTS 设置为一年', 'http:// answers 301 to https://; HSTS is set for one year'), PASS],
    [t('旧版 TLS', 'Old TLS versions'), t('拒绝 TLS 1.0 和 1.1', 'TLS 1.0 and 1.1 are refused'), PASS],
    [t('安全响应头', 'Security headers'), t('CSP 只允许来自本站的脚本和样式（无内联代码）；nosniff；严格的 Referrer 策略；Permissions-Policy 禁止摄像头、麦克风、位置、支付和 USB', 'CSP allows scripts and styles only from the site itself (no inline code); nosniff; strict referrer policy; Permissions-Policy blocks camera, microphone, location, payment and USB'), PASS],
    [t('嵌入框架', 'Framing'), t('页面：frame-ancestors self 和 X-Frame-Options SAMEORIGIN。嵌入播放器：只允许 dliu.com 及其子域名，并标记为 noindex', "Pages: frame-ancestors 'self' and X-Frame-Options SAMEORIGIN. The embed player: only dliu.com and its subdomains, and it is marked noindex"), PASS],
    [t('隐藏文件', 'Hidden files'), t('/.git/config、/.env、package.json、cdk.json、meta/index.json 和 pending/ 返回 403；不列出目录', '/.git/config, /.env, package.json, cdk.json, meta/index.json and pending/ return 403; no directory listing'), PASS],
    [t('页面上的其他 HTTP 方法', 'Other HTTP methods on pages'), t('POST、PUT、DELETE 和 PATCH 返回 403', 'POST, PUT, DELETE and PATCH return 403'), PASS],
    [t('无会话调用 API', 'API without a session'), t('/api/me 和 /api/videos 返回 401；没有会话的修改被拒绝', '/api/me and /api/videos return 401; changes without a session are refused'), PASS],
    [t('伪造会话', 'Forged sessions'), t('未签名、过期、签名错误和被篡改的 Cookie 返回 401', 'Unsigned, expired, wrongly signed and edited cookies return 401'), PASS],
    [t('跨站修改（CSRF）', 'Cross-site changes (CSRF)'), t('有效会话但 Origin 为 evil.example、blog.dliu.com 或没有 Origin 时返回 403', 'A valid session with Origin evil.example, blog.dliu.com or no Origin gets 403'), PASS],
    [t('登录回调', 'Sign-in callback'), t('缺失或伪造的 state 返回 400；返回地址必须是本站路径，因此没有开放重定向', 'Missing or forged state returns 400; return addresses must be paths on this site, so there is no open redirect'), PASS],
    [t('编号中的路径技巧', 'Path tricks in IDs'), t('../meta/index 或 __proto__ 之类的视频编号返回 400；未知编号返回 404', 'Video IDs such as ../meta/index or __proto__ return 400; unknown IDs 404'), PASS],
    [t('上传检查', 'Upload checks'), t('超过 200 个字符的标题、超过 50 GiB 或小于 1 字节的大小，以及 text/html 等非视频类型返回 400', 'Titles over 200 characters, sizes over 50 GiB or below 1 byte, and non-video types such as text/html return 400'), PASS],
    [t('格式错误的请求', 'Malformed requests'), t('错误的 JSON 返回 400；超过 64 KB 的请求体被拒绝；对修改端点发送 GET 不会有任何作用', 'Bad JSON returns 400; bodies over 64 KB are refused; GET on a change endpoint does nothing'), PASS],
    [t('绕过 CloudFront', 'Bypassing CloudFront'), t('直接调用 Lambda 函数网址和 S3 存储桶返回 403', 'The Lambda function URL and the S3 bucket return 403 when called directly'), PASS],
    [t('脚本注入', 'Script injection'), t('标题和简介用 textContent 显示，从不作为 HTML，并在嵌入代码中转义', 'Titles and descriptions are shown with textContent, never as HTML, and escaped in the embed code'), PASS],
    [t('公开代码库中的机密', 'Secrets in the public repo'), t('扫描了完整的 git 历史：没有密钥、账户、租户或客户端 ID', 'Full git history scanned: no secrets, account, tenant or client IDs'), PASS],
    [t('依赖', 'Dependencies'), t('Lambda 只使用 Node.js 和运行时自带的 AWS SDK。唯一的第三方代码是浏览器中的播放器（Plyr 和 hls.js），以固定版本复制到本站，不从其他服务器加载', 'The Lambda uses only Node.js and the AWS SDK included in the runtime. The only third-party code is the player (Plyr and hls.js) in the browser, copied into this site at fixed versions, not loaded from another server'), PASS],
  ]));

  add('h2', t('威胁模型', 'Threat model'));
  root.append(table([t('场景', 'Scenario'), t('剩余风险', 'Residual risk'), t('控制措施', 'Controls')], [
    [t('管理员以外的人上传、编辑或删除视频', 'Someone other than the owner uploads, edits or deletes a video'), LOW, t('每次修改都需要用 Entra 客户端密钥派生的密钥签名的会话 Cookie；只有单租户应用中已分配的用户才能登录，Lambda 还会检查 @dliu.com 邮箱域名', 'Every change needs a session cookie signed with a key derived from the Entra client secret; sign-in is limited to assigned users of a single-tenant app, and the Lambda also checks the @dliu.com email domain')],
    [t('会话 Cookie 被伪造或盗用', 'A session cookie is forged or stolen'), LOW, t('HMAC-SHA256 签名以恒定时间比较，12 小时过期，HttpOnly、Secure、SameSite=Lax 和 __Host- 前缀，所以其他 dliu.com 子域名无法设置或读取它', 'HMAC-SHA256 signature compared in constant time, 12-hour expiry, HttpOnly, Secure, SameSite=Lax and the __Host- prefix, so other dliu.com subdomains cannot set or read it')],
    [t('登录 CSRF、授权码拦截或开放重定向', 'Login CSRF, code interception or an open redirect'), LOW, t('state、nonce 和 PKCE（S256）存于短时效签名 Cookie；固定的重定向 URI；检查 ID 令牌签名（Microsoft 的密钥）、颁发者、租户、受众和过期时间；返回路径限制在本站', 'state, nonce and PKCE (S256) in a short-lived signed cookie; fixed redirect URI; ID token signature (Microsoft’s keys), issuer, tenant, audience and expiry checked; return path restricted to this site')],
    [t('其他网站诱使已登录的管理员删除或修改视频（CSRF）', 'Another site makes the signed-in owner delete or change a video (CSRF)'), LOW, t('修改都是 POST 请求，需要会话 Cookie（SameSite=Lax 下不会跨站发送）以及正好为 https://video.dliu.com 的 Origin 请求头', 'Changes are POSTs that need the session cookie (not sent cross-site with SameSite=Lax) and an Origin header of exactly https://video.dliu.com')],
    [t('恶意标题或简介在观众页面上运行脚本（XSS）', 'A malicious title or description runs script on viewers’ pages (XSS)'), LOW, t('所有文字都用 textContent 设置；CSP 不允许内联或第三方脚本；嵌入代码会转义标题', 'All text is set with textContent; CSP allows no inline or third-party scripts; the embed code escapes the title')],
    [t('伪装成视频的文件被当作网页提供', 'A file disguised as a video is served as a web page'), LOW, t('只接受 video/mp4、video/webm 和 video/quicktime，并由 Lambda 在开始上传时设定存储的内容类型；视频带 nosniff 从页面不使用的路径提供', 'Only video/mp4, video/webm and video/quicktime are accepted, and the Lambda sets the stored content type when it starts the upload; videos are served with nosniff from a path no page uses')],
    [t('上传网址被重复利用来覆盖其他文件', 'Upload URLs are reused to overwrite other files'), LOW, t('每个网址只为一个键、一个上传 ID 和分段号签名，一小时后过期；键由 Lambda 决定，从不由浏览器决定', 'Each URL is signed for one key, one upload ID and part number, and expires after an hour; the Lambda chooses the key, never the browser')],
    [t('绕过 CloudFront 调用 Lambda 或存储桶', 'The Lambda or buckets are called without CloudFront'), LOW, t('函数网址需要 IAM 认证，只授权给本 CloudFront 分发；存储桶阻止公开访问，只允许 CloudFront 读取', 'The function URL requires IAM auth, given only to this CloudFront distribution; buckets block public access and allow CloudFront to read only')],
    [t('观众读取未发布的数据', 'Viewers read unpublished data'), LOW, t('CloudFront 不提供 meta/ 和 pending/；只提供 v/、t/ 和 data/', 'meta/ and pending/ are not served by CloudFront; only v/, t/ and data/ are')],
    [t('播放器被未知网站嵌入，用于点击劫持或盗用带宽', 'The player is framed by an unknown site for clickjacking or to reuse bandwidth'), LOW, t('frame-ancestors 只允许 dliu.com 及其子域名；页面还会发送 X-Frame-Options SAMEORIGIN', 'frame-ancestors allows only dliu.com and its subdomains; pages also send X-Frame-Options SAMEORIGIN')],
    [t('有人从其他网站盗链视频文件，推高账单', 'Someone hot-links video files from another site to run up the bill'), MEDIUM, t('视频网址按设计是公开的，以便分享和嵌入；1 TB 免费额度足以承担日常使用；没有速率限制或 WAF', 'Video URLs are public by design so they can be shared and embedded; the 1 TB free tier absorbs ordinary use; there is no rate limit or WAF')],
    [t('大量请求涌向 /api 或 /auth', 'Floods of requests to /api or /auth'), MEDIUM, t('未认证的调用以很低成本返回 401，Lambda 也没有固定费用，但每次调用仍会运行它；没有 WAF', 'Unauthenticated calls return 401 cheaply and the Lambda has no fixed cost, but every call still runs it; there is no WAF')],
    [t('已删除的视频仍可访问', 'A deleted video is still reachable'), LOW, t('删除会移除文件并在 CloudFront 中让其路径失效；已经下载了文件的浏览器会保留副本', 'Delete removes the files and invalidates their paths in CloudFront; browsers that already downloaded the file keep their copy')],
    [t('机密通过公开代码库泄露', 'Secrets leak through the public repository'), LOW, t('客户端密钥、租户和客户端 ID 存放在 Parameter Store（密钥用 KMS 加密），运行时读取；已扫描 git 历史', 'The client secret, tenant and client IDs live in Parameter Store (secret encrypted with KMS) and are read at run time; git history scanned')],
    [t('数据丢失', 'Data is lost'), LOW, t('删除堆栈时会保留视频存储桶；meta/index.json 使用条件写入更新，所以并发编辑不会丢失修改', 'The video bucket is retained if the stack is deleted; meta/index.json is updated with conditional writes so concurrent edits cannot lose changes')],
  ]));

  add('h2', t('接受的剩余风险', 'Accepted residual risks'));
  root.append(list([
    t('已发布的视频是公开的。任何有链接的人都能下载；没有私密或不公开列出的视频。', 'Published videos are public. Anyone with a link can download them; there are no private or unlisted videos.'),
    t('没有 WAF 或速率限制；超出免费额度后，大量观看或盗链按 GB 付费。', 'There is no WAF or rate limit; heavy viewing or hot-linking is paid for per GB after the free tier.'),
    t('会话无法在服务器端撤销；被盗的 Cookie 在过期前（最多 12 小时）一直有效。轮换客户端密钥会撤销所有会话。', 'Sessions cannot be revoked on the server; a stolen cookie works until it expires (at most 12 hours). Rotating the client secret revokes all sessions.'),
    t('退出登录是一个普通链接，所以其他网站可以让管理员退出登录。除此之外无法以这种方式触发任何操作。', 'Sign-out is a plain link, so another site could sign the owner out. Nothing else can be triggered that way.'),
    t('上传的视频不经过扫描。原始文件保持公开、可下载；流媒体版本由 MediaConvert 从它制作。', 'Uploaded videos are not scanned. The original file stays public and downloadable; the streaming versions are made from it by MediaConvert.'),
  ]));

  root.append(more(t('每个页面的响应头', 'Response headers on every page'),
    table([t('响应头', 'Header'), t('值', 'Value')], [
      [mono('Content-Security-Policy'), "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' <video bucket>; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"],
      [mono('Strict-Transport-Security'), 'max-age=31536000'],
      [mono('X-Frame-Options'), t('SAMEORIGIN（嵌入播放器除外）', 'SAMEORIGIN (not on the embed player)')],
      [mono('X-Content-Type-Options'), 'nosniff'],
      [mono('Referrer-Policy'), 'strict-origin-when-cross-origin'],
      [mono('Permissions-Policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
      [mono('X-Robots-Tag'), t('noindex（仅嵌入播放器）', 'noindex (embed player only)')],
    ])));

  source(root, t('源代码：dliu-com/video（lib/video-stack.ts、lambda/api/auth.js、lambda/api/index.js）。', 'Source: dliu-com/video (lib/video-stack.ts, lambda/api/auth.js, lambda/api/index.js).'));
}

architecture(document.getElementById('architecture'));
cost(document.getElementById('cost'));
security(document.getElementById('security'));

function show(scroll) {
  const current = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : TABS[0];
  for (const id of TABS) document.getElementById(id).hidden = id !== current;
  for (const link of document.querySelectorAll('.dl-tabs a')) {
    if (link.dataset.tab === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const titles = { architecture: t('技术架构', 'Technical architecture'), cost: t('运行成本', 'Cost'), security: t('安全', 'Security') };
  document.title = `${titles[current]} · ${t('文档 · DL 视频', 'Docs · DL video')} · dliu.com`;
  if (scroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => show(true));
show(false);
