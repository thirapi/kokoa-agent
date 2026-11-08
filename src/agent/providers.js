// Konfigurasi provider AI (urutan, key, model). Dipisah dari handlers/message.js.
import { fetchGeminiGenerate } from "../services/gemini.js";
import { fetchGroqGenerate } from "../services/groq.js";
import { fetchOpenRouterGenerate, fetchCerebrasGenerate, fetchWorkersAIGenerate, WORKERS_AI_BINDING_KEY } from "../services/openai-compat.js";
import { getValidModelsForProvider } from "./models-discovery.js";

export async function buildProviderConfigs(env) {
  const configs = [];

  if (env.GEMINI_API_KEYS) {
    const key = env.GEMINI_API_KEYS.split(",")[0].trim();
    const models = await getValidModelsForProvider(
      "gemini", key,
      env.GEMINI_MODELS || "gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3-flash-preview",
      env
    );
    configs.push({
      name: "gemini",
      keys: env.GEMINI_API_KEYS.split(",").map((k) => k.trim()),
      models,
      callAI: fetchGeminiGenerate,
    });
  }

  // Groq DINONAKTIFKAN sementara (default): free tier on_demand hanya 8000 TPM
  // org-wide, sementara SATU step agent loop butuh ~6000 token. Loop yang
  // butuh 3-6 step beruntun dijamin 429 terus. Aktifkan lagi hanya setelah
  // upgrade Dev Tier: set GROQ_ENABLED=true di env (Worker vars + Space secrets).
  if ((env.GROQ_ENABLED || 'false').toLowerCase() === 'true' && env.GROQ_API_KEY) {
    const key = env.GROQ_API_KEY.split(",")[0].trim();
    const models = await getValidModelsForProvider(
      "groq", key,
      env.GROQ_MODELS || "openai/gpt-oss-20b,openai/gpt-oss-120b",
      env
    );
    configs.push({
      name: "groq",
      keys: env.GROQ_API_KEY.split(",").map((k) => k.trim()),
      models,
      callAI: fetchGroqGenerate,
    });
  }

  if (env.OPENROUTER_API_KEY) {
    const key = env.OPENROUTER_API_KEY.split(",")[0].trim();
    const models = await getValidModelsForProvider(
      "openrouter", key,
      env.OPENROUTER_MODELS || "openrouter/free,openai/gpt-oss-20b:free,openai/gpt-oss-120b:free",
      env
    );
    configs.push({
      name: "openrouter",
      keys: env.OPENROUTER_API_KEY.split(",").map((k) => k.trim()),
      models,
      callAI: fetchOpenRouterGenerate,
    });
  }

  if (env.CEREBRAS_API_KEY) {
    const key = env.CEREBRAS_API_KEY.split(",")[0].trim();
    const models = await getValidModelsForProvider(
      "cerebras", key,
      env.CEREBRAS_MODELS || "gpt-oss-120b,qwen-3-235b-a22b-instruct-2507,llama-3.3-70b",
      env
    );
    configs.push({
      name: "cerebras",
      keys: env.CEREBRAS_API_KEY.split(",").map((k) => k.trim()),
      models,
      callAI: fetchCerebrasGenerate,
    });
  }

  // Workers AI: di Worker lewat binding (gratis 10rb neuron/hari, tanpa key).
  // Di Spaces/Vercel hanya bila CF_ACCOUNT_ID + CF_AI_TOKEN diset (REST).
  const workersAIKey = env.AI?.run ? WORKERS_AI_BINDING_KEY
    : (env.CF_ACCOUNT_ID && env.CF_AI_TOKEN ? env.CF_AI_TOKEN : null);
  if (workersAIKey) {
    configs.push({
      name: "workersai",
      keys: [workersAIKey],
      models: (env.WORKERS_AI_MODELS || "@cf/meta/llama-3.3-70b-instruct-fp8-fast,@cf/qwen/qwen3-30b-a3b-fp8")
        .split(",").map((m) => m.trim()).filter(Boolean),
      callAI: fetchWorkersAIGenerate,
    });
  }

  // Provider yang aktif tapi tidak disebut di AI_PROVIDERS ditaruh paling belakang.
  const priority = (env.AI_PROVIDERS || "gemini,groq")
    .split(",").map((s) => s.trim());
  const rank = (name) => { const i = priority.indexOf(name); return i === -1 ? priority.length : i; };
  configs.sort((a, b) => rank(a.name) - rank(b.name));

  return configs;
}

// Obrolan ringan: dahulukan model "lite" (lebih cepat & hemat kuota model utama).
// Urutan provider tidak berubah — hanya urutan model di dalam tiap provider.
export function preferLightModels(configs) {
  return configs.map((c) => {
    // Cocokkan sebagai segmen nama utuh: "gemini" tidak boleh terbaca "mini".
    const light = c.models.filter((m) => /(^|[-_/.:])(lite|mini|nano|small|instant|8b)([-_/.:]|$)/i.test(m));
    if (!light.length) return c;
    return { ...c, models: [...light, ...c.models.filter((m) => !light.includes(m))] };
  });
}
