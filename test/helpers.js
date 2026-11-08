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

// D1 sungguhan-ish: SQLite in-memory (node:sqlite) dengan schema.sql asli.
export async function sqliteD1() {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: r.changes } }; },
    all: async () => ({ results: db.prepare(sql).all(...params) }),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())), _db: db };
}
