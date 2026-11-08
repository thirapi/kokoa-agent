import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/db/index.js", () => ({
  updateTaskStatus: vi.fn(), setMemory: vi.fn(), deleteMemoriesByPrefix: vi.fn(),
  getGHAContext: vi.fn(async () => ({ id: "ctx1", instruction: "do it" })),
  consumeGHAContext: vi.fn(), getMemory: vi.fn(async () => "val"), saveGHAContext: vi.fn(),
  getHistory: vi.fn(async () => [{ role: "user", parts: [{ text: "hi" }] }]),
  addHistory: vi.fn(), trimHistory: vi.fn(),
}));

vi.mock("../src/services/spaces-poll.js", () => ({ handleSpacesResult: vi.fn(async () => ({ retryable: false })) }));
vi.mock("../src/handlers/message.js", () => ({ processMessage: vi.fn(async () => {}) }));

import * as db from "../src/db/index.js";
import { handleSpacesResult } from "../src/services/spaces-poll.js";
import { processMessage } from "../src/handlers/message.js";
import { handleAPI } from "../src/handlers/api.js";
import worker from "../src/index.js";
import { baseEnv, fakeCtx, req, bearer } from "./helpers.js";

const PROTECTED = [
  ["POST", "/api/agent-result"],
  ["POST", "/api/runner-callback"],
  ["GET", "/api/context/abc"],
  ["PUT", "/api/context/abc"],
  ["POST", "/api/memory"],
  ["GET", "/api/memory/1/key"],
  ["POST", "/api/ai-proxy/v1beta/models"],
  ["POST", "/api/telegram-proxy/sendMessage"],
  ["GET", "/api/history/123"],
];

let fetchMock;
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

const call = (path, opts) => handleAPI(req(path, opts), baseEnv(), fakeCtx());

describe("auth semua endpoint /api/*", () => {
  it("/api/health publik", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it.each(PROTECTED)("%s %s menolak tanpa token", async (method, path) => {
    const res = await call(path, { method, body: method === "GET" ? undefined : {} });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(PROTECTED)("%s %s menolak token lama yang bocor", async (method, path) => {
    const res = await call(path, { method, auth: "Bearer kokoa-runner-secret", body: method === "GET" ? undefined : {} });
    expect(res.status).toBe(401);
  });

  it("menolak semuanya bila RUNNER_SECRET belum diset di Worker", async () => {
    const env = baseEnv({ RUNNER_SECRET: undefined });
    const res = await handleAPI(req("/api/history/1", { auth: "Bearer " }), env, fakeCtx());
    expect(res.status).toBe(401);
  });

  it("/api/spaces-callback sudah dihapus (Spaces tidak lagi memanggilnya)", async () => {
    expect((await call("/api/spaces-callback", { method: "POST", auth: bearer(), body: { chatId: "1" } })).status).toBe(404);
  });

  it("endpoint tak dikenal (termasuk web-chat lama) -> 404 untuk pemegang token, 401 untuk publik", async () => {
    expect((await call("/api/web-chat/send", { method: "POST", body: { message: "hi" } })).status).toBe(401);
    expect((await call("/api/web-chat/send", { method: "POST", auth: bearer(), body: { message: "hi" } })).status).toBe(404);
  });
});

describe("/api/runner-callback", () => {
  it("workflow_result gagal -> simpan memori & kabari user", async () => {
    const res = await call("/api/runner-callback", {
      method: "POST", auth: bearer(),
      body: { chat_id: "7", type: "workflow_result", data: { status: "failed", error: "boom" } },
    });
    expect(res.status).toBe(200);
    expect(db.setMemory).toHaveBeenCalledWith(expect.anything(), "7", "workflow_status", "failed");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("api.telegram.org/bot000:TEST/sendMessage");
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: "7", text: expect.stringContaining("boom") });
  });

  it("tipe tak dikenal -> 400", async () => {
    const res = await call("/api/runner-callback", { method: "POST", auth: bearer(), body: { chat_id: "7", type: "zzz", data: {} } });
    expect(res.status).toBe(400);
  });
});

describe("/api/ai-proxy", () => {
  it("menolak host di luar allowlist", async () => {
    const res = await call("/api/ai-proxy/x", { method: "POST", auth: bearer(), headers: { "x-target-host": "169.254.169.254" }, body: {} });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("meneruskan query string ke host AI yang diizinkan", async () => {
    const res = await call("/api/ai-proxy/v1beta/models/m:generateContent?key=K", {
      method: "POST", auth: bearer(), headers: { "x-target-host": "generativelanguage.googleapis.com" }, body: { a: 1 },
    });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?key=K");
  });
});

describe("/api/context (GHA runner)", () => {
  it("mengembalikan & mengonsumsi context", async () => {
    const res = await call("/api/context/ctx1", { auth: bearer() });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("ctx1");
    expect(db.consumeGHAContext).toHaveBeenCalledWith(expect.anything(), "ctx1");
  });
});

describe("router utama (src/index.js)", () => {
  it("GET / tidak lagi menyajikan web UI", async () => {
    const res = await worker.fetch(req("/"), baseEnv(), fakeCtx());
    expect(res.status).toBe(405);
  });

  it("/api/* diarahkan ke handleAPI", async () => {
    const res = await worker.fetch(req("/api/health"), baseEnv(), fakeCtx());
    expect(res.status).toBe(200);
  });
});

describe("/api/agent-result (hasil dari Vercel)", () => {
  const post = (env, body) => handleAPI(req("/api/agent-result", { method: "POST", auth: bearer(), body }), env, ctxRef.ctx);
  const ctxRef = {};
  beforeEach(() => { ctxRef.ctx = fakeCtx(); });

  it("mengantar hasil lewat jalur yang sama dengan Spaces (source=vercel)", async () => {
    const env = baseEnv();
    const res = await post(env, { chatId: 7, data: { finalText: "halo", progressMsgId: "55" } });
    expect(res.status).toBe(200);
    await ctxRef.ctx.flush();
    expect(handleSpacesResult).toHaveBeenCalledWith(env, "7", { finalText: "halo", progressMsgId: "55" }, "55",
      { source: "vercel", fallbackOnRetryable: false });
  });

  it("pengiriman ganda (retry Vercel) hanya diproses sekali", async () => {
    const env = baseEnv();
    await post(env, { chatId: 7, data: { finalText: "a" } });
    await post(env, { chatId: 7, data: { finalText: "a" } });
    await ctxRef.ctx.flush();
    expect(handleSpacesResult).toHaveBeenCalledTimes(1);
  });

  it("gagal jaringan & prompt tersimpan -> dikerjakan ulang di Worker", async () => {
    const env = baseEnv();
    await env.CHAT_HISTORY.put("spaces_prompt:7", "cek repo x");
    handleSpacesResult.mockResolvedValueOnce({ retryable: true });
    await post(env, { chatId: 7, data: { error: "fetch failed" } });
    await ctxRef.ctx.flush();
    expect(processMessage).toHaveBeenCalledWith({ chat: { id: "7" }, text: "cek repo x" }, env, { forceRuntime: "worker" });
  });

  it("validasi body", async () => {
    expect((await post(baseEnv(), { data: {} })).status).toBe(400);
  });
});
