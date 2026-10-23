import { handleOwner } from './owner.js';
import { handleAuth } from './auth.js';
import { handleStreamer } from './streamer.js';

const CORS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
});

export default {
  async fetch(request, env) {
    const headers = {
      ...CORS,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers });
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/owner/')) {
        headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive';
      }
      if (!['GET', 'POST'].includes(request.method)) {
        return Response.json({ error: 'Method not allowed.' }, { status: 405, headers });
      }
      if (!env.DB) throw new Error('D1 binding DB is missing');
      if (request.method === 'POST') {
        if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
          return Response.json({ error: 'Use application/json.' }, { status: 415, headers });
        }
        // Measure the actual stream, not just the caller-supplied Content-Length.
        const reader = request.body?.getReader();
        const chunks = [];
        let length = 0;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 32768) {
              await reader.cancel();
              return Response.json({ error: 'Request body is too large.' }, { status: 413, headers });
            }
            chunks.push(value);
          }
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const text = new TextDecoder().decode(bytes);
        try { JSON.parse(text); } catch {
          return Response.json({ error: 'Invalid JSON body.' }, { status: 400, headers });
        }
        request = new Request(request.url, { method: request.method, headers: request.headers, body: text });
      }
      let response;
      if (url.pathname.startsWith('/api/owner/')) {
        response = await handleOwner(request, env, url, headers);
      } else if (url.pathname.startsWith('/api/register/')) {
        response = await handleAuth(request, env, url, headers);
      } else if (url.pathname.startsWith('/api/public/') || url.pathname.startsWith('/api/streamer/')) {
        response = await handleStreamer(request, env, url, headers);
      } else {
        response = Response.json({ error: 'Route not found.' }, { status: 404, headers });
      }
      const finalHeaders = new Headers(response.headers);
      for (const [name, value] of Object.entries(headers)) finalHeaders.set(name, value);
      return new Response(response.body, { status: response.status, headers: finalHeaders });
    } catch (error) {
      console.error('TikSpin request failed:', error?.message || 'Unknown error');
      return Response.json({ error: 'Service temporarily unavailable. Please retry.' }, { status: 500, headers });
    }
  }
};
