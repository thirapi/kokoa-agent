// Smoke test production tanpa efek ke user: tidak mengirim pesan Telegram,
// tidak menulis ke repo. Data uji memakai id/namespace khusus lalu dibersihkan.
import { saveTaskTrace, getLatestTaskTrace } from "../db/index.js";
import { getChatState } from "../db/chat-state.js";
import { semanticMemoryAvailable, indexMemory, forgetMemoryVector, EMBEDDING_MODEL } from "./semantic-memory.js";
import { buildProviderConfigs } from "./providers.js";
import { callGitHubAPI } from "../services/github.js";
import { webSearch, imageSearch, songSearch, youtubeSearch, freeMusicSearch } from "../services/search.js";

// Uji fitur pencarian dari jaringan runtime ini (hasil bisa beda dengan laptop).
const FEATURE_PROBES = [
  ["feature:webSearch", (env) => webSearch("berita teknologi hari ini", env), (r) => String(r).length > 50 ? "ada hasil" : null],
  ["feature:imageSearch", () => imageSearch("kucing oren lucu"), (r) => r?.length ? `${r.length} gambar, mis. ${new URL(r[0].imageUrl).hostname}` : null],
  ["feature:songSearch", () => songSearch("yoasobi idol"), (r) => (Array.isArray(r) ? r : r?.results)?.length ? "ada cuplikan" : null],
  ["feature:youtubeSearch", () => youtubeSearch("yoasobi idol official"), (r) => r?.length ? `${r.length} video, mis. ${r[0].watchUrl}` : null],
  ["feature:freeMusicSearch", () => freeMusicSearch("lofi"), (r) => JSON.stringify(r).includes(".mp3") ? "ada mp3 bebas lisensi" : null],
];

export const SELFTEST_CHAT = "__selftest__";

async function check(name, fn, timeoutMs = 20000) {
  const t0 = Date.now();
  try {
    const detail = await Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), timeoutMs))]);
    return { name, ok: true, ms: Date.now() - t0, detail };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 200) };
  }
}

export async function runSelftest(env, { deep = false, features = false } = {}) {
  const checks = [
    check("d1:task_traces", async () => {
      await saveTaskTrace(env, { id: "selftest", chatId: SELFTEST_CHAT, runtime: "selftest", prompt: "selftest", status: "ok", durationMs: 1, events: [] });
      const row = await getLatestTaskTrace(env, SELFTEST_CHAT);
      if (row?.id !== "selftest") throw new Error("trace tidak terbaca kembali");
      await env.DB.prepare("DELETE FROM task_traces WHERE chat_id = ?").bind(SELFTEST_CHAT).run();
      return "tulis/baca/hapus ok";
    }),
    check("d1:chat_state", async () => {
      const s = await getChatState(env, SELFTEST_CHAT);
      if (s.backend !== "d1") throw new Error("jatuh ke KV — tabel chat_state belum ada");
      return "backend d1";
    }),
    check("d1:remote_jobs", async () => {
      await env.DB.prepare("SELECT count(*) AS n FROM remote_jobs").first();
      return "tabel ada";
    }),
    check("kv", async () => {
      await env.CHAT_HISTORY.get("__selftest__");
      return "baca ok";
    }),
    check("workers-ai:embedding", async () => {
      if (!env.AI?.run) throw new Error("binding AI tidak ada");
      const out = await env.AI.run(EMBEDDING_MODEL, { text: ["selftest"] });
      const dim = out?.data?.[0]?.length;
      if (dim !== 1024) throw new Error(`dimensi ${dim}, harus 1024`);
      return `dim ${dim}`;
    }),
    check("vectorize", async () => {
      if (!semanticMemoryAvailable(env)) throw new Error("binding VECTORIZE/AI tidak ada");
      if (!(await indexMemory(env, SELFTEST_CHAT, "selftest", "uji memori semantik"))) throw new Error("upsert gagal");
      await forgetMemoryVector(env, SELFTEST_CHAT, "selftest");
      const info = await env.VECTORIZE.describe?.().catch(() => null);
      return info ? `upsert+hapus ok (dim ${info.dimensions ?? info.config?.dimensions ?? "?"}, vektor ${info.vectorCount ?? info.vectorsCount ?? "?"})` : "upsert+hapus ok";
    }),
    check("providers", async () => {
      const cfgs = await buildProviderConfigs(env);
      if (!cfgs.length) throw new Error("tidak ada provider aktif");
      return cfgs.map((c) => `${c.name}(${c.models.length})`).join(" > ");
    }),
    check("telegram:getMe", async () => {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(10000) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.description || `HTTP ${r.status}`);
      return `@${d.result.username}`;
    }),
    check("github:token", async () => {
      const u = await callGitHubAPI(env, "user");
      return `login ${u.login}`;
    }),
    check("vercel:health", async () => {
      if (!env.VERCEL_AGENT_URL) return "tidak dikonfigurasi";
      const r = await fetch(env.VERCEL_AGENT_URL, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).runtime;
    }),
  ];
  if (features) {
    for (const [name, run, describe] of FEATURE_PROBES) {
      checks.push(check(name, async () => {
        const r = await run(env);
        if (r?.error) throw new Error(String(r.error).slice(0, 160));
        const d = describe(r);
        if (!d) throw new Error("hasil kosong");
        return d;
      }, 40000));
    }
  }
  if (deep) {
    // Satu panggilan LLM kecil lewat rotasi provider sungguhan (memakai sedikit kuota).
    checks.push(check("llm:roundtrip", async () => {
      const cfgs = await buildProviderConfigs(env);
      const errors = [];
      for (const c of cfgs) {
        for (const model of c.models.slice(0, 2)) {
          try {
            const res = await c.callAI(model, c.keys[0], [{ role: "user", parts: [{ text: "balas dengan satu kata: ok" }] }], { ...env, AGENT_MODE: "plan" }, SELFTEST_CHAT);
            const txt = (res.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
            if (txt) return `${c.name}/${model}: "${txt.slice(0, 30)}"`;
          } catch (e) {
            errors.push(`${c.name}/${model}: ${String(e.message).slice(0, 60)}`);
          }
        }
      }
      throw new Error(errors.join(" | ") || "tidak ada respons");
    }, 60000));
  }
  const results = await Promise.all(checks);
  return { ok: results.every((r) => r.ok), results };
}
