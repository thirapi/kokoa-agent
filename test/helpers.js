// Fake binding Cloudflare minimal untuk unit test.
export const SECRET = "test-runner-secret-0123456789";

export function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, String(v)); },
    delete: async (k) => { store.delete(k); },
  };
}

export function fakeCtx() {
  const pending = [];
  return {
    pending,
    waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
    flush: () => Promise.all(pending),
  };
}

export function baseEnv(extra = {}) {
  return {
    RUNNER_SECRET: SECRET,
    TELEGRAM_BOT_TOKEN: "000:TEST",
    CHAT_HISTORY: fakeKV(),
    DB: {},
    ...extra,
  };
}

export function req(path, { method = "GET", headers = {}, body, auth } = {}) {
  const h = new Headers(headers);
  if (auth !== undefined) h.set("Authorization", auth);
  if (body !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
  return new Request(`https://worker.test${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

export const bearer = (s = SECRET) => `Bearer ${s}`;
