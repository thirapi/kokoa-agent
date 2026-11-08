// Mengukur koneksi keluar dari HF Space: langsung (tanpa proxy) vs lewat Worker.
// Tiap percobaan memakai koneksi TCP+TLS baru (agent:false) — persis kondisi
// yang memicu RST di NAT HF. Hasil hanya berisi host, status & latensi (tanpa secret).
import { rawHttpsRequest } from "./cloudflare-proxy.js";

const ATTEMPTS = 5;
const GAP_MS = 1500;
const TIMEOUT_MS = 8000;

function once(url, headers = {}) {
  const u = new URL(url);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = rawHttpsRequest({
      hostname: u.hostname, path: u.pathname + u.search, method: "GET",
      headers: { "User-Agent": "kokoa-egress-probe", ...headers },
      agent: false, timeout: TIMEOUT_MS,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ok: true, status: res.statusCode, ms: Date.now() - t0 }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ ok: false, error: (e.code || e.message || "error").slice(0, 80), ms: Date.now() - t0 }));
    req.end();
  });
}

async function probeTarget(t) {
  const runs = [];
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i) await new Promise((r) => setTimeout(r, GAP_MS));
    runs.push(await once(t.url, t.headers));
  }
  const okRuns = runs.filter((r) => r.ok);
  const ms = okRuns.map((r) => r.ms).sort((a, b) => a - b);
  return {
    name: t.name,
    ok: `${okRuns.length}/${runs.length}`,
    statuses: [...new Set(okRuns.map((r) => r.status))],
    errors: [...new Set(runs.filter((r) => !r.ok).map((r) => r.error))],
    medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : null,
    sequence: runs.map((r) => (r.ok ? "✓" : "✗")).join(""),
  };
}

export function probeTargets(workerUrl, runnerSecret) {
  const t = [
    { name: "direct:gemini", url: "https://generativelanguage.googleapis.com/v1beta/models" },
    { name: "direct:groq", url: "https://api.groq.com/openai/v1/models" },
    { name: "direct:openrouter", url: "https://openrouter.ai/api/v1/models" },
    { name: "direct:telegram", url: "https://api.telegram.org/" },
    { name: "direct:github", url: "https://api.github.com/zen" },
  ];
  if (workerUrl) {
    t.push({ name: "worker:health", url: `${workerUrl}/api/health` });
    if (runnerSecret) {
      t.push({
        name: "worker:ai-proxy->gemini",
        url: `${workerUrl}/api/ai-proxy/v1beta/models`,
        headers: { Authorization: `Bearer ${runnerSecret}`, "x-target-host": "generativelanguage.googleapis.com" },
      });
    }
  }
  return t;
}

let running = null;
let last = null;

// Mulai probe di latar belakang (maks 1x/60 detik); kembalikan status + hasil terakhir.
export function triggerProbe(workerUrl, runnerSecret) {
  const fresh = last && Date.now() - last.finishedAt < 60000;
  if (!running && !fresh) {
    const startedAt = Date.now();
    running = Promise.all(probeTargets(workerUrl, runnerSecret).map(probeTarget))
      .then((results) => { last = { startedAt, finishedAt: Date.now(), results }; })
      .finally(() => { running = null; });
  }
  return { running: !!running, last };
}
