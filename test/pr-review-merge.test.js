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
    expect(data.approval.tool).toBe("mergePullRequest");
    expect(data.approval.reason).toMatch(/^review: aman, test lulus\. approve\.\n\nreviewer independen tidak tersedia/);
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

import { independentReview, parseVerdict, findPRDiff } from "../src/agent/reviewer.js";
import { assertPullRequestMergeable } from "../src/tools/executor.js";

const geminiJSON = (obj) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }));

describe("reviewer independen", () => {
  it("request_changes dari reviewer MEMBLOKIR merge sebelum tombol izin muncul", async () => {
    fetch.mockImplementation(async (u) => String(u).includes("generativelanguage")
      ? geminiJSON({ verdict: "request_changes", reasons: ["data race di tasksHandler"] }) : new Response("{}"));
    fetchGeminiGenerate
      .mockResolvedValueOnce(model([{ functionCall: { name: "getPRDiff", args: PR } }]))
      .mockResolvedValueOnce(model([{ text: "kelihatannya aman" }, { functionCall: { name: "mergePullRequest", args: PR } }]))
      .mockResolvedValueOnce(model([{ text: "reviewer menemukan data race, aku ga merge dulu" }]));
    const data = await executeRemoteJob(job, platform);
    expect(data.approval).toBeUndefined();
    const blocked = fetchGeminiGenerate.mock.calls[2][2].at(-1).parts[0].functionResponse.response.content.error;
    expect(blocked).toMatch(/DIBLOKIR reviewer independen \(gemini\/m\): data race di tasksHandler/);
    expect(data.trace.find((e) => e.kind === "review")).toMatchObject({ ok: false });
  });

  it("approve dari reviewer ikut ditampilkan di tombol izin", async () => {
    fetch.mockImplementation(async (u) => String(u).includes("generativelanguage")
      ? geminiJSON({ verdict: "approve", reasons: [] }) : new Response("{}"));
    fetchGeminiGenerate
      .mockResolvedValueOnce(model([{ functionCall: { name: "getPRDiff", args: PR } }]))
      .mockResolvedValueOnce(model([{ text: "aman" }, { functionCall: { name: "mergePullRequest", args: PR } }]));
    const data = await executeRemoteJob(job, platform);
    expect(data.approval.reason).toContain("reviewer independen (gemini/m): ✅ approve");
  });

  it("reviewer tidak melihat persona/tools — hanya diff", async () => {
    fetch.mockResolvedValueOnce(geminiJSON({ verdict: "approve" }));
    await independentReview({ GEMINI_API_KEYS: "k", GEMINI_MODELS: "m", GEMINI_SYSTEM_PERSONA: "kamu cocoa" }, { diff: "+x", title: "o/r#1" });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("kamu cocoa");
    expect(body.contents[0].parts[0].text).toContain("+x");
  });

  it("parseVerdict & findPRDiff", () => {
    expect(parseVerdict('ok ```json\n{"verdict":"approve","reasons":[]}\n```')).toEqual({ verdict: "approve", reasons: [] });
    expect(parseVerdict("bukan json")).toBeNull();
    expect(parseVerdict('{"verdict":"maybe"}')).toBeNull();
    const contents = [
      { role: "model", parts: [{ functionCall: { name: "getPRDiff", args: { pull_number: 3 } } }] },
      { role: "function", parts: [{ functionResponse: { name: "getPRDiff", response: { content: "diff-3" } } }] },
      { role: "model", parts: [{ functionCall: { name: "getPRDiff", args: { pull_number: 4 } } }] },
      { role: "function", parts: [{ functionResponse: { name: "getPRDiff", response: { content: "diff-4" } } }] },
    ];
    expect(findPRDiff(contents, { pull_number: 4 })).toBe("diff-4");
    expect(findPRDiff(contents, { pull_number: 9 })).toBeNull();
  });
});

describe("cek CI sebelum merge", () => {
  const env = {};
  const gh = (pr, runs = [], status = { total_count: 0 }) => async (_e, ep) => {
    if (ep.endsWith("/check-runs?per_page=100")) return { check_runs: runs };
    if (ep.endsWith("/status")) return status;
    return pr;
  };
  const open = { state: "open", mergeable: true, head: { sha: "abc" } };

  it("CI hijau / tanpa CI -> boleh", async () => {
    callGitHubAPI.mockImplementation(gh(open, [{ name: "test", status: "completed", conclusion: "success" }]));
    await expect(assertPullRequestMergeable(env, "o", "r", 4)).resolves.toBeUndefined();
    callGitHubAPI.mockImplementation(gh(open));
    await expect(assertPullRequestMergeable(env, "o", "r", 4)).resolves.toBeUndefined();
  });

  it("CI gagal / masih jalan / konflik / sudah merged -> ditolak dengan alasan", async () => {
    callGitHubAPI.mockImplementation(gh(open, [{ name: "go test", status: "completed", conclusion: "failure" }]));
    await expect(assertPullRequestMergeable(env, "o", "r", 4)).rejects.toThrow("CI gagal (go test)");
    callGitHubAPI.mockImplementation(gh(open, [{ name: "build", status: "in_progress" }]));
    await expect(assertPullRequestMergeable(env, "o", "r", 4)).rejects.toThrow("CI masih berjalan (build)");
    callGitHubAPI.mockImplementation(gh({ ...open, mergeable: false, mergeable_state: "dirty" }));
    await expect(assertPullRequestMergeable(env, "o", "r", 4)).rejects.toThrow("konflik / dirty");
    callGitHubAPI.mockImplementation(gh({ ...open, merged: true }));
    await expect(assertPullRequestMergeable(env, "o", "r", 4)).rejects.toThrow("sudah di-merge");
  });
});
