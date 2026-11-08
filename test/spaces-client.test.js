// Worker -> HF Spaces: semua request wajib membawa RUNNER_SECRET.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/db/index.js", () => ({
  getHistory: vi.fn(async () => []), getAllMemories: vi.fn(async () => []), getTasks: vi.fn(async () => []),
  addHistory: vi.fn(), trimHistory: vi.fn(), addPendingSpace: vi.fn(), removePendingSpace: vi.fn(),
  releaseChatLock: vi.fn(), acquireChatLock: vi.fn(async () => true),
  getDueReminders: vi.fn(async () => []), markReminderTriggered: vi.fn(),
  getPendingSpaces: vi.fn(async () => []), cleanupExpiredPending: vi.fn(), saveTaskTrace: vi.fn(), pruneTaskTraces: vi.fn(),
  markRemoteJobDone: vi.fn(), markRemoteJobStarted: vi.fn(), getStaleRemoteJobs: vi.fn(async () => []),
}));
vi.mock("../src/services/telegram.js", () => ({
  sendTelegramMessage: vi.fn(async () => [{ message_id: 1 }]), deleteTelegramMessage: vi.fn(async () => {}),
  sendTelegramPhoto: vi.fn(), sendTelegramAudio: vi.fn(), sendTelegramAction: vi.fn(),
}));
vi.mock("../src/handlers/message.js", () => ({ processMessage: vi.fn(async () => {}) }));

import * as db from "../src/db/index.js";
import { sendTelegramMessage } from "../src/services/telegram.js";
import { processViaSpaces } from "../src/services/hf-spaces.js";
import { pollSpacesResult, handleSpacesResult } from "../src/services/spaces-poll.js";
import { handleCron, reapStaleRemoteJobs } from "../src/handlers/cron.js";
import { baseEnv, fakeCtx, bearer } from "./helpers.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
let env, fetchMock;

beforeEach(() => {
  vi.clearAllMocks();
  env = baseEnv({ HF_SPACES_URL: "https://space.test", WORKER_URL: "https://worker.test" });
  fetchMock = vi.fn(async () => json({ status: "processing" }));
  vi.stubGlobal("fetch", fetchMock);
});

const authOf = (call) => new Headers(call[1]?.headers).get("Authorization");

describe("processViaSpaces", () => {
  it("POST /api/process dengan Authorization & mendaftarkan pending", async () => {
    const res = await processViaSpaces(env, "9", "tolong cek repo", null, [], "55");
    expect(res.status).toBe("processing");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://space.test/api/process");
    expect(authOf(fetchMock.mock.calls[0])).toBe(bearer());
    expect(JSON.parse(init.body)).toMatchObject({ chatId: "9", userPrompt: "tolong cek repo", progressMsgId: "55" });
    expect(db.addPendingSpace).toHaveBeenCalledWith(env, "9");
  });

  it("429 dari Spaces -> busy", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 429));
    expect((await processViaSpaces(env, "9", "x", null, [])).status).toBe("busy");
  });

  it("error lain dilempar agar pemanggil fallback ke Worker", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(processViaSpaces(env, "9", "x", null, [])).rejects.toThrow(/HF Spaces error \(500\)/);
  });

  it("tidak mengirim apa pun bila RUNNER_SECRET belum diset", async () => {
    await expect(processViaSpaces({ ...env, RUNNER_SECRET: undefined }, "9", "x", null, [])).rejects.toThrow(/RUNNER_SECRET/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pollSpacesResult", () => {
  it("polling pakai Authorization, mengantar hasil, lalu hapus result di Spaces (juga dengan auth)", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ status: "ready", finalText: "halo!", newContent: [{ role: "model", parts: [{ text: "halo!" }] }], historySynced: false }))
      .mockResolvedValue(json({ status: "deleted" }));
    const ok = await pollSpacesResult(env, "9", null);
    expect(ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://space.test/api/result/9");
    expect(authOf(fetchMock.mock.calls[0])).toBe(bearer());
    const del = fetchMock.mock.calls.find(([u, i]) => i?.method === "DELETE");
    expect(del[0]).toBe("https://space.test/api/result?chatId=9");
    expect(authOf(del)).toBe(bearer());
    expect(db.addHistory).toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledWith("000:TEST", "9", expect.stringContaining("halo!"));
    expect(db.releaseChatLock).toHaveBeenCalledWith(env, "9");
  });

  it("error jaringan -> false, TANPA pesan error ke user & lock tetap dipegang (Worker lanjut)", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "ready", error: "GEMINI_RETRY_TRIGGER: Request Timeout" })).mockResolvedValue(json({}));
    expect(await pollSpacesResult(env, "9", null)).toBe(false);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(db.releaseChatLock).not.toHaveBeenCalled();
  });

  it("error non-jaringan -> dilaporkan ke user & selesai (tidak di-retry)", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "ready", error: "GEMINI_KEY_INVALID: 400" })).mockResolvedValue(json({}));
    expect(await pollSpacesResult(env, "9", null)).toBe(true);
    expect(sendTelegramMessage).toHaveBeenCalledWith("000:TEST", "9", expect.stringContaining("GEMINI_KEY_INVALID"));
    expect(db.releaseChatLock).toHaveBeenCalled();
  });
});

