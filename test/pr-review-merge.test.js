// Kasus nyata 2026-11-09: "review PR #4, beri komentar dan merge kalau ok".
// Model memanggil getPRDiff + mergePullRequest PARALEL; tombol izin muncul sebelum review;
// setelah ✅, Gemini 400 (thought_signature hilang di snapshot) dan merge gagal 403 tanpa kabar.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/services/gemini.js", async (orig) => ({ ...(await orig()), fetchGeminiGenerate: vi.fn() }));
vi.mock("../src/services/search.js", () => ({
  webSearch: vi.fn(), webFetch: vi.fn(), imageSearch: vi.fn(), songSearch: vi.fn(),
  youtubeSearch: vi.fn(), freeMusicSearch: vi.fn(), pipedAudioSearch: vi.fn(),
}));
vi.mock("../src/services/github.js", () => ({ callGitHubAPI: vi.fn(async () => "diff --git a/main.go") }));

import { fetchGeminiGenerate, prepareGeminiContents, SKIP_THOUGHT_SIGNATURE } from "../src/services/gemini.js";
import { callGitHubAPI } from "../src/services/github.js";
import { executeRemoteJob } from "../src/agent/remote-job.js";
import { stripMediaForSnapshot, approvalPromptText, prDiffReviewedBefore } from "../src/agent/approval.js";
import { SECRET } from "./helpers.js";

const PR = { owner: "thirapi", repo: "htmx", pull_number: 4 };
const model = (parts) => ({ candidates: [{ content: { role: "model", parts } }] });
const platform = { RUNNER_SECRET: SECRET, GEMINI_MODELS: "m", AI_PROVIDERS: "gemini" };
const job = { chatId: 9, userPrompt: "review pr #4 di thirapi/htmx, beri komentar dan merge kalau ok",
  currentContents: [{ role: "user", parts: [{ text: "review pr #4 di thirapi/htmx, beri komentar dan merge kalau ok" }] }],
  historyLen: 0, workerUrl: "https://w", secrets: { GEMINI_API_KEYS: "k", GITHUB_PAT_TOKEN: "gh" } };

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn(async () => new Response("{}"))); });

describe("thought signature (Gemini 3)", () => {
  it("signature asli dipertahankan, yang hilang diisi sentinel resmi pada call PERTAMA saja", () => {
    const out = prepareGeminiContents([
      { role: "model", parts: [{ functionCall: { name: "a" }, thoughtSignature: "ASLI" }] },
      { role: "model", parts: [{ text: "x" }, { functionCall: { name: "b" } }, { functionCall: { name: "c" } }] },
      { role: "function", parts: [{ functionResponse: { name: "b" } }] },
    ]);
    expect(out[0].parts[0].thoughtSignature).toBe("ASLI");
    expect(out[1].parts[1].thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
    expect(out[1].parts[2].thoughtSignature).toBeUndefined();
    expect(out[2].role).toBe("user");
  });

  it("snapshot approval membawa thoughtSignature (sumber error 400 setelah ✅)", () => {
    const snap = stripMediaForSnapshot([{ role: "model", parts: [
      { functionCall: { name: "mergePullRequest", args: PR }, thoughtSignature: "SIG" }, { text: "t", thoughtSignature: "S2" }] }]);
    expect(snap[0].parts[0]).toEqual({ functionCall: { name: "mergePullRequest", args: PR }, thoughtSignature: "SIG" });
    expect(snap[0].parts[1]).toEqual({ text: "t", thoughtSignature: "S2" });
  });

  it("request ke Gemini benar-benar membawa signature", async () => {
    const { fetchGeminiGenerate: real } = await vi.importActual("../src/services/gemini.js");
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(model([{ text: "ok" }]))));
    await real("m", "k", [{ role: "user", parts: [{ text: "x" }] },
      { role: "model", parts: [{ functionCall: { name: "getPRDiff", args: PR } }] },
      { role: "function", parts: [{ functionResponse: { name: "getPRDiff", response: {} } }] }],
      { CHAT_HISTORY: { get: async () => null, put: async () => {} }, DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), first: async () => null }) }) } }, null);
    const body = JSON.parse(fetch.mock.calls.at(-1)[1].body);
    expect(body.contents[1].parts[0].thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
  });
});

