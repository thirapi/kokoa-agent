import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/handlers/message.js", () => ({ processMessage: vi.fn(async () => {}) }));
vi.mock("../src/services/telegram.js", () => ({
  sendTelegramMessage: vi.fn(async () => [{ message_id: 1 }]),
  deleteTelegramMessage: vi.fn(), sendTelegramAction: vi.fn(),
}));
vi.mock("../src/db/index.js", () => ({
  clearHistory: vi.fn(), acquireChatLock: vi.fn(async () => true), releaseChatLock: vi.fn(),
  addPendingSpace: vi.fn(async () => {}),
}));
vi.mock("../src/services/spaces-poll.js", () => ({ pollSpacesResult: vi.fn(async () => true) }));
vi.mock("../src/utils/logger.js", () => ({ logError: vi.fn(async () => {}), getRecentErrors: vi.fn(async () => []) }));

import { handleWebhook, isBotMentioned } from "../src/handlers/webhook.js";
import { processMessage } from "../src/handlers/message.js";
import * as db from "../src/db/index.js";
import { pollSpacesResult } from "../src/services/spaces-poll.js";
import { baseEnv, fakeCtx, req } from "./helpers.js";

const update = (text, { from = 111, chat = 111, updateId = Math.floor(Math.random() * 1e9) } = {}) => ({
  update_id: updateId,
  message: { message_id: 5, date: 1, text, chat: { id: chat, type: "private" }, from: { id: from, is_bot: false, first_name: "x" } },
});

const post = (body, headers = {}) => req("/", { method: "POST", body, headers });

let env, ctx;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  env = baseEnv({ ALLOWED_USER_ID: "111", BOT_USERNAME: "kokoa_bot" });
  ctx = fakeCtx();
});

describe("handleWebhook", () => {
  it("GET ditolak", async () => {
    const res = await handleWebhook(req("/"), env, ctx);
    expect(res.status).toBe(405);
  });

  it("user di luar allowlist diabaikan", async () => {
    const res = await handleWebhook(post(update("halo", { from: 999, chat: 999 })), env, ctx);
    expect(res.status).toBe(200);
    await ctx.flush();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("user yang diizinkan diproses", async () => {
    await handleWebhook(post(update("halo cocoa")), env, ctx);
    await ctx.flush();
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0][0].text).toBe("halo cocoa");
  });

  it("update duplikat tidak diproses dua kali", async () => {
    const u = update("halo", { updateId: 77 });
    await handleWebhook(post(u), env, ctx);
    await handleWebhook(post(u), env, ctx);
    await ctx.flush();
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("chat terkunci -> pesan masuk antrian", async () => {
    db.acquireChatLock.mockResolvedValueOnce(false);
    await handleWebhook(post(update("pesan kedua")), env, ctx);
    await ctx.flush();
    expect(processMessage).not.toHaveBeenCalled();
    expect(JSON.parse(await env.CHAT_HISTORY.get("pending:111")).text).toBe("pesan kedua");
  });

  it("relay __CB__ lama tidak lagi bisa memanipulasi lock/riwayat", async () => {
    const payload = btoa(JSON.stringify({ token: "kokoa-runner-secret", chatId: "111", isFinal: true, newContents: [] }));
    await handleWebhook(post(update(`__CB__${payload}`)), env, ctx);
    await ctx.flush();
    expect(db.releaseChatLock).not.toHaveBeenCalled();
  });

  describe("TELEGRAM_WEBHOOK_SECRET", () => {
    beforeEach(() => { env.TELEGRAM_WEBHOOK_SECRET = "tg-secret"; });

    it("tanpa header -> 401 & tidak diproses", async () => {
      const res = await handleWebhook(post(update("halo")), env, ctx);
      expect(res.status).toBe(401);
      await ctx.flush();
      expect(processMessage).not.toHaveBeenCalled();
    });

    it("header salah -> 401", async () => {
      const res = await handleWebhook(post(update("halo"), { "X-Telegram-Bot-Api-Secret-Token": "salah" }), env, ctx);
      expect(res.status).toBe(401);
    });

    it("header benar -> diproses", async () => {
      const res = await handleWebhook(post(update("halo"), { "X-Telegram-Bot-Api-Secret-Token": "tg-secret" }), env, ctx);
      expect(res.status).toBe(200);
      await ctx.flush();
      expect(processMessage).toHaveBeenCalledTimes(1);
    });
  });
});

describe("tombol approval untuk tugas di Spaces", () => {
  it("✅ -> resume di Spaces, didaftarkan untuk polling, lock TIDAK dilepas lebih awal", async () => {
    env.HF_SPACES_URL = "https://space.test";
    await env.CHAT_HISTORY.put("approval:ap1", JSON.stringify({
      status: "pending",
      snapshot: { runtime: "spaces", chatId: "111", contents: [], pending: { tool: "mergePullRequest", key: "k" } },
    }));
    globalThis.fetch.mockImplementation(async () => new Response("{}", { status: 200 }));
    const cb = { update_id: 900, callback_query: { id: "q", data: "approve:ap1", from: { id: 111 }, message: { message_id: 3, chat: { id: 111, type: "private" } } } };
    await handleWebhook(post(cb), env, ctx);
    await ctx.flush();
    const resumeCall = globalThis.fetch.mock.calls.find(([u]) => String(u) === "https://space.test/api/resume");
    expect(resumeCall).toBeTruthy();
    expect(new Headers(resumeCall[1].headers).get("Authorization")).toBe(`Bearer ${env.RUNNER_SECRET}`);
    expect(db.addPendingSpace).toHaveBeenCalledWith(env, "111");
    expect(pollSpacesResult).toHaveBeenCalledWith(env, "111", null);
    expect(db.releaseChatLock).not.toHaveBeenCalled();
    expect(JSON.parse(await env.CHAT_HISTORY.get("approval:ap1")).status).toBe("approved");
  });
});

describe("isBotMentioned", () => {
  const bot = { username: "kokoa_bot", id: 42 };
  it("mention bot", () => {
    expect(isBotMentioned({ text: "@kokoa_bot halo", entities: [{ type: "mention", offset: 0, length: 10 }] }, bot)).toBe(true);
  });
  it("mention orang lain tidak dihitung", () => {
    expect(isBotMentioned({ text: "@pacar halo", entities: [{ type: "mention", offset: 0, length: 6 }] }, bot)).toBe(false);
  });
  it("reply ke bot dihitung", () => {
    expect(isBotMentioned({ text: "iya", reply_to_message: { from: { is_bot: true } } }, bot)).toBe(true);
  });
});
