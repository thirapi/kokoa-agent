// Patch fetch di Spaces: AI request lewat Worker, dan jalur langsung sebagai cadangan.
import { describe, it, expect, vi, beforeEach } from "vitest";

let calls, behavior;
beforeEach(async () => {
  vi.resetModules();
  delete process.env.AI_EGRESS_MODE;
  calls = [];
  behavior = async () => new Response("{}", { status: 200 });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => { calls.push({ url: String(url), init }); return behavior(String(url), init); }));
  process.env.RUNNER_SECRET = "test-runner-secret-0123456789";
  const mod = await import("../src/utils/cloudflare-proxy.js");
  mod.setProxyWorkerUrl("https://worker.test");
});

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?key=K";

describe("mode default 'direct' (hasil ukur egress HF)", () => {
  it("host AI dihubungi langsung, Worker tidak disentuh", async () => {
    await fetch(GEMINI, { method: "POST", body: "{}" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(GEMINI);
  });

  it("langsung gagal (jaringan) -> cadangan lewat /api/ai-proxy Worker dengan secret", async () => {
    behavior = async (url) => {
      if (url.startsWith("https://generativelanguage")) throw new TypeError("fetch failed");
      return new Response("{}", { status: 200 });
    };
    const res = await fetch(GEMINI, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(calls[1].url).toBe("https://worker.test/api/ai-proxy/v1beta/models/m:generateContent?key=K");
    const h = new Headers(calls[1].init.headers);
    expect(h.get("Authorization")).toBe("Bearer test-runner-secret-0123456789");
    expect(h.get("x-target-host")).toBe("generativelanguage.googleapis.com");
  });

  it("request yang dibatalkan pemanggil tidak dicoba ulang", async () => {
    const ac = new AbortController();
    behavior = async () => { ac.abort(); throw new DOMException("aborted", "AbortError"); };
    await expect(fetch(GEMINI, { method: "POST", body: "{}", signal: ac.signal })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("host lain tidak disentuh", async () => {
    await fetch("https://example.com/x");
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/x"]);
  });
});

describe("mode 'proxy' (perilaku lama, opsional)", () => {
  // Mode dibaca setiap request, jadi cukup set env-nya.
  beforeEach(() => { process.env.AI_EGRESS_MODE = "proxy"; });

  it("lewat Worker dulu, langsung sebagai cadangan", async () => {
    behavior = async (url) => {
      if (url.startsWith("https://worker.test")) throw new TypeError("fetch failed");
      return new Response("{}", { status: 200 });
    };
    await fetch(GEMINI, { method: "POST", body: "{}" });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["worker.test", "generativelanguage.googleapis.com"]);
  });
});
