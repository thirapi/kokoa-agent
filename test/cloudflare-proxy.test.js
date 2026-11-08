// Patch fetch di Spaces: AI request lewat Worker, dan jalur langsung sebagai cadangan.
import { describe, it, expect, vi, beforeEach } from "vitest";

let calls, behavior;
beforeEach(async () => {
  vi.resetModules();
  calls = [];
  behavior = async () => new Response("{}", { status: 200 });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => { calls.push({ url: String(url), init }); return behavior(String(url), init); }));
  process.env.RUNNER_SECRET = "test-runner-secret-0123456789";
  const mod = await import("../src/utils/cloudflare-proxy.js");
  mod.setProxyWorkerUrl("https://worker.test");
});

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?key=K";

describe("cloudflare-proxy fetch patch", () => {
  it("request ke host AI dialihkan ke /api/ai-proxy Worker dengan secret", async () => {
    await fetch(GEMINI, { method: "POST", body: "{}" });
    expect(calls[0].url).toBe("https://worker.test/api/ai-proxy/v1beta/models/m:generateContent?key=K");
    const h = new Headers(calls[0].init.headers);
    expect(h.get("Authorization")).toBe("Bearer test-runner-secret-0123456789");
    expect(h.get("x-target-host")).toBe("generativelanguage.googleapis.com");
  });

  it("host lain tidak disentuh", async () => {
    await fetch("https://example.com/x");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.com/x");
  });

  it("kasus nyata: jalur ke Worker 'fetch failed' -> coba langsung ke Google", async () => {
    behavior = async (url) => {
      if (url.startsWith("https://worker.test")) throw new TypeError("fetch failed");
      return new Response('{"ok":true}', { status: 200 });
    };
    const res = await fetch(GEMINI, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["worker.test", "generativelanguage.googleapis.com"]);
  });

  it("request yang sudah dibatalkan pemanggil tidak dicoba ulang", async () => {
    const ac = new AbortController();
    behavior = async () => { ac.abort(); throw new DOMException("aborted", "AbortError"); };
    await expect(fetch(GEMINI, { method: "POST", body: "{}", signal: ac.signal })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
