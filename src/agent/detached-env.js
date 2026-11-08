// Env untuk menjalankan agent loop DI LUAR Cloudflare Worker (Vercel, Spaces):
// tidak ada binding KV/D1 — riwayat, memori & task dikirim Worker di request,
// dan hasilnya dikembalikan ke Worker untuk disimpan.

// Konfigurasi non-rahasia yang dikirim Worker per request (persona, model, urutan provider).
export const FORWARDED_CONFIG_KEYS = [
  "GEMINI_SYSTEM_PERSONA", "GEMINI_SYSTEM_INSTRUCTION", "GEMINI_MODELS", "GROQ_MODELS",
  "GROQ_ENABLED", "OPENROUTER_MODELS", "CEREBRAS_MODELS", "WORKERS_AI_MODELS", "AI_PROVIDERS",
  "BOT_USERNAME", "SEARXNG_INSTANCE", "GHA_DISPATCH_REPO",
];

// Key provider yang diteruskan Worker per job (Worker = satu-satunya sumber secret;
// runtime jarak jauh cukup menyimpan RUNNER_SECRET). Kanal: HTTPS + Bearer RUNNER_SECRET.
// Nilai yang sudah diset di env platform tetap diutamakan.
export const FORWARDED_SECRET_KEYS = [
  "GEMINI_API_KEYS", "GROQ_API_KEY", "OPENROUTER_API_KEY", "CEREBRAS_API_KEY",
  "GITHUB_PAT_TOKEN", "TELEGRAM_BOT_TOKEN", "TRELLO_API_KEY", "TRELLO_TOKEN", "TRELLO_BOARD_ID",
];

export function pickForwardedSecrets(env) {
  const out = {};
  for (const k of FORWARDED_SECRET_KEYS) if (env?.[k]) out[k] = env[k];
  return out;
}

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

export function buildDetachedEnv(platformEnv, { config = {}, secrets = {}, workerUrl, memories, tasks, mode, relevantMemories } = {}) {
  const forwardedSecrets = {};
  for (const k of FORWARDED_SECRET_KEYS) {
    if (!platformEnv[k] && secrets?.[k]) forwardedSecrets[k] = secrets[k];
  }
  const env = {
    ...platformEnv,
    ...forwardedSecrets,
    ...pickForwardedConfig(config),
    WORKER_URL: workerUrl || platformEnv.WORKER_URL || "",
    CHAT_HISTORY: memoryKV(),
    DB: noopDB,
    __TASKS_MEM: {},
  };
  if (Array.isArray(memories)) env.__INJECTED_MEMORIES = memories;
  if (Array.isArray(tasks)) env.__INJECTED_TASKS = tasks;
  if (Array.isArray(relevantMemories)) env.__RELEVANT_MEMORIES = relevantMemories;
  if (mode === "plan" || mode === "build") env.AGENT_MODE = mode;
  return env;
}
