import { describe, it, expect, vi } from "vitest";
import { runSelftest } from "../src/agent/selftest.js";
import { handleAPI } from "../src/handlers/api.js";
import { sqliteD1, fakeKV, baseEnv, fakeCtx, req, bearer } from "./helpers.js";

function prodLikeEnv(extra = {}) {
  return sqliteD1().then((DB) => ({
    DB, CHAT_HISTORY: fakeKV(), TELEGRAM_BOT_TOKEN: "0:x", GITHUB_PAT_TOKEN: "g", GEMINI_API_KEYS: "k", GEMINI_MODELS: "m",
    AI: { run: vi.fn(async () => ({ data: [new Array(1024).fill(0.1)] })) },
    VECTORIZE: { upsert: vi.fn(async () => {}), deleteByIds: vi.fn(async () => {}), query: vi.fn(), describe: vi.fn(async () => ({ dimensions: 1024, vectorCount: 3 })) },
    ...extra,
  }));
}

describe("selftest", () => {
  it("semua komponen sehat -> ok, data uji dibersihkan, tidak ada pesan Telegram", async () => {
    const fetchMock = vi.fn(async (u) => {
      if (String(u).includes("/getMe")) return new Response(JSON.stringify({ ok: true, result: { username: "kokoa_bot" } }));
      if (String(u).includes("api.github.com/user")) return new Response(JSON.stringify({ login: "ccocoa" }), { headers: { "content-type": "application/json" } });
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = await prodLikeEnv();
    const report = await runSelftest(env);
    expect(report.results.filter((r) => !r.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.results.find((r) => r.name === "github:token").detail).toBe("login ccocoa");
    expect(env.DB._db.prepare("SELECT count(*) n FROM task_traces").get().n).toBe(0);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("sendMessage"))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("tabel D1 belum dimigrasi & binding hilang -> dilaporkan gagal dengan alasan jelas", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const env = { ...baseEnv(), DB: { prepare: () => { throw new Error("no such table: task_traces"); } } };
    const report = await runSelftest(env);
    expect(report.ok).toBe(false);
    const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
    expect(byName["d1:chat_state"].error).toMatch(/belum ada/);
    expect(byName["workers-ai:embedding"].error).toMatch(/binding AI tidak ada/);
    vi.unstubAllGlobals();
  });

  it("endpoint wajib auth", async () => {
    expect((await handleAPI(req("/api/selftest"), baseEnv(), fakeCtx())).status).toBe(401);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const res = await handleAPI(req("/api/selftest", { auth: bearer() }), baseEnv(), fakeCtx());
    expect([200, 500]).toContain(res.status);
    expect((await res.json()).results.length).toBeGreaterThan(5);
    vi.unstubAllGlobals();
  });
});
