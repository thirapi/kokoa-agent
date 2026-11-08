import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/services/gemini.js", async (orig) => ({ ...(await orig()), fetchGeminiGenerate: vi.fn() }));
vi.mock("../src/services/search.js", () => ({
  webSearch: vi.fn(async () => ({ results: [] })), webFetch: vi.fn(), imageSearch: vi.fn(), songSearch: vi.fn(),
  youtubeSearch: vi.fn(), freeMusicSearch: vi.fn(), youtubeMp3: vi.fn(),
}));
vi.mock("../src/services/github.js", () => ({ callGitHubAPI: vi.fn(async () => "diff") }));

import { fetchGeminiGenerate } from "../src/services/gemini.js";
import { executeRemoteJob } from "../src/agent/remote-job.js";
import { createTracer, summarizeArgs, formatTrace, traceStatus } from "../src/agent/trace.js";
import { SECRET } from "./helpers.js";

const model = (parts) => ({ candidates: [{ content: { role: "model", parts } }] });
const platform = { RUNNER_SECRET: SECRET, GEMINI_MODELS: "m1,m2", AI_PROVIDERS: "gemini" };
const job = (t) => ({ chatId: 3, userPrompt: t, currentContents: [{ role: "user", parts: [{ text: t }] }], historyLen: 0,
  workerUrl: "https://w", secrets: { GEMINI_API_KEYS: "k", GITHUB_PAT_TOKEN: "g" } });

beforeEach(() => vi.clearAllMocks());

describe("tracer", () => {
  it("mencatat LLM gagal/berhasil, tool, blokir, dan approval dengan urutan & durasi", async () => {
    fetchGeminiGenerate
      .mockRejectedValueOnce(new Error("GEMINI_RETRY_TRIGGER: 503 - high demand"))
      .mockResolvedValueOnce(model([{ functionCall: { name: "getPRDiff", args: { owner: "o", repo: "r", pull_number: 1 } } },
        { functionCall: { name: "mergePullRequest", args: { owner: "o", repo: "r", pull_number: 1 } } }]))
      .mockResolvedValueOnce(model([{ text: "aman" }, { functionCall: { name: "mergePullRequest", args: { owner: "o", repo: "r", pull_number: 1 } } }]));
    const data = await executeRemoteJob(job("review pr 1 di o/r lalu merge"), platform);
    const kinds = data.trace.map((e) => `${e.kind}:${e.name}:${e.ok}`);
    expect(kinds[0]).toBe("llm:gemini/m1:false");
    expect(data.trace[0].error).toMatch(/503/);
    expect(kinds).toContain("llm:gemini/m2:true");
    expect(kinds).toContain("tool:getPRDiff:true");
    expect(kinds).toContain("blocked:mergePullRequest:false");
    expect(kinds.at(-1)).toBe("approval:mergePullRequest:undefined");
    expect(data.trace.every((e, i, a) => i === 0 || e.t >= a[i - 1].t)).toBe(true);
    expect(data).toMatchObject({ runtime: "vercel", prompt: "review pr 1 di o/r lalu merge" });
    expect(traceStatus(data)).toBe("approval");
  });

  it("error non-Error (reject tanpa pesan) tidak lagi crash '.includes'", async () => {
    fetchGeminiGenerate.mockRejectedValueOnce(undefined).mockResolvedValueOnce(model([{ text: "ok" }]));
    const data = await executeRemoteJob(job("halo"), platform);
    expect(data.error).toBeNull();
    expect(data.finalText).toBe("ok");
  });

  it("summarizeArgs menyamarkan field rahasia & memotong teks panjang", () => {
    const s = summarizeArgs({ token: "abc", api_key: "x", query: "a".repeat(100) });
    expect(s).not.toContain("abc");
    expect(s).toContain('"token":"***"');
    expect(s.length).toBeLessThanOrEqual(161);
  });

  it("formatTrace merender HTML aman", () => {
    const t = createTracer();
    t.add("tool", "webFetch", { ok: false, ms: 1200, error: "<script>" });
    const html = formatTrace({ runtime: "vercel", status: "error", duration_ms: 3400, prompt: "cek <x>", events: JSON.stringify(t.events) });
    expect(html).toContain("runtime: <b>vercel</b>");
    expect(html).toContain("✗ <code>tool</code> webFetch — 1.2s · ⚠️ &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(formatTrace(null)).toMatch(/belum ada/);
  });
});
