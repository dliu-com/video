# Video API

This reference is for trusted tools, scripts and AI agents managing videos on https://video.dliu.com. The same guide is available as plain Markdown at https://video.dliu.com/docs/api.md.

The managed API accepts Microsoft-issued user access tokens. It can list videos, upload or replace video files, edit details and posters, and delete videos when the token has the corresponding permission. Every completed new upload is published immediately: there is no draft, private or unlisted state.

**Authentication is required:** configure your requester using the [Auth API documentation](https://auth.dliu.com/docs/api). That is the canonical guide for credentials, token acquisition and authenticated request setup; this reference covers only the Video API.

## Quick rules

1. Use `VIDEO_API_URL` for the managed API origin. The current deployment output `MicrosoftApiUrl` is `https://hdauj691e9.execute-api.eu-west-1.amazonaws.com`. All nine managed routes are listed below.
2. Configure authentication according to the [Auth API documentation](https://auth.dliu.com/docs/api) before using any managed route. Video website sign-in is not managed API authentication.
3. POST bodies are JSON objects with `Content-Type: application/json`. Keep bodies below 64 KiB; the Lambda checks decoded string length against 65,536 JavaScript code units. Do not send video bytes or multipart form data to this API.
4. Managed API requests do not need `Origin`, website cookies or `x-amz-content-sha256`. The website cookie API is a separate entry point; do not send bearer requests to `https://video.dliu.com/api/*`.
5. Every successful managed endpoint returns HTTP 200 and JSON, including creation and deletion. Errors come from either the gateway (`{"message":"..."}`) or Lambda (`{"error":"..."}`).
6. Request only user-authorized operations. Completing an upload publishes it; replacement changes what existing links and embeds play; deletion removes the video. Do not run write/delete examples just to check a token.
7. Treat presigned S3 URLs as credentials. Never put them in chat, URLs you share, source files, logs or saved tool settings. Do not follow API or S3 redirects with credentials.
8. Before editing or replacing a video, list its current details and send only intended changes. There is no client-visible ETag or conditional-update API; serialize operations on the same video.

## Endpoint summary

| Method and path | Required scope | Operation |
| --- | --- | --- |
| [GET /api/me](#get-api-me) | `video.read` | Read the authenticated user identity |
| [GET /api/videos](#get-api-videos) | `video.read` | List video objects with their conversion status |
| [POST /api/uploads](#post-api-uploads) | `video.write` | Start a new upload or file replacement |
| [POST /api/uploads/parts](#post-api-uploads-parts) | `video.write` | Request presigned S3 part URLs |
| [POST /api/uploads/complete](#post-api-uploads-complete) | `video.write` | Complete and publish the uploaded file |
| [POST /api/uploads/abort](#post-api-uploads-abort) | `video.write` | Cancel an unfinished upload |
| [POST /api/videos/update](#post-api-videos-update) | `video.write` | Edit details or attach a new poster |
| [POST /api/videos/poster](#post-api-videos-poster) | `video.write` | Request a new poster upload URL |
| [POST /api/videos/convert](#post-api-videos-convert) | `video.write` | Make the streaming versions now |
| [POST /api/videos/delete](#post-api-videos-delete) | `video.delete` | Delete a published video |

`video.write` does not include `video.delete`. There is no managed `GET /api/videos/<id>`, PUT/PATCH endpoint, token-management route or login/logout route.

## Authentication

Follow the required [Auth API documentation](https://auth.dliu.com/docs/api) before calling Video. Credential lookup, token storage, expiry/renewal and authorization-header construction belong there, not in this site-specific guide.

Microsoft consent and user assignment still apply. The gateway validates the Microsoft signature, tenant-specific v2 issuer, audience, token times and route scope. Lambda also requires the configured gateway context, tenant, audience, approved client `azp`, user object/subject IDs and the Microsoft-issued shared **dliu API user** role `api.access`. The role grants no operation by itself; each route still requires its exact `video.*` scope. Website cookies never provide a fallback on this entry point.

The existing dliu API registration is both the SPA client and resource; its ID must match both `azp` and `aud`. Tokens come only from Central Microsoft sign-in at auth.dliu.com; Video has no other sign-in for the API. An ID token, Graph access token, app-only token or Video session cookie is not a substitute for the required delegated access token.

**Authenticated standard-user gateway success remains unverified.** Video provides no token-management, revocation or refresh endpoint.

Managed Video code has no application-global bearer-token cache, token persistence or raw bearer-header/full-event logging across Lambda invocations. Its reusable AWS clients, website configuration and public signing-key caches are not API-token caches. Request-local values and warm-runtime memory may remain until garbage collection; this is not a forensic zeroization guarantee. Website sign-in/cookies, playback and embeds remain separate and unchanged.

## Video request examples

These examples assume credentials and an authenticated requester configured per the [Auth API documentation](https://auth.dliu.com/docs/api). From the Video checkout, use Node.js 22+ with `npm ci` and set the exact trusted managed origin:

```bash
export VIDEO_API_URL='https://hdauj691e9.execute-api.eu-west-1.amazonaws.com'
node scripts/api-client.js GET /api/me
node scripts/api-client.js GET /api/videos
# Only when explicitly asked to edit this video:
node scripts/api-client.js POST /api/videos/update '{"id":"2026110100","title":"Updated title"}'
```

For the multipart examples below, this Bash adapter invokes the same authenticated Video client. Placeholder IDs and sample data are illustrative; use the IDs returned for your authorized task:

```bash
# video_api METHOD /api/path [JSON_BODY]
video_api() {
  node scripts/api-client.js "$@"
}

video_api GET /api/me
video_api GET /api/videos
```

Use the exact trusted managed origin with no path, query, credentials or trailing slash. The Video helper refuses API redirects. Capture responses containing presigned URLs in local variables rather than printing them.

## Video objects

Responses from list, completion and update use this complete public object:

```json
{
  "id": "2026110100",
  "title": "Example video",
  "description": "A short description.",
  "createdAt": "2026-11-01T12:00:00.000Z",
  "updatedAt": "2026-11-01T12:00:00.000Z",
  "duration": 61.5,
  "width": 1920,
  "height": 1080,
  "size": 41943040,
  "contentType": "video/mp4",
  "src": "/v/2026110100.mp4",
  "poster": null
}
```

| Field | Meaning |
| --- | --- |
| `id` | Ten decimal digits: UK upload date `yyyymmdd` plus a two-digit daily number, assigned by the server |
| `title`, `description` | Trimmed plain text; selected control characters are removed |
| `createdAt`, `updatedAt` | ISO 8601 timestamps; file replacement preserves `createdAt` |
| `duration` | Duration in seconds, or null if not provided |
| `width`, `height` | Pixel dimensions, or null if not provided |
| `size` | Actual completed S3 object length in bytes |
| `contentType` | Video MIME type selected at upload start |
| `src` | Public path on **https://video.dliu.com**, not on the managed API origin |
| `poster` | Public poster path on the website, or null |
| `hls` | Streaming versions, an HLS playlist path on the website such as `/h/2026110100-EfGh5678/index.m3u8`. Only present once they are ready; until then players use `src` |

The public watch URL is `https://video.dliu.com/<id>` and the embed is `https://video.dliu.com/embed/<id>`. Replacement files get versioned paths such as `/v/2026110100-AbCd1234.webm`; never build a file path from the ID yourself. Use `src` from the current response.

Up to 100 new video numbers can be reserved for a UK day. Published IDs are never reused, even after deletion. Cancelling an unpublished upload frees its reservation.

## Read endpoints

### GET /api/me

Required scope: `video.read`.

No body or query parameters. Response (200):

```json
{"user":"<user-object-id>","name":"Example user"}
```

`user` is the Microsoft user object ID, not an email address. `name` is the token's display name when present, otherwise the same object ID.

### GET /api/videos

Required scope: `video.read`.

No body or query parameters. Response (200):

```json
{"videos":[]}
```

Each array item is a full Video object, including description, content type and size, plus a `conversion` object that is not in the public JSON, for example `{"status":"scheduled","scheduledFor":"2026-11-01T14:00:00.000Z"}`:

| `status` | Other fields |
| --- | --- |
| `none` | None. No streaming versions (uploaded before they existed, or conversion is off) |
| `scheduled` | `scheduledFor`: conversion starts once the file has been unchanged for 2 hours |
| `converting` | `startedAt`, `qualities` (for example `["1080p","720p","480p","360p"]`) |
| `ready` | `startedAt`, `finishedAt`, `qualities` |
| `failed` | `startedAt` (if it started), `finishedAt`, `error`. Players use the original file |
 Newest `createdAt` comes first, with descending ID as the tie-breaker. There is no pagination, filter or per-video managed GET endpoint.

## Multipart upload and replacement

Video bytes go directly to S3, never through API Gateway or Lambda. New uploads and replacements use the same four API routes below.

1. Start the upload with its intended byte length and MIME type. Keep the returned `id`, `uploadId`, `partSize` and `partCount` in memory.
2. If `posterUrl` is present, PUT a JPEG to that URL before completion. This is optional; it does not count as a video part.
3. Request URLs for the part numbers you need (1-based, at most 100 per request).
4. Split the original file into exactly `partCount` sequential chunks of `partSize` bytes, with only the final chunk smaller. PUT each chunk's raw bytes to its own URL and retain the S3 `ETag` response header.
5. Complete with every numbered part and its ETag. This publishes a new video or changes the file played by the existing video's links and embeds.
6. On cancellation before completion, abort using the same `id` and `uploadId`. Aborting a replacement leaves the currently published file untouched.

Part size is at least 16 MiB and an integral number of MiB; the server increases it if necessary to stay within 10,000 parts. Trust the returned plan rather than hardcoding the size. S3 presigned URLs are issued with a 3,600-second expiry, but the signing Lambda's temporary AWS credentials can expire sooner. Request fresh part URLs while the pending upload still exists.

Do not send Microsoft bearer authorization, website cookies or `x-amz-content-sha256` to S3. Keep the exact presigned URL, including its query string. For video parts, do not use multipart form encoding. For posters, send `Content-Type: image/jpeg`. Browser uploads are CORS-enabled only for `https://video.dliu.com`; the token console is not an upload UI.

Abandoned multipart uploads are aborted by S3 after 2 days; pending records expire after 7 days. There is no upload-status/resume-list endpoint. Keep your own plan and ETags; serialize replacements for the same video.

### POST /api/uploads

Required scope: `video.write`.

Request:

```json
{
  "title": "Example video",
  "description": "A short description.",
  "contentType": "video/mp4",
  "size": 41943040,
  "duration": 61.5,
  "width": 1920,
  "height": 1080,
  "poster": true
}
```

| Field | Required/limits |
| --- | --- |
| `title` | Required for a new video; nonempty after trimming, at most 200 characters |
| `description` | Optional plain text, at most 5,000 characters; omitted/null becomes empty on a new video |
| `contentType` | Required: `video/mp4`, `video/webm`, `video/quicktime`, `video/x-m4v` or `video/ogg` |
| `size` | Required integer, 1 to 53,687,091,200 bytes (current 50 GiB configured cap) |
| `duration` | Optional number, 0 to 604,800 seconds; omitted/null becomes null |
| `width`, `height` | Optional integers, 0 to 16,384; omitted/null becomes null |
| `poster` | Optional; use true to request a new poster URL |
| `replace` | Optional existing ten-digit video ID; see replacement behavior below |

Response (200):

```json
{"id":"2026110100","uploadId":"<upload-id>","partSize":16777216,"partCount":3,"posterUrl":"https://<presigned-s3-url>"}
```

`posterUrl` is null unless a poster was requested. The initial call does not return video-part URLs; use the parts route.

With `"replace":"2026110100"`, no title is required: the existing ID, title, description and creation time are retained, and supplied title/description fields are ignored. Duration/dimensions use the replacement request (omitted values become null). A successfully uploaded new poster replaces the old poster; otherwise the old one is kept. Starting another replacement for the same ID cancels its previous unfinished replacement. The old published file remains in use until completion; completing replacement returns `replaced: true`, deletes the old file and invalidates its CDN path.

`size` is used to validate and plan the upload. Send exactly the declared file bytes; completion reports S3's actual length, but does not require it to equal the declaration. Files are not scanned, transcoded or inspected for valid video codecs.

**Current large-upload limitation:** the 50-GiB start cap does not guarantee that an upload can be completed. The completion JSON, including every part ETag, must still fit the 65,536-code-unit body limit; a 50-GiB plan has 3,200 parts and exceeds it with ordinary ETags. Budget compact completion JSON before sending bytes. The example below checks a conservative ETag-size budget and aborts only its newly started pending upload if that budget is too large.

### POST /api/uploads/parts

Required scope: `video.write`.

Request:

```json
{"id":"2026110100","uploadId":"<upload-id>","parts":[1,2,3]}
```

`parts` is an array of 1 to 100 integers, each from 1 to the returned `partCount`. The ID/upload ID must match a pending upload. You can request a part URL again if it expires.

Response (200):

```json
{"urls":{"1":"https://<presigned-part-1-url>","2":"https://<presigned-part-2-url>","3":"https://<presigned-part-3-url>"}}
```

Keys are JSON strings for the requested part numbers. PUT the raw bytes of one chunk:

```bash
# PART_URL is one URL returned above; part-1.bin is exactly that file chunk.
curl --silent --show-error --fail-with-body --proto '=https' \
  --request PUT --upload-file part-1.bin "$PART_URL" --dump-header part-1.headers
```

Extract the `ETag` from the response headers without printing the URL. A part's ETag is opaque; do not recompute it from the video. It can include surrounding quotes; preserve it as a properly JSON-escaped string. A saved header file should remain local and be removed after the operation.

### POST /api/uploads/complete

Required scope: `video.write`.

Request:

```json
{
  "id": "2026110100",
  "uploadId": "<upload-id>",
  "parts": [
    {"partNumber":1,"etag":"\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\""},
    {"partNumber":2,"etag":"\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\""},
    {"partNumber":3,"etag":"\"cccccccccccccccccccccccccccccccc\""}
  ]
}
```

Send exactly `partCount` entries, with each number 1 through `partCount` once. The server sorts them; their input order need not be ascending. Each ETag must be a string of 1 to 64 hexadecimal/hyphen characters, optionally surrounded by quotes, and must be the actual S3 ETag for that part.

Response (200):

```json
{"video":{"id":"2026110100","title":"Example video","description":"A short description.","createdAt":"2026-11-01T12:00:00.000Z","updatedAt":"2026-11-01T12:00:00.000Z","duration":61.5,"width":1920,"height":1080,"size":41943040,"contentType":"video/mp4","src":"/v/2026110100.mp4","poster":null}}
```

A completed replacement adds `"replaced":true` beside `video`. Completion publishes the catalog and video details, then removes the pending record. A missing or larger-than-5-MiB initial poster is omitted rather than failing completion. Do not retry completion blindly: after success the pending ID/upload ID no longer exists and a repeated call returns 404. If a response is lost, list videos and verify the resulting file/details before deciding what to do next.

### POST /api/uploads/abort

Required scope: `video.write`.

Request:

```json
{"id":"2026110100","uploadId":"<upload-id>"}
```

Response (200):

```json
{"aborted":true}
```

Cancels the multipart upload and removes its pending record and uploaded pending poster. A replacement abort does not delete or change the existing published video. A missing/mismatched or already removed pending upload returns 404; this is not an idempotent status endpoint.

## Editing details and posters

### POST /api/videos/update

Required scope: `video.write`.

Request:

```json
{"id":"2026110100","title":"Updated title","description":"Updated description."}
```

`id` is required and must name an existing video. Send only changed fields: `title` is nonempty trimmed text up to 200 characters, `description` is text up to 5,000 characters (empty/null clears it), and `posterVersion` is an optional eight-character string using letters, digits, `_` or `-`. An ID-only request is accepted and updates `updatedAt`; unknown fields do not add arbitrary metadata.

Response (200):

```json
{"video":{"id":"2026110100","title":"Updated title","description":"Updated description.","createdAt":"2026-11-01T12:00:00.000Z","updatedAt":"2026-11-01T12:01:00.000Z","duration":61.5,"width":1920,"height":1080,"size":41943040,"contentType":"video/mp4","src":"/v/2026110100.mp4","poster":null}}
```

The catalog and public details are republished. An existing poster is removed when a different valid uploaded poster is attached. To replace video bytes, use the multipart workflow with `replace`; there is no file field on this route.

### POST /api/videos/poster

Required scope: `video.write`.

Request:

```json
{"id":"2026110100"}
```

Response (200):

```json
{"version":"AbCd1234","url":"https://<presigned-poster-url>"}
```

This only allocates a new poster version and presigned PUT URL; it does not change the published poster. PUT a JPEG of at most 5 MiB (5,242,880 bytes) to `url`, then attach it with the exact returned version:

```bash
# POSTER_URL and POSTER_VERSION are the returned values; no bearer header is sent to S3.
curl --silent --show-error --fail-with-body --proto '=https' \
  --request PUT --upload-file poster.jpg --header 'Content-Type: image/jpeg' "$POSTER_URL"
# Build JSON safely with jq so the returned version is escaped.
video_api POST /api/videos/update \
  "$(jq -cn --arg id "$VIDEO_ID" --arg version "$POSTER_VERSION" '{id:$id,posterVersion:$version}')"
```

Attaching a nonexistent/too-large poster returns 400. The size is checked when attaching; the API does not validate image bytes or MIME type. Do not confuse the returned poster version with the multipart `uploadId`.

## Streaming versions

After a completed upload or replacement, the server makes HLS streaming versions (1080p, 720p, 480p and 360p, never larger than the file) with AWS MediaConvert. It waits until the file has not been replaced for 2 hours, because each replacement starts the wait again and discards versions made from the old file.

### POST /api/videos/convert

Required scope: `video.write`.

Request:

```json
{"id":"2026110100"}
```

Response (200):

```json
{"video":{"id":"2026110100","title":"Example video","description":"A short description.","createdAt":"2026-11-01T12:00:00.000Z","updatedAt":"2026-11-01T12:00:00.000Z","duration":61.5,"width":1920,"height":1080,"size":41943040,"contentType":"video/mp4","src":"/v/2026110100.mp4","poster":null,"conversion":{"status":"converting","startedAt":"2026-11-01T12:00:00.000Z","qualities":["1080p","720p","480p","360p"]}}}
```

The `conversion` is normally `converting`, or `failed` if the job could not start.

Skips the 2-hour wait, or retries after `failed`. Returns 400 while converting, once the versions are ready, or when conversion is not set up; 404 for an unknown video. Conversion costs about $0.05 per video minute, so avoid calling it for a file you are about to replace. Poll `GET /api/videos` to follow the status; conversion usually takes a few minutes.

## Deleting

### POST /api/videos/delete

Required scope: `video.delete`.

Request:

```json
{"id":"2026110100"}
```

Response (200):

```json
{"deleted":"2026110100"}
```

Removes the published entry, video file, poster and public details, and invalidates CDN paths. Existing embeds stop working; a browser that already downloaded bytes retains its copy. A repeated deletion or nonexistent ID returns 404. Deletion is available to an appropriately scoped token, unlike Blog's custom-token API; it still requires the user's explicit task authorization.

## Practical multipart calls

This Bash example uploads an explicitly authorized local `video.mp4` using curl and `jq`; do not execute it as a read-only check. It calculates the actual length, requests one part URL at a time, and completes only after every PUT succeeds. It deliberately omits a poster; use the poster workflow separately if needed.

```bash
(
  set -e
  VIDEO_FILE=video.mp4
  SIZE=$(wc -c < "$VIDEO_FILE")
  PLAN=$(video_api POST /api/uploads \
    "$(jq -cn --arg title 'Example video' --argjson size "$SIZE" \
      '{title:$title,contentType:"video/mp4",size:$size}')")
  VIDEO_ID=$(printf '%s' "$PLAN" | jq -er '.id')
  UPLOAD_ID=$(printf '%s' "$PLAN" | jq -er '.uploadId')
  PART_SIZE=$(printf '%s' "$PLAN" | jq -er '.partSize')
  PART_COUNT=$(printf '%s' "$PLAN" | jq -er '.partCount')
  COMPLETION_BUDGET=$(jq -cn --arg id "$VIDEO_ID" --arg uploadId "$UPLOAD_ID" \
    --argjson count "$PART_COUNT" \
    '{id:$id,uploadId:$uploadId,parts:[range(1;$count+1) | {partNumber:.,etag:("\""+("a"*64)+"\"")}]}')
  if [ "$(printf '%s' "$COMPLETION_BUDGET" | wc -c)" -gt 65536 ]; then
    video_api POST /api/uploads/abort \
      "$(jq -cn --arg id "$VIDEO_ID" --arg uploadId "$UPLOAD_ID" '{id:$id,uploadId:$uploadId}')" > /dev/null
    printf 'Completion JSON would exceed the API limit; pending upload cancelled before sending bytes.\n' >&2
    exit 1
  fi
  COMPLETED_PARTS_JSON='[]'
  WORK_DIR=$(mktemp -d)
  cleanup() {
    rm -f -- "$WORK_DIR/part.bin" "$WORK_DIR/headers"
    rmdir "$WORK_DIR"
  }
  trap cleanup EXIT

  for ((part=1; part<=PART_COUNT; part++)); do
    URLS=$(video_api POST /api/uploads/parts \
      "$(jq -cn --arg id "$VIDEO_ID" --arg uploadId "$UPLOAD_ID" \
        --argjson part "$part" '{id:$id,uploadId:$uploadId,parts:[$part]}')")
    PART_URL=$(printf '%s' "$URLS" | jq -er --arg key "$part" '.urls[$key]')
    dd if="$VIDEO_FILE" of="$WORK_DIR/part.bin" bs=1048576 \
      skip=$(((part-1)*(PART_SIZE/1048576))) count=$((PART_SIZE/1048576))
    curl --silent --show-error --fail-with-body --proto '=https' \
      --request PUT --upload-file "$WORK_DIR/part.bin" "$PART_URL" \
      --dump-header "$WORK_DIR/headers" --output /dev/null
    ETAG=$(awk 'tolower($1) == "etag:" {
      sub(/^[^:]*:[ \t]*/, ""); sub(/\r$/, ""); print; exit
    }' "$WORK_DIR/headers")
    : "${ETAG:?S3 did not return an ETag}"
    COMPLETED_PARTS_JSON=$(jq -cn --argjson parts "$COMPLETED_PARTS_JSON" \
      --argjson part "$part" --arg etag "$ETAG" \
      '$parts + [{partNumber:$part,etag:$etag}]')
  done

  video_api POST /api/uploads/complete \
    "$(jq -cn --arg id "$VIDEO_ID" --arg uploadId "$UPLOAD_ID" \
      --argjson parts "$COMPLETED_PARTS_JSON" '{id:$id,uploadId:$uploadId,parts:$parts}')"
)
```

The subshell stops on an API, PUT or ETag error and removes only its temporary chunk/header files. It does not blindly complete or delete a video on failure. Keep the plan in a trusted process if you need immediate cancellation with `/api/uploads/abort`; otherwise abandoned uploads are removed by lifecycle rules. A failed completion may already have published the video, so check the list before retrying. Presigned S3 URLs used as curl URL arguments can be visible to other local processes; use only a trusted machine.

## Errors

| Status | Meaning/action |
| --- | --- |
| 400 | Lambda input validation failed: malformed/non-object JSON, oversized decoded body, invalid ID, text/type/size/part/ETag/poster, or no new numbers left that UK day. Read `error` and correct the input. |
| 401 | Missing, malformed, invalid or expired Microsoft access token, or untrusted/mismatched identity context. Check requester setup using the [Auth API documentation](https://auth.dliu.com/docs/api); never fall back to website cookies. |
| 403 | Required route scope, approved client or assigned-user `api.access` role is missing. Microsoft assignment/consent and the exact route scope are required; `video.write` does not grant `video.delete`. |
| 404 | No managed route for that method/path, or no matching video/pending upload. Wrong methods on the managed API are unmatched routes, not a supported alternate method. |
| 500 | Lambda/S3/publish/invalidation failure. Writes can have partially succeeded; check the current list before retrying. Upstream gateway integration failures may instead return a gateway 5xx. |

For example, a Lambda validation response is `{"error":"Invalid video id"}`; gateway denial commonly uses `{"message":"Unauthorized"}`. Read both fields when reporting errors, without logging credential headers or presigned URLs. The managed API does not expose a distinct 409/413/415 contract: these handler input errors are 400. Direct S3 PUT errors use S3's own status/body (often XML), not this JSON format.

## Website-only and public endpoints

| Entry point | Authentication/use |
| --- | --- |
| `https://video.dliu.com/auth/login`, `/auth/callback`, `/auth/logout` | Existing Microsoft website login and local session cookies; not managed token-console endpoints |
| `https://video.dliu.com/api/*` | Website session cookies; changes also require exact website `Origin` and CloudFront OAC body hashing (`x-amz-content-sha256`). Do not use for copied bearer tokens. |
| `https://video.dliu.com/data/catalog.json` | Public cached catalog; summary items omit description, content type and size; top-level `updatedAt` |
| `https://video.dliu.com/data/videos/<id>.json` | Public full Video object; no token required |
| `https://video.dliu.com/<id>`, `/embed/<id>`, returned `src`/`poster` paths | Public watch/embed/media, including byte-range video delivery; not served by the managed API |

Unknown managed routes have no unauthenticated default handler. The gateway has no cross-origin browser CORS configuration; use trusted API tools or server-side agents, while the unchanged Video website uses its same-origin cookie API.

Source of truth: `lambda/api/routes.json`, `lambda/api/index.js`, `lambda/api/api-access.js`, `lambda/api/videos.js`, `lambda/api/store.js` and `lib/video-stack.ts`.
