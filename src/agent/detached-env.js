// Env untuk menjalankan agent loop DI LUAR Cloudflare Worker (Vercel, Spaces):
// tidak ada binding KV/D1 — riwayat, memori & task dikirim Worker di request,
// dan hasilnya dikembalikan ke Worker untuk disimpan.

// Konfigurasi non-rahasia yang boleh dikirim Worker per request (persona, model,
// urutan provider). Secret TIDAK pernah lewat sini — diambil dari env platform.
export const FORWARDED_CONFIG_KEYS = [
  "GEMINI_SYSTEM_PERSONA", "GEMINI_SYSTEM_INSTRUCTION", "GEMINI_MODELS", "GROQ_MODELS",
  "GROQ_ENABLED", "OPENROUTER_MODELS", "CEREBRAS_MODELS", "WORKERS_AI_MODELS", "AI_PROVIDERS",
  "BOT_USERNAME", "SEARXNG_INSTANCE", "GHA_DISPATCH_REPO",
];

export function pickForwardedConfig(env) {
  const out = {};
  for (const k of FORWARDED_CONFIG_KEYS) if (env?.[k] !== undefined && env[k] !== "") out[k] = env[k];
  return out;
}

function memoryKV() {
  const store = new Map();
  return {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v, opts) => {
      store.set(k, v);
      if (opts?.expirationTtl) setTimeout(() => store.delete(k), opts.expirationTtl * 1000).unref?.();
    },
    delete: async (k) => { store.delete(k); },
  };
}

// D1 tiruan: tulis = no-op, baca = kosong. db/index.js memakai __INJECTED_* bila ada.
const noopDB = {
  prepare: () => ({
    bind: () => ({ run: async () => {}, first: async () => null, all: async () => ({ results: [] }) }),
  }),
  batch: async () => [],
};

export function buildDetachedEnv(platformEnv, { config = {}, workerUrl, memories, tasks, mode } = {}) {
  const env = {
    ...platformEnv,
    ...pickForwardedConfig(config),
    WORKER_URL: workerUrl || platformEnv.WORKER_URL || "",
    CHAT_HISTORY: memoryKV(),
    DB: noopDB,
    __TASKS_MEM: {},
  };
  if (Array.isArray(memories)) env.__INJECTED_MEMORIES = memories;
  if (Array.isArray(tasks)) env.__INJECTED_TASKS = tasks;
  if (mode === "plan" || mode === "build") env.AGENT_MODE = mode;
  return env;
}
