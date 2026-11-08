// Worker -> HF Spaces: semua request wajib membawa RUNNER_SECRET.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/db/index.js", () => ({
  getHistory: vi.fn(async () => []), getAllMemories: vi.fn(async () => []), getTasks: vi.fn(async () => []),
  addHistory: vi.fn(), trimHistory: vi.fn(), addPendingSpace: vi.fn(), removePendingSpace: vi.fn(),
  releaseChatLock: vi.fn(), acquireChatLock: vi.fn(async () => true),
  getDueReminders: vi.fn(async () => []), markReminderTriggered: vi.fn(),
  getPendingSpaces: vi.fn(async () => []), cleanupExpiredPending: vi.fn(),
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
import { handleCron } from "../src/handlers/cron.js";
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

  it("result berisi error -> false (pemanggil boleh fallback)", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "ready", error: "socket hang up" })).mockResolvedValue(json({}));
    expect(await pollSpacesResult(env, "9", null)).toBe(false);
  });
});

describe("handleSpacesResult", () => {
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

  it("mengirim reminder yang jatuh tempo & menjadwalkan ulang yang berulang", async () => {
    db.getDueReminders.mockResolvedValueOnce([{ id: 1, chat_id: "9", title: "minum", recurring: 1, interval_seconds: 60 }]);
    await handleCron({}, { ...env, HF_SPACES_URL: undefined }, fakeCtx());
    expect(sendTelegramMessage).toHaveBeenCalledWith("000:TEST", "9", expect.stringContaining("minum"));
    const [, id, now, next] = db.markReminderTriggered.mock.calls[0];
    expect(id).toBe(1);
    expect(next).toBe(now + 60);
  });
});
