// Integrasi processMessage: memastikan pembagian kerja Worker vs HF Spaces.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config.js", async (orig) => ({ ...(await orig()), EXECUTION_TIMEOUT: 60 }));
vi.mock("../src/services/gemini.js", () => ({ fetchGeminiGenerate: vi.fn() }));
vi.mock("../src/services/groq.js", () => ({ fetchGroqGenerate: vi.fn() }));
vi.mock("../src/services/openrouter.js", () => ({ fetchOpenRouterGenerate: vi.fn() }));
vi.mock("../src/services/search.js", () => ({
  webSearch: vi.fn(async () => ({ results: [] })), webFetch: vi.fn(), imageSearch: vi.fn(),
  songSearch: vi.fn(), youtubeSearch: vi.fn(), freeMusicSearch: vi.fn(), pipedAudioSearch: vi.fn(),
}));
vi.mock("../src/services/telegram.js", () => ({
  sendTelegramMessage: vi.fn(async () => [{ message_id: 99 }]), sendTelegramAction: vi.fn(async () => {}),
  deleteTelegramMessage: vi.fn(async () => {}), sendTelegramPhoto: vi.fn(), sendTelegramAudio: vi.fn(),
  getTelegramUserInfo: vi.fn(),
}));
vi.mock("../src/services/hf-spaces.js", () => ({ processViaSpaces: vi.fn(async () => ({ status: "processing" })) }));
vi.mock("../src/services/spaces-poll.js", () => ({ pollSpacesResult: vi.fn(async () => true) }));
vi.mock("../src/utils/logger.js", () => ({ logError: vi.fn(async () => {}) }));
vi.mock("../src/db/index.js", async () => {
  const fn = () => vi.fn(async () => {});
  return {
    getHistory: vi.fn(async () => []), addHistory: fn(), trimHistory: fn(), clearHistory: fn(),
    saveGHAContext: fn(), getTasks: vi.fn(async () => []), getAllMemories: vi.fn(async () => []),
    acquireChatLock: vi.fn(async () => true), releaseChatLock: fn(), saveTaskTrace: fn(), markRemoteJobStarted: fn(),
    setMemory: fn(), getMemory: fn(), deleteMemory: fn(), getRecentMemories: vi.fn(async () => []),
    addTask: fn(), updateTaskStatus: fn(), createTasks: fn(), clearTasks: fn(),
    addReminder: fn(), getReminders: vi.fn(async () => []), deleteReminder: fn(),
  };
});

import { processMessage } from "../src/handlers/message.js";
import { fetchGeminiGenerate } from "../src/services/gemini.js";
import { processViaSpaces } from "../src/services/hf-spaces.js";
import { pollSpacesResult } from "../src/services/spaces-poll.js";
import { sendTelegramMessage } from "../src/services/telegram.js";
import * as db from "../src/db/index.js";
import { baseEnv } from "./helpers.js";

const text = (t) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const call = (name, args = {}) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });
const slow = (value, ms = 100) => new Promise((r) => setTimeout(() => r(value), ms));
const msg = (t) => ({ chat: { id: 5, type: "private" }, from: { id: 5 }, text: t });

let env;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  env = baseEnv({ HF_SPACES_URL: "https://space.test", GEMINI_API_KEYS: "k1", GEMINI_MODELS: "m1", AI_PROVIDERS: "gemini" });
});

const sentTexts = () => sendTelegramMessage.mock.calls.map((c) => c[2]);

