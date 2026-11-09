import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../app/api/gradio-proxy/[...path]/route.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { GET, POST } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('Gradio proxy transport', async t => {
  const originalFetch = globalThis.fetch;
  const originalBackend = process.env.GRADIO_BACKEND_URL;
  process.env.GRADIO_BACKEND_URL = 'https://backend.example';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalBackend === undefined) delete process.env.GRADIO_BACKEND_URL;
    else process.env.GRADIO_BACKEND_URL = originalBackend;
  });

  await t.test('retries a temporary config outage and preserves Gradio configuration', async () => {
    let calls = 0;
    const config = { root: 'https://backend.example', api_prefix: '/gradio_api', protocol: 'sse_v3' };
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://backend.example/config');
      assert.equal(init.headers.get('host'), null);
      assert.equal(init.headers.get('x-forwarded-host'), null);
      return ++calls === 1 ? new Response('Unavailable', { status: 503 }) : Response.json(config);
    };
    const response = await GET(new Request('https://frontend.example/api/gradio-proxy/config', {
      headers: { host: 'frontend.example', 'x-forwarded-host': 'frontend.example' },
    }));
    assert.equal(calls, 2);
    assert.deepEqual(await response.json(), config);
  });

  await t.test('retries a config connection failure', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      if (++calls === 1) throw new TypeError('fetch failed');
      return Response.json({ version: '6.0.1' });
    };
    assert.equal((await GET(new Request('https://frontend.example/api/gradio-proxy/config'))).status, 200);
    assert.equal(calls, 2);
  });

  await t.test('forwards multipart uploads byte for byte, including filenames', async () => {
    const form = new FormData();
    form.append('files', new File(['synthetic nifti bytes'], 'scan.nii.gz'));
    const request = new Request('https://frontend.example/api/gradio-proxy/gradio_api/upload?upload_id=123', {
      method: 'POST', body: form,
    });
    const expectedBody = await request.clone().text();
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://backend.example/gradio_api/upload?upload_id=123');
      assert.equal(init.headers.get('content-type'), request.headers.get('content-type'));
      assert.equal(await new Response(init.body).text(), expectedBody);
      return Response.json(['/tmp/gradio/scan.nii.gz']);
    };
    assert.deepEqual(await (await POST(request)).json(), ['/tmp/gradio/scan.nii.gz']);
  });

  await t.test('streams queue events before the upstream connection closes', async () => {
    let controller;
    const body = new ReadableStream({ start(value) { controller = value; } });
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://backend.example/gradio_api/queue/data?session_hash=abc');
      assert.equal(init.headers.get('last-event-id'), 'previous');
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'content-length': '999' },
      });
    };
    const response = await GET(new Request('https://frontend.example/api/gradio-proxy/gradio_api/queue/data?session_hash=abc', {
      headers: { 'last-event-id': 'previous' },
    }));
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = response.body.getReader();
    controller.enqueue(new TextEncoder().encode('data: {"msg":"process_completed","output":{"data":[{}]}}\n\n'));
    assert.match(new TextDecoder().decode((await reader.read()).value), /process_completed/);
    controller.close();
    assert.equal((await reader.read()).done, true);
  });

  await t.test('never replays a failed queue submission', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
    const response = await POST(new Request('https://frontend.example/api/gradio-proxy/gradio_api/queue/join', {
      method: 'POST', body: '{"data":[]}', headers: { 'content-type': 'application/json' },
    }));
    assert.equal(response.status, 502);
    assert.equal(calls, 1);
  });

  await t.test('preserves upstream errors instead of disguising them as HTTP 500', async () => {
    globalThis.fetch = async () => new Response('Not found', { status: 404 });
    const response = await GET(new Request('https://frontend.example/api/gradio-proxy/config'));
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
  });
});
