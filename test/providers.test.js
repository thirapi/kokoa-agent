import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/db/index.js", async () => {
  const fn = () => vi.fn(async () => {});
  return {
    getHistory: vi.fn(async () => []), addHistory: fn(), trimHistory: fn(), clearHistory: fn(), saveGHAContext: fn(),
    getTasks: vi.fn(async () => []), getAllMemories: vi.fn(async () => []), getRecentMemories: vi.fn(async () => []),
    acquireChatLock: vi.fn(async () => true), releaseChatLock: fn(), setMemory: fn(), getMemory: fn(),
  };
});

import { buildProviderConfigs } from "../src/handlers/message.js";
import { fetchCerebrasGenerate, fetchWorkersAIGenerate, WORKERS_AI_BINDING_KEY } from "../src/services/openai-compat.js";
import { fakeKV } from "./helpers.js";

const contents = [{ role: "user", parts: [{ text: "cariin berita terbaru soal hiroshima" }] }];
const openAIToolCall = {
  choices: [{ message: { role: "assistant", content: null, tool_calls: [
    { id: "c1", type: "function", function: { name: "webSearch", arguments: '{"query":"hiroshima"}' } }] }, finish_reason: "tool_calls" }],
};

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(openAIToolCall), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("buildProviderConfigs", () => {
  const env = (extra) => ({ CHAT_HISTORY: fakeKV(), ...extra });

  it("Workers AI aktif otomatis di Worker (binding), tanpa key", async () => {
    const cfgs = await buildProviderConfigs(env({ AI: { run: vi.fn() }, AI_PROVIDERS: "gemini,workersai" }));
    const w = cfgs.find((c) => c.name === "workersai");
    expect(w.keys).toEqual([WORKERS_AI_BINDING_KEY]);
    expect(w.models[0]).toMatch(/^@cf\//);
  });

  it("Workers AI di luar Worker hanya dengan CF_ACCOUNT_ID + CF_AI_TOKEN", async () => {
    expect((await buildProviderConfigs(env({}))).find((c) => c.name === "workersai")).toBeUndefined();
    const cfgs = await buildProviderConfigs(env({ CF_ACCOUNT_ID: "acc", CF_AI_TOKEN: "tok" }));
    expect(cfgs.find((c) => c.name === "workersai").keys).toEqual(["tok"]);
  });

  it("Cerebras aktif bila CEREBRAS_API_KEY ada", async () => {
    const cfgs = await buildProviderConfigs(env({ CEREBRAS_API_KEY: "a,b", CEREBRAS_MODELS: "gpt-oss-120b" }));
    expect(cfgs.find((c) => c.name === "cerebras")).toMatchObject({ keys: ["a", "b"] });
  });

  it("urutan mengikuti AI_PROVIDERS; provider yang tidak disebut ditaruh PALING BELAKANG", async () => {
    const cfgs = await buildProviderConfigs(env({
      GEMINI_API_KEYS: "g", OPENROUTER_API_KEY: "o", CEREBRAS_API_KEY: "c", AI: { run: vi.fn() },
      AI_PROVIDERS: "cerebras,gemini",
    }));
    expect(cfgs.map((c) => c.name)).toEqual(["cerebras", "gemini", "openrouter", "workersai"]);
  });
});

describe("fetchCerebrasGenerate", () => {
  it("memanggil endpoint Cerebras dengan key & mengonversi tool call ke format Gemini", async () => {
    const res = await fetchCerebrasGenerate("gpt-oss-120b", "ck", contents, { CHAT_HISTORY: fakeKV() }, "1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer ck");
    expect(JSON.parse(init.body).model).toBe("gpt-oss-120b");
    expect(res.candidates[0].content.parts[0]).toEqual({ functionCall: { name: "webSearch", args: { query: "hiroshima" } } });
  });

  it("error HTTP diberi prefix + status (agar rotasi key/model bekerja)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    await expect(fetchCerebrasGenerate("m", "k", contents, { CHAT_HISTORY: fakeKV() }, "1")).rejects.toThrow("CEREBRAS_API_ERROR: 429");
  });
});

describe("fetchWorkersAIGenerate", () => {
  it("binding: memanggil env.AI.run tanpa field model & tanpa jaringan", async () => {
    const run = vi.fn(async () => openAIToolCall);
    const res = await fetchWorkersAIGenerate("@cf/meta/llama-3.3-70b-instruct-fp8-fast", WORKERS_AI_BINDING_KEY, contents,
      { AI: { run }, CHAT_HISTORY: fakeKV() }, "1");
    expect(run).toHaveBeenCalledTimes(1);
    const [model, input] = run.mock.calls[0];
    expect(model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(input.model).toBeUndefined();
    expect(input.messages.at(-1)).toMatchObject({ role: "user" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.candidates[0].content.parts[0].functionCall.name).toBe("webSearch");
  });

  it("kuota neuron habis -> error 429 (dirotasi, bukan crash)", async () => {
    const run = vi.fn(async () => { throw new Error("4006: you have used up your daily free allocation of 10,000 neurons"); });
    await expect(fetchWorkersAIGenerate("m", WORKERS_AI_BINDING_KEY, contents, { AI: { run }, CHAT_HISTORY: fakeKV() }, "1"))
      .rejects.toThrow("WORKERS_AI_ERROR: 429");
  });

  it("REST (di luar Worker) memakai endpoint OpenAI-compatible Cloudflare", async () => {
    await fetchWorkersAIGenerate("@cf/x", "tok", contents, { CF_ACCOUNT_ID: "acc", CHAT_HISTORY: fakeKV() }, "1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/v1/chat/completions");
  });
});