describe("processMessage routing", () => {
  it("obrolan umum dijawab langsung oleh Worker, Spaces tidak disentuh", async () => {
    fetchGeminiGenerate.mockResolvedValueOnce(text("halo jugaa"));
    await processMessage(msg("halo cocoa, lagi ngapain hari ini?"), env);
    expect(processViaSpaces).not.toHaveBeenCalled();
    expect(sentTexts().some((t) => t.includes("halo jugaa"))).toBe(true);
    expect(db.addHistory).toHaveBeenCalled();
    expect(db.releaseChatLock).toHaveBeenCalledWith(env, "5");
    const saved = db.saveTaskTrace.mock.calls[0][1];
    expect(saved).toMatchObject({ chatId: "5", runtime: "worker", status: "ok" });
    expect(saved.events[0]).toMatchObject({ kind: "llm", ok: true });
  });

  it("tugas repo dikirim ke Spaces dan lock tidak dilepas Worker", async () => {
    await processMessage(msg("tolong cek bug di repo thirapi/kokoa-agent"), env);
    expect(processViaSpaces).toHaveBeenCalledTimes(1);
    expect(pollSpacesResult).toHaveBeenCalled();
    expect(fetchGeminiGenerate).not.toHaveBeenCalled();
    expect(db.releaseChatLock).not.toHaveBeenCalled();
  });

  it("Spaces tidak bisa dihubungi -> fallback ke Worker", async () => {
    processViaSpaces.mockRejectedValueOnce(new Error("ECONNRESET"));
    fetchGeminiGenerate.mockResolvedValueOnce(text("aku kerjain dari worker"));
    await processMessage(msg("tolong cek bug di repo thirapi/kokoa-agent"), env);
    expect(fetchGeminiGenerate).toHaveBeenCalled();
    expect(sentTexts().some((t) => t.includes("aku kerjain dari worker"))).toBe(true);
    expect(db.releaseChatLock).toHaveBeenCalled();
  });

  it("tanpa HF_SPACES_URL semua jalan di Worker", async () => {
    delete env.HF_SPACES_URL;
    fetchGeminiGenerate.mockResolvedValueOnce(text("ok"));
    await processMessage(msg("tolong cek bug di repo thirapi/kokoa-agent"), env);
    expect(processViaSpaces).not.toHaveBeenCalled();
  });

  it("Worker timeout tanpa efek samping -> dialihkan ke Spaces", async () => {
    fetchGeminiGenerate.mockImplementation(() => slow(call("webSearch", { query: "berita" })));
    await processMessage(msg("cariin berita terbaru soal hiroshima dong"), env);
    expect(processViaSpaces).toHaveBeenCalledTimes(1);
    expect(sentTexts().some((t) => /kelamaan/.test(t))).toBe(false);
  });

  it("Worker timeout SETELAH tool yang mengubah state -> tidak diulang (hindari aksi dobel)", async () => {
    fetchGeminiGenerate.mockImplementation(() => slow(call("remember", { key: "warna", value: "biru" })));
    await processMessage(msg("inget ya warna favoritku biru banget"), env);
    expect(db.setMemory).toHaveBeenCalled();
    expect(processViaSpaces).not.toHaveBeenCalled();
    expect(sentTexts().some((t) => /kelamaan/.test(t))).toBe(true);
  });

  it("kasus nyata: 'haii' setelah tugas repo dijawab Worker", async () => {
    db.getHistory.mockResolvedValueOnce([
      { role: "user", parts: [{ text: "cek struktur repo thirapi/kokoa-agent" }] },
      { role: "model", parts: [{ text: "ok" }] },
    ]);
    fetchGeminiGenerate.mockResolvedValueOnce(text("haii jugaa"));
    await processMessage(msg("haii"), env);
    expect(processViaSpaces).not.toHaveBeenCalled();
    expect(sentTexts().some((t) => t.includes("haii jugaa"))).toBe(true);
  });

  it("prompt disimpan saat dikirim ke Spaces (untuk retry di Worker)", async () => {
    await processMessage(msg("tolong cek bug di repo thirapi/kokoa-agent"), env);
    expect(await env.CHAT_HISTORY.get("spaces_prompt:5")).toBe("tolong cek bug di repo thirapi/kokoa-agent");
  });

  it("forceRuntime=worker: tugas repo dikerjakan Worker & timeout tidak dipantulkan ke Spaces", async () => {
    fetchGeminiGenerate.mockImplementation(() => slow(call("webSearch", { query: "x" })));
    await processMessage(msg("tolong cek bug di repo thirapi/kokoa-agent"), env, { forceRuntime: "worker" });
    expect(processViaSpaces).not.toHaveBeenCalled();
    expect(sentTexts().some((t) => /kelamaan/.test(t))).toBe(true);
  });

  describe("dengan VERCEL_AGENT_URL", () => {
    beforeEach(() => { env.VERCEL_AGENT_URL = "https://agent.vercel.test/api/agent"; env.WORKER_URL = "https://worker.test"; });

    const vercelCalls = () => fetch.mock.calls.filter(([u]) => String(u).startsWith("https://agent.vercel.test"));

    it("tugas repo dikirim ke Vercel (auth + config non-rahasia), lock dipegang, Spaces tidak disentuh", async () => {
      fetch.mockImplementation(async (u) => new Response('{"status":"processing"}', { status: String(u).includes("vercel") ? 202 : 200 }));
      await processMessage(msg("tolong cek bug di repo thirapi/kokoa-agent"), env);
      const [[, init]] = vercelCalls();
      expect(init.headers.Authorization).toBe(`Bearer ${env.RUNNER_SECRET}`);
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({ chatId: "5", userPrompt: "tolong cek bug di repo thirapi/kokoa-agent", historyLen: 0, workerUrl: "https://worker.test" });
      expect(body.config.AI_PROVIDERS).toBe("gemini");
      // key provider ikut di kanal ber-auth (Worker = satu-satunya sumber secret)...
      expect(body.secrets).toMatchObject({ GEMINI_API_KEYS: "k1", TELEGRAM_BOT_TOKEN: "000:TEST" });
      // ...tapi RUNNER_SECRET & binding tidak pernah ikut
      expect(body.secrets.RUNNER_SECRET).toBeUndefined();
      expect(body.config.GEMINI_API_KEYS).toBeUndefined();
      expect(processViaSpaces).not.toHaveBeenCalled();
      expect(fetchGeminiGenerate).not.toHaveBeenCalled();
      expect(db.releaseChatLock).not.toHaveBeenCalled();
      expect(db.markRemoteJobStarted).toHaveBeenCalledWith(env, "5", "vercel", "tolong cek bug di repo thirapi/kokoa-agent");
    });

    it("Vercel gagal -> cadangan ke Spaces", async () => {
      fetch.mockImplementation(async (u) => new Response("err", { status: String(u).includes("vercel") ? 500 : 200 }));
      await processMessage(msg("tolong cek bug di repo thirapi/kokoa-agent"), env);
      expect(vercelCalls()).toHaveLength(1);
      expect(processViaSpaces).toHaveBeenCalledTimes(1);
    });

    it("Vercel & Spaces gagal -> dikerjakan Worker", async () => {
      fetch.mockImplementation(async (u) => new Response("err", { status: String(u).includes("vercel") ? 500 : 200 }));
      processViaSpaces.mockRejectedValueOnce(new Error("ECONNRESET"));
      fetchGeminiGenerate.mockResolvedValueOnce(text("dari worker"));
      await processMessage(msg("tolong cek bug di repo thirapi/kokoa-agent"), env);
      expect(sentTexts().some((t) => t.includes("dari worker"))).toBe(true);
    });

    it("obrolan umum tetap di Worker", async () => {
      fetchGeminiGenerate.mockResolvedValueOnce(text("hai"));
      await processMessage(msg("halo cocoa lagi ngapain hari ini?"), env);
      expect(vercelCalls()).toHaveLength(0);
    });

    it("hanya Vercel (tanpa HF) tetap dianggap punya runtime jarak jauh", async () => {
      delete env.HF_SPACES_URL;
      fetch.mockImplementation(async (u) => new Response("{}", { status: String(u).includes("vercel") ? 202 : 200 }));
      await processMessage(msg("tolong cek bug di repo thirapi/kokoa-agent"), env);
      expect(vercelCalls()).toHaveLength(1);
    });
  });
});