describe("merge harus setelah review", () => {
  it("getPRDiff + merge PARALEL -> merge ditahan tanpa tombol izin; review dulu, baru izin (dengan alasan)", async () => {
    fetchGeminiGenerate
      .mockResolvedValueOnce(model([{ functionCall: { name: "getPRDiff", args: PR } }, { functionCall: { name: "mergePullRequest", args: PR } }]))
      .mockResolvedValueOnce(model([{ text: "review: aman, test lulus. approve." }, { functionCall: { name: "mergePullRequest", args: PR } }]));
    const data = await executeRemoteJob(job, platform);
    const firstResponses = fetchGeminiGenerate.mock.calls[1][2].at(-1).parts.map((p) => p.functionResponse);
    expect(firstResponses.find((r) => r.name === "mergePullRequest").response.content.error).toMatch(/merge ditahan/);
    expect(callGitHubAPI).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("/merge"), "PUT", expect.anything());
    expect(data.approval).toMatchObject({ tool: "mergePullRequest", reason: "review: aman, test lulus. approve." });
    expect(approvalPromptText(data.approval.tool, data.approval.toolArgs, data.approval.reason)).toContain("alasan:\nreview: aman");
  });

  it("review menyimpulkan ada masalah -> model tidak merge, tidak ada tombol izin", async () => {
    fetchGeminiGenerate
      .mockResolvedValueOnce(model([{ functionCall: { name: "getPRDiff", args: PR } }]))
      .mockResolvedValueOnce(model([{ text: "request changes: ada race condition" }]));
    const data = await executeRemoteJob(job, platform);
    expect(data.approval).toBeUndefined();
    expect(data.finalText).toMatch(/request changes/);
  });

  it("prDiffReviewedBefore cocokkan nomor PR", () => {
    const prior = [{ role: "model", parts: [{ functionCall: { name: "getPRDiff", args: { ...PR, pull_number: "4" } } }] }];
    expect(prDiffReviewedBefore(prior, PR)).toBe(true);
    expect(prDiffReviewedBefore(prior, { ...PR, pull_number: 5 })).toBe(false);
    expect(prDiffReviewedBefore([], PR)).toBe(false);
  });
});

describe("tool yang disetujui tapi gagal", () => {
  it("merge 403 setelah ✅ -> user diberi tahu jelas, bukan tenggelam di jawaban model", async () => {
    fetchGeminiGenerate
      .mockResolvedValueOnce(model([{ functionCall: { name: "getPRDiff", args: PR } }]))
      .mockResolvedValueOnce(model([{ text: "aman" }, { functionCall: { name: "mergePullRequest", args: PR }, thoughtSignature: "SIG" }]));
    const paused = await executeRemoteJob(job, platform);
    expect(paused.approval.snapshot.contents.some((c) => c.parts.some((p) => p.thoughtSignature === "SIG"))).toBe(true);

    callGitHubAPI.mockImplementation(async (_e, ep) => {
      if (ep.endsWith("/merge")) throw new Error("GitHub API Error 403: Resource not accessible by integration");
      return "ok";
    });
    fetchGeminiGenerate.mockResolvedValueOnce(model([{ text: "review selesai, komentar sudah aku kirim" }]));
    const done = await executeRemoteJob({ chatId: 9, workerUrl: "https://w", secrets: job.secrets,
      resume: { decision: "approve", snapshot: paused.approval.snapshot } }, platform);
    expect(done.finalText).toMatch(/^⚠️ mergePullRequest yang kamu setujui GAGAL dijalankan: .*403.*izin write/);
    expect(done.finalText).toContain("review selesai");
  });
});
