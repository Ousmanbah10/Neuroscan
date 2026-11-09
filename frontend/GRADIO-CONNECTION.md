# Gradio connection

All prediction modes connect to `/api/gradio-proxy` on the frontend origin.
The Node.js route forwards configuration, multipart uploads, API metadata, and
queued SSE responses to `https://cooleschimo-neuroscan-backend.hf.space`.
The server-only `GRADIO_BACKEND_URL` variable can override this address (for
example, `http://127.0.0.1:7860` for a local backend). No variable is required
for the public Hugging Face backend. Do not include `/gradio_api` in this value;
the Gradio client reads that prefix from `/config`.

The installed `@gradio/client` 2.0.0 supports `sse_v3` and `api_prefix`, sets
the config root to its connection URL, and uploads browser File inputs as
multipart data while retaining their names. A backend config whose root differs
from the frontend origin is therefore not by itself evidence of a client bug.

## Local checks

From `frontend`, using Node.js 22 LTS or newer:

```sh
npm ci
node --test tests/gradio-proxy.test.mjs
npx tsc --noEmit
npm run build
npm start
```

Open `http://localhost:3000/api/gradio-proxy/config`; expect HTTP 200, Gradio
configuration, `/gradio_api`, and `sse_v3`. Then upload a known valid `.nii` or
`.nii.gz` scan in Single, two scans in Compare, and multiple scans in Batch.
Confirm results and 3D visualization load. The repository includes
`public/test_samples_20.zip` with sample scans.

In the browser Network panel, config, `/gradio_api/info`, uploads,
`/gradio_api/queue/join`, and `/gradio_api/queue/data` should all use the
`/api/gradio-proxy` prefix. The queue data response is a streaming event stream.

## Render

Deploy the updated commit as a Node web service with root directory `frontend`,
build command `npm ci && npm run build`, and start command
`npm start -- --hostname 0.0.0.0 --port $PORT`. Use Node.js 22 LTS or newer.
Keep `GRADIO_BACKEND_URL` unset for the default Space, or set it to the backend
base URL above. Repeat the config and prediction checks against the Render URL.

Configuration GET requests retry connection failures and HTTP 502/503/504 up to
three attempts, with a 15-second timeout per attempt. Uploads and prediction
submissions are never retried automatically to avoid duplicate jobs. The proxy
streams request and response bodies without buffering the SSE connection.

For recurring failures, inspect Render logs for `[gradio-proxy]` messages:
these report the path, attempt, upstream status or connection error, and the
underlying fetch cause. Transport failures return 502/504; actual upstream
HTTP errors retain their status. Compare the timestamp with Hugging Face Space
logs to distinguish backend restarts from DNS, TLS, or connection timeouts.
The original reported HTTP 500 could not be reproduced during inspection:
both live config URLs returned 200. Without logs from a failed request, its
precise cause remains unconfirmed.

## Verification performed

The proxy transport tests, TypeScript check, and production build passed.
A live prediction through the local production server to the Hugging Face
backend succeeded for both `.nii` and `.nii.gz` using an artificially generated
volume containing no patient data. Configuration discovery, API metadata, multipart upload, queued
SSE completion, and nonempty scan/heatmap output were verified. This checks
the connection and response structure; it does not validate model accuracy.
