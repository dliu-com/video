# video.dliu.com health checks

How [status.dliu.com](https://status.dliu.com) tests https://video.dliu.com (DL video) as an anonymous guest, following
the dliu.com health contract (dliu-com/status `HEALTH.md`). The version for people, with flows, numbers, a table and a chart, is
the Testing tab at https://video.dliu.com/docs#health. This file has every technical detail and is enough on its own to implement the tests.

DL video hosts videos that anyone can watch, and embed players that other dliu.com sites (such as the blog) put in
their pages. Only the owner signs in, to upload, edit and delete. The checks below prove the public parts work and that
the owner tools stay closed, without signing in and without depending on which videos exist.

## Functions

| Key | Name | What it does | Critical |
| --- | --- | --- | --- |
| `pages` | Pages | The home page (`/`) and these docs, served by CloudFront from S3. | yes |
| `catalog` | Video list and storage | The public video list (`/data/catalog.json`) in the video bucket, which the home, watch and embed pages read. | yes |
| `player` | Player and embeds | The watch page, the embed player other sites use, and the player script. | yes |
| `signin` | Microsoft sign-in | `/auth/login` sends the owner to Microsoft; the Lambda can read its sign-in settings. | no |
| `owner` | Owner API gate | Upload, edit and delete calls on the website refuse anyone who is not signed in. | yes |
| `msapi` | Microsoft-token API gate | The managed API for tools and AI agents refuses requests without a Microsoft token. | no |

## Guest checks

Rules for every check: method GET or HEAD only; send no cookies, no `Authorization` header and no query string; do not
follow redirects; user agent `dliu-status-bot/1.0 (+https://status.dliu.com/docs)`; timeout 10 s.

| Function | Method | URL | Status | Content type | Body marker, JSON key or `Location` prefix | Slow after |
| --- | --- | --- | --- | --- | --- | --- |
| `pages` | GET | https://video.dliu.com/ | 200 | `text/html` | contains `class="dl-header"` | 2000 ms |
| `pages` | GET | https://video.dliu.com/docs | 200 | `text/html` | contains `class="dl-tabs"` | 2000 ms |
| `catalog` | GET | https://video.dliu.com/data/catalog.json | 200 | `application/json` | JSON key `videos` | 2000 ms |
| `player` | GET | https://video.dliu.com/2000010100 | 200 | `text/html` | contains `id="download"` | 2000 ms |
| `player` | GET | https://video.dliu.com/embed/2000010100 | 200 | `text/html` | contains `id="player"` | 2000 ms |
| `player` | HEAD | https://video.dliu.com/player.js | 200 | `text/javascript` | — | 2000 ms |
| `signin` | GET | https://video.dliu.com/auth/login | 302 | — | `Location` starts with `https://login.microsoftonline.com/` | 3000 ms |
| `owner` | GET | https://video.dliu.com/api/me | 401 | `application/json` | JSON key `error` | 3000 ms |
| `msapi` | GET | https://hdauj691e9.execute-api.eu-west-1.amazonaws.com/api/me | 401 | `application/json` | JSON key `message` | 3000 ms |

Notes:

- `text/html` from S3 has no charset, and the JSON replies may add `; charset=utf-8`; match the content type by prefix.
- `2000010100` is a placeholder video ID that never holds a video. The watch and embed pages still load (CloudFront
  serves the page for any ten-digit ID) and then say the video isn't found, so the check tests the page itself and
  does not break when videos are added or deleted. `videos` may be an empty list.
- `/auth/login` also sets a ten-minute sign-in cookie (`__Host-video_auth`). Ignore it and don't follow the redirect.
- `/api/me` must stay 401 (`{"error":"Not signed in"}`). A 200 there would mean the owner tools are open to guests:
  report `owner` as down.
- The execute-api URL is the managed API (the `MicrosoftApiUrl` deployment output, also listed in
  https://video.dliu.com/docs/api.md). Without a token it answers 401 `{"message":"Unauthorized"}`; a 200 would mean
  it is open: report `msapi` as down.

## Health endpoint

`GET https://video.dliu.com/health` (HEAD also works).

- No authentication. CloudFront's `health` behavior has no origin request policy, so it forwards no cookies, no
  `Authorization` header and no query string, and the Lambda answers before it looks at any request data.
- Cached at CloudFront for 60 s (`Cache-Control: public, max-age=60`, cache key empty), so it runs at most about once a
  minute per edge.
- Read only. Each function has its own 4 s timeout; a check slower than 1 s is `warn` with `output` `slow` (expected
  for the first request after the Lambda has been idle). The whole reply returns within about 4 s.
- `Content-Type: application/health+json`. HTTP 200 when `status` is `pass` or `warn`, 503 when it is `fail`.
- `output` is only `slow`, `timeout` or `read failed`. No names, counts or content.

```json
{
  "status": "pass",
  "time": "2026-11-04T09:00:00Z",
  "functions": [
    { "key": "catalog", "name": "Video list and storage", "status": "pass" },
    { "key": "signin", "name": "Microsoft sign-in settings", "status": "pass" }
  ]
}
```

| Function key | What the check reads |
| --- | --- |
| `catalog` | One S3 `HeadObject` of `data/catalog.json` in the video bucket (no LIST, no download). |
| `signin` | The sign-in settings the app already loads from SSM Parameter Store (cached 5 minutes). Microsoft is not called. |

`pages`, `player`, `owner` and `msapi` are covered by the guest checks only.

## Not tested

A guest can't test anything that needs the owner's sign-in or real content:

- signing in at Microsoft and getting a session;
- uploading, replacing, editing and deleting videos and posters;
- converting uploads into streaming versions (MediaConvert, started by EventBridge Scheduler);
- the managed API with a real Microsoft token;
- playing a particular video file, because which videos exist changes.

## Rules

- Every check is read only and must never change content.
- Never send cookies, credentials or query strings, and never try to sign in.
- Run at most every 15 minutes; `/health` is cached for 60 s anyway.