describe("handleSpacesResult", () => {
  it("menyimpan trace dari runtime jarak jauh ke D1", async () => {
    fetchMock.mockResolvedValue(json({}));
    const trace = [{ t: 0, kind: "llm", name: "gemini/m", ok: true }];
    await handleSpacesResult(env, "9", { finalText: "x", trace, runtime: "vercel", prompt: "p", durationMs: 1234 }, null, { source: "vercel" });
    expect(db.saveTaskTrace).toHaveBeenCalledWith(env, { chatId: "9", runtime: "vercel", prompt: "p", status: "ok", durationMs: 1234, events: trace });
  });

  it("kasus nyata: Spaces menunggu izin -> Worker simpan snapshot & kirim tombol, TANPA pesan 'loop selesai'", async () => {
    fetchMock.mockResolvedValue(json({}));
    const approval = { id: "ap1", tool: "mergePullRequest", toolArgs: { pull_number: 3 }, snapshot: { runtime: "spaces", chatId: "9", pending: { tool: "mergePullRequest", key: "k" } } };
    await handleSpacesResult(env, "9", { status: "ready", finalText: null, newContent: [], approval }, null);
    expect(JSON.parse(await env.CHAT_HISTORY.get("approval:ap1"))).toMatchObject({ status: "pending", snapshot: { runtime: "spaces" } });
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    const [, , text, markup] = sendTelegramMessage.mock.calls[0];
    expect(text).toContain("mergePullRequest");
    expect(JSON.stringify(markup)).toContain("approve:ap1");
    expect(sendTelegramMessage.mock.calls.some((c) => /teks penutupnya/.test(c[2]))).toBe(false);
    expect(db.releaseChatLock).toHaveBeenCalledWith(env, "9");
    expect(await env.CHAT_HISTORY.get("last_approval_msg:9")).toBe("1");
  });

  it("approval baru mencopot tombol approval lama", async () => {
    fetchMock.mockResolvedValue(json({}));
    await env.CHAT_HISTORY.put("last_approval_msg:9", "77");
    await handleSpacesResult(env, "9", { status: "ready", approval: { id: "ap2", tool: "deleteFile", snapshot: {} } }, null);
    const edit = fetchMock.mock.calls.find(([u]) => String(u).includes("editMessageReplyMarkup"));
    expect(JSON.parse(edit[1].body)).toMatchObject({ chat_id: "9", message_id: 77 });
  });

  it("tidak menyimpan riwayat dua kali bila Spaces sudah sync via callback", async () => {
    fetchMock.mockResolvedValue(json({}));
    await handleSpacesResult(env, "9", { status: "ready", finalText: "x", newContent: [{ role: "model", parts: [{ text: "x" }] }], historySynced: true });
    expect(db.addHistory).not.toHaveBeenCalled();
  });

  it("tidak mengirim jawaban dua kali bila proxy Spaces sudah mengirim", async () => {
    fetchMock.mockResolvedValue(json({}));
    await handleSpacesResult(env, "9", { status: "ready", finalText: "x", proxySent: true });
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(db.releaseChatLock).toHaveBeenCalled();
  });
});

