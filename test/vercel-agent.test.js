// Runtime Vercel: handler api/agent.js + executeRemoteJob + pengantaran ke Worker.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/services/gemini.js", () => ({ fetchGeminiGenerate: vi.fn(), checkGeminiQuota: vi.fn() }));
vi.mock("../src/services/search.js", () => ({
  webSearch: vi.fn(async () => ({ results: [] })), webFetch: vi.fn(), imageSearch: vi.fn(),
  songSearch: vi.fn(), youtubeSearch: vi.fn(), freeMusicSearch: vi.fn(), pipedAudioSearch: vi.fn(),
}));
vi.mock("../src/services/github.js", () => ({ callGitHubAPI: vi.fn(async () => ({})) }));

import { fetchGeminiGenerate } from "../src/services/gemini.js";
import { executeRemoteJob, deliverToWorker } from "../src/agent/remote-job.js";
import { buildDetachedEnv, pickForwardedConfig } from "../src/agent/detached-env.js";
import { SECRET, bearer } from "./helpers.js";

const text = (t) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const call = (name, args = {}) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });
const platform = { RUNNER_SECRET: SECRET, GEMINI_MODELS: "m", AI_PROVIDERS: "gemini" };
const job = (extra = {}) => ({
  chatId: 7, userPrompt: "cek bug di repo thirapi/x",
  currentContents: [{ role: "user", parts: [{ text: "lama" }] }, { role: "model", parts: [{ text: "ok" }] },
    { role: "user", parts: [{ text: "cek bug di repo thirapi/x" }] }],
  historyLen: 2, memories: [{ key: "nama", value: "faiq" }], tasks: [], mode: "build", progressMsgId: "55",
  workerUrl: "https://worker.test", config: { GEMINI_SYSTEM_PERSONA: "kamu cocoa" },
  secrets: { GEMINI_API_KEYS: "k", TELEGRAM_BOT_TOKEN: "0:x", GITHUB_PAT_TOKEN: "gh" }, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

describe("detached env", () => {
  it("hanya meneruskan config non-rahasia dari Worker", () => {
    const cfg = pickForwardedConfig({ GEMINI_SYSTEM_PERSONA: "p", AI_PROVIDERS: "gemini", TELEGRAM_BOT_TOKEN: "rahasia", RUNNER_SECRET: "x", GEMINI_API_KEYS: "k" });
    expect(cfg).toEqual({ GEMINI_SYSTEM_PERSONA: "p", AI_PROVIDERS: "gemini" });
  });

  it("key provider dari Worker dipakai bila env platform kosong; RUNNER_SECRET tidak bisa diteruskan", () => {
    const env = buildDetachedEnv({ RUNNER_SECRET: "platform" }, {
      secrets: { GEMINI_API_KEYS: "dari-worker", RUNNER_SECRET: "palsu", CHAT_HISTORY: "x" },
    });
    expect(env.GEMINI_API_KEYS).toBe("dari-worker");
    expect(env.RUNNER_SECRET).toBe("platform");
    expect(typeof env.CHAT_HISTORY.get).toBe("function");
  });

  it("env platform menang atas key yang diteruskan", () => {
    expect(buildDetachedEnv({ GEMINI_API_KEYS: "platform" }, { secrets: { GEMINI_API_KEYS: "worker" } }).GEMINI_API_KEYS).toBe("platform");
  });

  it("config dari request tidak bisa menimpa secret platform", () => {
    const env = buildDetachedEnv({ GEMINI_API_KEYS: "asli" }, { config: { GEMINI_API_KEYS: "palsu" } });
    expect(env.GEMINI_API_KEYS).toBe("asli");
  });
});

describe("executeRemoteJob", () => {
  it("menjalankan loop & mengembalikan jawaban + konten baru (mulai dari pesan user)", async () => {
    fetchGeminiGenerate.mockResolvedValueOnce(text("udah aku cek, aman"));
    const data = await executeRemoteJob(job(), platform);
    expect(data.finalText).toBe("udah aku cek, aman");
    expect(data.error).toBeNull();
    expect(data.progressMsgId).toBe("55");
    expect(data.newContent[0]).toMatchObject({ role: "user", parts: [{ text: "cek bug di repo thirapi/x" }] });
    expect(data.newContent.at(-1)).toMatchObject({ role: "model" });
    // persona dari Worker sampai ke prompt
    expect(fetchGeminiGenerate.mock.calls[0][3].GEMINI_SYSTEM_PERSONA).toBe("kamu cocoa");
  });

  it("tool berisiko -> hasil berisi approval (snapshot runtime 'vercel'), bukan error", async () => {
    fetchGeminiGenerate
      .mockResolvedValueOnce(call("getPRDiff", { owner: "thirapi", repo: "x", pull_number: 3 }))
      .mockResolvedValueOnce(call("mergePullRequest", { owner: "thirapi", repo: "x", pull_number: 3 }));
    const data = await executeRemoteJob(job(), platform);
    expect(data.error).toBeNull();
    expect(data.approval).toMatchObject({ tool: "mergePullRequest", snapshot: { runtime: "vercel", chatId: "7" } });
    expect(data.approval.id).toBeTruthy();
  });

  it("resume setelah ✅: tool yang di-approve dijalankan lalu loop lanjut", async () => {
    fetchGeminiGenerate
      .mockResolvedValueOnce(call("getPRDiff", { owner: "thirapi", repo: "x", pull_number: 3 }))
      .mockResolvedValueOnce(call("mergePullRequest", { owner: "thirapi", repo: "x", pull_number: 3 }));
    const first = await executeRemoteJob(job(), platform);
    fetchGeminiGenerate.mockResolvedValueOnce(text("PR udah di-merge"));
    const data = await executeRemoteJob({ chatId: 7, workerUrl: "https://worker.test", secrets: job().secrets,
      resume: { decision: "approve", snapshot: first.approval.snapshot } }, platform);
    expect(data.finalText).toBe("PR udah di-merge");
    const { callGitHubAPI } = await import("../src/services/github.js");
    expect(callGitHubAPI).toHaveBeenCalledWith(expect.anything(), "repos/thirapi/x/pulls/3/merge", "PUT", expect.anything());
  });

  it("error provider dikembalikan sebagai data.error (Worker yang memutuskan retry)", async () => {
    fetchGeminiGenerate.mockRejectedValue(new Error("GEMINI_RETRY_TRIGGER: 503 - high demand"));
    const data = await executeRemoteJob(job(), platform);
    expect(data.error).toMatch(/503/);
    expect(data.finalText).toBeNull();
  });
});

describe("deliverToWorker", () => {
  it("POST /api/agent-result dengan Authorization", async () => {
    const ok = await deliverToWorker("https://worker.test", platform, 7, { finalText: "x" });
    expect(ok).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://worker.test/api/agent-result");
    expect(init.headers.Authorization).toBe(bearer());
    expect(JSON.parse(init.body)).toEqual({ chatId: "7", data: { finalText: "x" } });
  });

  it("coba ulang saat jaringan/5xx gagal, berhenti di 4xx", async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(new Response("", { status: 502 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
    expect(await deliverToWorker("https://w", platform, 1, {}, { fetchImpl: f })).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
    const g = vi.fn(async () => new Response("", { status: 401 }));
    expect(await deliverToWorker("https://w", platform, 1, {}, { fetchImpl: g })).toBe(false);
    expect(g).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
