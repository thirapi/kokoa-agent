// Fitur yang bergantung pada tabel D1 baru, diuji dengan SQLite + schema.sql asli.
import { describe, it, expect, vi } from "vitest";
import { sqliteD1, fakeKV } from "./helpers.js";
import { getChatState, markUpdateSeen } from "../src/db/chat-state.js";
import { saveTaskTrace, getLatestTaskTrace, pruneTaskTraces, markRemoteJobStarted, markRemoteJobDone, getStaleRemoteJobs } from "../src/db/index.js";
import { preferLightModels } from "../src/agent/providers.js";

describe("chat_state (dedupe & rate limit)", () => {
  it("D1: satu tulis per update, rate limit tidak hilang saat update berikutnya tanpa requestAt", async () => {
    const env = { DB: await sqliteD1(), CHAT_HISTORY: fakeKV() };
    expect(await getChatState(env, "1")).toMatchObject({ lastUpdateId: null, backend: "d1" });
    await markUpdateSeen(env, "1", 10, { requestAt: 1000 });
    await markUpdateSeen(env, "1", 11);
    expect(await getChatState(env, "1")).toMatchObject({ lastUpdateId: "11", lastRequestAt: 1000 });
    expect(env.CHAT_HISTORY.store.size).toBe(0); // tidak ada tulis KV
  });

  it("tabel belum ada (migrasi belum jalan) -> otomatis pakai KV", async () => {
    const env = { DB: { prepare: () => { throw new Error("no such table: chat_state"); } }, CHAT_HISTORY: fakeKV() };
    await markUpdateSeen(env, "1", 7, { requestAt: 5 });
    expect(await getChatState(env, "1")).toMatchObject({ lastUpdateId: "7", lastRequestAt: 5, backend: "kv" });
  });
});

describe("task_traces & remote_jobs di D1", () => {
  it("simpan, ambil terbaru, dan pangkas trace", async () => {
    const env = { DB: await sqliteD1() };
    await saveTaskTrace(env, { id: "a", chatId: 1, runtime: "worker", prompt: "p1", status: "ok", durationMs: 10, events: [{ t: 0 }] });
    await saveTaskTrace(env, { id: "b", chatId: 1, runtime: "vercel", prompt: "p2", status: "error", durationMs: 20, events: [] });
    expect((await getLatestTaskTrace(env, 1)).id).toBe("b");
    env.DB._db.exec("UPDATE task_traces SET created_at = unixepoch() - 999999 WHERE id = 'a'");
    await pruneTaskTraces(env);
    expect(env.DB._db.prepare("SELECT count(*) n FROM task_traces").get().n).toBe(1);
  });

  it("job jarak jauh: tercatat, basi setelah batas waktu, hilang saat selesai", async () => {
    const env = { DB: await sqliteD1() };
    await markRemoteJobStarted(env, 9, "vercel", "cek repo");
    expect(await getStaleRemoteJobs(env, 360)).toEqual([]);
    env.DB._db.exec("UPDATE remote_jobs SET started_at = unixepoch() - 400");
    expect(await getStaleRemoteJobs(env, 360)).toMatchObject([{ chat_id: "9", runtime: "vercel", prompt: "cek repo" }]);
    await markRemoteJobDone(env, 9);
    expect(await getStaleRemoteJobs(env, 0)).toEqual([]);
  });
});

describe("model ringan untuk obrolan ringan", () => {
  it("model lite didahulukan di dalam provider, urutan provider tetap", () => {
    const out = preferLightModels([
      { name: "gemini", models: ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.5-flash"] },
      { name: "cerebras", models: ["gpt-oss-120b"] },
    ]);
    expect(out.map((c) => c.name)).toEqual(["gemini", "cerebras"]);
    expect(out[0].models).toEqual(["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.5-flash"]);
    expect(out[1].models).toEqual(["gpt-oss-120b"]);
    expect(preferLightModels([{ name: "g", models: ["gemini-3.6-flash"] }])[0].models).toEqual(["gemini-3.6-flash"]);
    expect(preferLightModels([{ name: "q", models: ["llama-3.3-70b", "llama-3.1-8b-instant"] }])[0].models[0]).toBe("llama-3.1-8b-instant");
  });
});