describe("cron", () => {
  it("polling pending Spaces pakai Authorization", async () => {
    db.getPendingSpaces.mockResolvedValueOnce([{ chat_id: "9" }]);
    fetchMock.mockResolvedValueOnce(json({ status: "processing" }));
    await handleCron({}, env, fakeCtx());
    expect(fetchMock.mock.calls[0][0]).toBe("https://space.test/api/result/9");
    expect(authOf(fetchMock.mock.calls[0])).toBe(bearer());
  });

  it("result hilang (Space restart) -> kabari user & lepas lock", async () => {
    db.getPendingSpaces.mockResolvedValueOnce([{ chat_id: "9" }]);
    fetchMock.mockResolvedValueOnce(json({ status: "not_found" }));
    await handleCron({}, env, fakeCtx());
    expect(sendTelegramMessage).toHaveBeenCalledWith("000:TEST", "9", expect.stringContaining("restart"));
    expect(db.releaseChatLock).toHaveBeenCalledWith(env, "9");
  });

  it("kasus nyata: Spaces timeout ke Gemini -> cron mengerjakan ulang di Worker, bukan kirim error", async () => {
    const { processMessage } = await import("../src/handlers/message.js");
    await env.CHAT_HISTORY.put("spaces_prompt:9", "cek struktur repo thirapi/kokoa-agent");
    db.getPendingSpaces.mockResolvedValueOnce([{ chat_id: "9" }]);
    fetchMock.mockResolvedValueOnce(json({ status: "ready", error: "GEMINI_RETRY_TRIGGER: Request Timeout", newContent: [] }))
      .mockResolvedValue(json({}));
    await handleCron({}, env, fakeCtx());
    expect(sendTelegramMessage).not.toHaveBeenCalledWith("000:TEST", "9", expect.stringContaining("yah eror"));
    expect(processMessage).toHaveBeenCalledWith(
      { chat: { id: "9" }, text: "cek struktur repo thirapi/kokoa-agent" }, env, { forceRuntime: "worker" });
    expect(db.releaseChatLock).not.toHaveBeenCalled();
    expect(await env.CHAT_HISTORY.get("spaces_prompt:9")).toBeNull();
  });

  it("tanpa prompt tersimpan (mis. pesan bermedia) -> error tetap dilaporkan", async () => {
    const { processMessage } = await import("../src/handlers/message.js");
    db.getPendingSpaces.mockResolvedValueOnce([{ chat_id: "9" }]);
    fetchMock.mockResolvedValueOnce(json({ status: "ready", error: "fetch failed" })).mockResolvedValue(json({}));
    await handleCron({}, env, fakeCtx());
    expect(processMessage).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledWith("000:TEST", "9", expect.stringContaining("fetch failed"));
    expect(db.releaseChatLock).toHaveBeenCalled();
  });

  it("mengirim reminder yang jatuh tempo & menjadwalkan ulang yang berulang", async () => {
    db.getDueReminders.mockResolvedValueOnce([{ id: 1, chat_id: "9", title: "minum", recurring: 1, interval_seconds: 60 }]);
    await handleCron({}, { ...env, HF_SPACES_URL: undefined }, fakeCtx());
    expect(sendTelegramMessage).toHaveBeenCalledWith("000:TEST", "9", expect.stringContaining("minum"));
    const [, id, now, next] = db.markReminderTriggered.mock.calls[0];
    expect(id).toBe(1);
    expect(next).toBe(now + 60);
  });
});

describe("watchdog tugas Vercel", () => {
  it("tugas tanpa kabar > 6 menit: user dikabari, lock & pesan progres dibersihkan", async () => {
    const { deleteTelegramMessage } = await import("../src/services/telegram.js");
    db.getStaleRemoteJobs.mockResolvedValueOnce([{ chat_id: "9", runtime: "vercel", prompt: "cek repo" }]);
    await env.CHAT_HISTORY.put("progress_msg:9", "55");
    expect(await reapStaleRemoteJobs(env)).toBe(1);
    expect(db.markRemoteJobDone).toHaveBeenCalledWith(env, "9");
    expect(db.releaseChatLock).toHaveBeenCalledWith(env, "9");
    expect(deleteTelegramMessage).toHaveBeenCalledWith("000:TEST", "9", 55);
    expect(sendTelegramMessage).toHaveBeenCalledWith("000:TEST", "9", expect.stringContaining("/retry"));
  });

  it("tidak mengganggu tugas yang hasilnya sedang diantar", async () => {
    db.getStaleRemoteJobs.mockResolvedValueOnce([{ chat_id: "9", runtime: "vercel" }]);
    await env.CHAT_HISTORY.put("hdl:9", "1");
    await reapStaleRemoteJobs(env);
    expect(db.releaseChatLock).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("hasil dari Vercel menandai tugas selesai", async () => {
    fetchMock.mockResolvedValue(json({}));
    await handleSpacesResult(env, "9", { finalText: "x" }, null, { source: "vercel" });
    expect(db.markRemoteJobDone).toHaveBeenCalledWith(env, "9");
  });

  it("cron menjalankan watchdog", async () => {
    await handleCron({ scheduledTime: Date.UTC(2026, 10, 9, 1, 7) }, env, fakeCtx());
    expect(db.getStaleRemoteJobs).toHaveBeenCalled();
  });
});
