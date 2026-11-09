export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROXY_PATH = '/api/gradio-proxy';
const DEFAULT_BACKEND = 'https://cooleschimo-neuroscan-backend.hf.space';
const RETRYABLE = new Set([502, 503, 504]);

async function proxy(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const path = incoming.pathname.slice(PROXY_PATH.length);
  const isConfig = request.method === 'GET' && path === '/config';

  let upstream: URL;
  try {
    upstream = new URL(process.env.GRADIO_BACKEND_URL || DEFAULT_BACKEND);
    if (!['http:', 'https:'].includes(upstream.protocol)) {
      throw new Error('Expected an HTTP(S) backend URL');
    }
    upstream.pathname = upstream.pathname.replace(/\/$/, '') + path;
    upstream.search = incoming.search;
  } catch {
    console.error('[gradio-proxy] Invalid GRADIO_BACKEND_URL');
    return Response.json({ error: 'Invalid backend URL configuration' }, { status: 500 });
  }

  // Forward multipart boundaries and SSE reconnect headers, but never the
  // frontend Host/forwarded headers (Gradio uses those to construct its root).
  const headers = new Headers();
  for (const name of ['content-type', 'accept', 'last-event-id']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Only configuration discovery is safe to replay. Never retry an upload or
  // queue submission, since it could create a duplicate prediction.
  const attempts = isConfig ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const init: RequestInit & { duplex?: 'half' } = {
        method: request.method,
        headers,
        cache: 'no-store',
        signal: isConfig
          ? AbortSignal.any([request.signal, AbortSignal.timeout(15000)])
          : request.signal,
      };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
        init.duplex = 'half';
      }
      const response = await fetch(upstream, init);
      if (!response.ok) {
        console.error('[gradio-proxy] Upstream HTTP error', {
          method: request.method, path, status: response.status, attempt,
        });
      }
      if (isConfig && RETRYABLE.has(response.status) && attempt < attempts) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
        continue;
      }

      // Stream both file responses and queue/data SSE without buffering. Fetch
      // decompresses upstream bodies, so don't copy content-encoding/length.
      const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
      const contentType = response.headers.get('content-type');
      if (contentType) responseHeaders.set('Content-Type', contentType);
      if (contentType?.includes('text/event-stream')) {
        responseHeaders.set('X-Accel-Buffering', 'no');
      }
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      console.error('[gradio-proxy] Upstream connection failed', {
        method: request.method, path, attempt, message: cause.message,
        cause: cause.cause,
      });
      if (isConfig && !request.signal.aborted && attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
        continue;
      }
      return Response.json(
        { error: 'Could not reach the model backend. Please try again shortly.' },
        { status: cause.name === 'TimeoutError' ? 504 : 502 },
      );
    }
  }
  throw new Error('Unreachable proxy state');
}

export { proxy as GET, proxy as POST, proxy as HEAD };
