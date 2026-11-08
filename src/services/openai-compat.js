// Provider berformat OpenAI Chat Completions (OpenRouter, Cerebras, Workers AI).
// Semua berbagi: system prompt, konversi riwayat Gemini -> OpenAI, seleksi tool
// sesuai scope, pemangkasan budget token, dan konversi balik ke format Gemini.
import { buildSystemMessage, convertContentsToMessages, convertGroqResponse, selectTools, fitMessagesForBudget } from "./groq.js";
import { detectScope, isRepoTool, extractLatestUserText, recentUserTexts } from "../agent/scope.js";
import { withNetworkRetry } from "../utils/net.js";
import { buildSkillsBlock, getForcedSkill } from "../agent/skills.js";

const REQUEST_TIMEOUT_MS = 25000;

export async function buildOpenAIPayload(model, contents, env, chatId, { temperature = 0.7 } = {}) {
  const latestText = extractLatestUserText(contents);
  const scope = detectScope(latestText, recentUserTexts(contents, 4));
  const forcedSkill = await getForcedSkill(env, chatId).catch(() => null);
  const skillsBlock = buildSkillsBlock(latestText, forcedSkill);
  const systemMessage = await buildSystemMessage(env, chatId, scope, skillsBlock);
  const messages = convertContentsToMessages(contents);
  const userText = contents.filter((c) => c.role === "user").flatMap((c) => (c.parts || []).map((p) => p.text || "")).join(" ");
  let tools = selectTools(userText, env.IS_SPACES, recentUserTexts(contents, 4));
  // Mode umum: sembunyikan tool repo/file agar model tidak nyasar ke repo aktif
  if (scope === "general") tools = tools.filter((tool) => !isRepoTool(tool.function.name));
  const { kept } = fitMessagesForBudget(systemMessage, messages, tools);
  return { model, messages: kept, tools: tools.length > 0 ? tools : undefined, temperature };
}

// POST JSON ke endpoint /chat/completions yang kompatibel OpenAI.
export async function postChatCompletions(url, headers, payload, errorPrefix) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await withNetworkRetry(() => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }));
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`${errorPrefix}: Request Timeout`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`${errorPrefix}: ${response.status} - ${errorData.slice(0, 500)}`);
  }
  return response.json();
}

// ---- OpenRouter ----
export async function fetchOpenRouterGenerate(model, key, contents, env, chatId) {
  const payload = await buildOpenAIPayload(model, contents, env, chatId);
  const data = await postChatCompletions("https://openrouter.ai/api/v1/chat/completions",
    { Authorization: `Bearer ${key}` }, payload, "OPENROUTER_API_ERROR");
  return convertGroqResponse(data);
}

// ---- Cerebras (free tier ~1 juta token/hari, sangat cepat) ----
export async function fetchCerebrasGenerate(model, key, contents, env, chatId) {
  const payload = await buildOpenAIPayload(model, contents, env, chatId);
  const data = await postChatCompletions("https://api.cerebras.ai/v1/chat/completions",
    { Authorization: `Bearer ${key}` }, payload, "CEREBRAS_API_ERROR");
  return convertGroqResponse(data);
}

// ---- Cloudflare Workers AI ----
// Di Worker: lewat binding env.AI (tanpa key, tanpa jaringan keluar).
// Di luar Worker (Spaces/Vercel): REST OpenAI-compatible bila CF_ACCOUNT_ID + CF_AI_TOKEN diset.
export const WORKERS_AI_BINDING_KEY = "binding";

export async function fetchWorkersAIGenerate(model, key, contents, env, chatId) {
  const payload = await buildOpenAIPayload(model, contents, env, chatId);
  let data;
  if (key === WORKERS_AI_BINDING_KEY && env.AI?.run) {
    const { model: _m, ...input } = payload;
    try {
      data = await env.AI.run(model, input);
    } catch (err) {
      const msg = String(err?.message || err);
      // Kuota harian neuron habis / limit -> perlakukan seperti 429 agar dirotasi.
      if (/neuron|quota|limit|capacity/i.test(msg)) throw new Error(`WORKERS_AI_ERROR: 429 - ${msg}`);
      throw new Error(`WORKERS_AI_ERROR: ${msg}`);
    }
  } else {
    data = await postChatCompletions(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`,
      { Authorization: `Bearer ${key}` }, payload, "WORKERS_AI_ERROR");
  }
  if (!data?.choices) throw new Error(`WORKERS_AI_ERROR: respons tidak dikenal`);
  return convertGroqResponse(data);
}
