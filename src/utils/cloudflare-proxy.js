// Transparent runtime patch untuk me-route outbound HTTP/HTTPS dari HF Spaces ke Worker.
// Mencegah error "Client network socket disconnected before secure TLS connection..."
// dengan mengalihkan request ke host AI terblokir lewat Worker proxy.
// Diadopsi dari HuggingClaw cloudflare-proxy.js.

import http from 'http';
import https from 'https';

const TARGET_HOSTS = new Set([
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'openrouter.ai',
]);

const WORKER_SECRET = 'kokoa-runner-secret';

// WORKER_URL di HF Spaces TIDAK berasal dari process.env saat container start.
// Nilainya baru dikirim Worker lewat body request /api/process (workerUrl),
// lalu disimpan di agent-server.js sebagai lastWorkerUrl. Karena file ini di-load
// duluan via NODE_OPTIONS, harus baca secara LAZY + bisa di-update saat runtime —
// kalau hanya process.env, proxy tidak pernah aktif (bug: TLS reset terus).
let runtimeWorkerUrl = '';
export function setProxyWorkerUrl(url) {
  if (url) runtimeWorkerUrl = String(url);
}

function getWorkerUrl() {
  return runtimeWorkerUrl || process.env.WORKER_URL || '';
}

function shouldProxy(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase();
  return TARGET_HOSTS.has(h);
}

function patchRequest(originalFn) {
  return function (url, options, callback) {
    let parsedUrl;
    let opts = options;
    let cb = callback;

    if (typeof url === 'string' || url instanceof URL) {
      parsedUrl = typeof url === 'string' ? new URL(url) : url;
      if (typeof options === 'function') {
        cb = options;
        opts = {};
      }
    } else {
      opts = url || {};
      cb = options;
      parsedUrl = new URL(`${opts.protocol || 'https:'}//${opts.hostname || opts.host}${opts.path || '/'}`);
    }

    const hostname = parsedUrl.hostname || opts.hostname || opts.host;
    const workerUrlStr = getWorkerUrl();

    if (shouldProxy(hostname) && workerUrlStr && !opts._proxied) {
      try {
        const workerUrl = new URL(workerUrlStr);
        const targetPath = (parsedUrl.pathname || '') + (parsedUrl.search || '');
        const proxyPath = `/api/ai-proxy${targetPath}`;

        const headers = { ...(opts.headers || {}) };
        headers['x-target-host'] = hostname;
        if (headers['authorization'] || headers['Authorization']) {
          headers['x-target-auth'] = headers['authorization'] || headers['Authorization'];
        }
        headers['Authorization'] = `Bearer ${WORKER_SECRET}`;

        const newOptions = {
          ...opts,
          _proxied: true,
          protocol: 'https:',
          hostname: workerUrl.hostname,
          port: workerUrl.port || 443,
          path: proxyPath,
          headers,
        };
        delete newOptions.host;
        delete newOptions.agent; // Paksa fresh connection, hapus pool lama

        return originalFn(newOptions, cb);
      } catch (e) {
        console.error('[proxy-patch] error:', e.message);
      }
    }

    return originalFn(url, options, callback);
  };
}

// Patch Node.js HTTP/HTTPS primitives
https.request = patchRequest(https.request);
http.request = patchRequest(http.request);

// Patch global fetch
if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    let urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input?.url);
    if (!urlStr) return originalFetch(input, init);

    try {
      const u = new URL(urlStr);
      const workerUrlStr = getWorkerUrl();
      if (shouldProxy(u.hostname) && workerUrlStr && !init?._proxied) {
        const workerUrl = new URL(workerUrlStr);
        const proxyUrl = `${workerUrl.origin}/api/ai-proxy${u.pathname}${u.search}`;

        const headers = new Headers(init?.headers || {});
        headers.set('x-target-host', u.hostname);
        const auth = headers.get('authorization');
        if (auth) headers.set('x-target-auth', auth);
        headers.set('Authorization', `Bearer ${WORKER_SECRET}`);

        const newInit = {
          ...init,
          _proxied: true,
          headers,
        };
        delete newInit.agent;
        delete newInit.dispatcher;

        return originalFetch(proxyUrl, newInit);
      }
    } catch (_) {}

    return originalFetch(input, init);
  };
}

console.log('[cloudflare-proxy] Transparent AI proxy patch initialized');
