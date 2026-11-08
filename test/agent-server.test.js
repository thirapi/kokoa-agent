// Menjalankan server Spaces sungguhan (child process) dan memeriksa auth-nya.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import { SECRET, bearer } from "./helpers.js";

async function startServer(extraEnv) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PORT: String(port), ...extraEnv };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const child = spawn(process.execPath, ["src/agent-server.js"], { env, stdio: "pipe" });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return { child, base }; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("agent-server tidak mau start");
}

describe("agent-server dengan RUNNER_SECRET", () => {
  let srv;
  beforeAll(async () => { srv = await startServer({ RUNNER_SECRET: SECRET, GEMINI_API_KEYS: "", TELEGRAM_BOT_TOKEN: "0:x" }); }, 40000);
  afterAll(() => srv?.child.kill());

  it("/health tetap publik", async () => {
    const res = await fetch(`${srv.base}/health`);
    expect(res.status).toBe(200);
  });

  it.each([
    ["POST", "/api/process"],
    ["POST", "/api/resume"],
    ["GET", "/api/result/123"],
    ["DELETE", "/api/result?chatId=123"],
  ])("%s %s menolak tanpa token / token lama", async (method, path) => {
    const body = method === "POST" ? JSON.stringify({ chatId: "1", userPrompt: "env" }) : undefined;
    const none = await fetch(`${srv.base}${path}`, { method, body });
    expect(none.status).toBe(401);
    const old = await fetch(`${srv.base}${path}`, { method, body, headers: { Authorization: "Bearer kokoa-runner-secret" } });
    expect(old.status).toBe(401);
  });

  it("/health?probe=1 publik, memulai diagnosa egress tanpa membocorkan secret", async () => {
    const res = await fetch(`${srv.base}/health?probe=1`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body).probe.running).toBe(true);
    expect(body).not.toContain(SECRET);
  });

  it("menerima token yang benar", async () => {
    const res = await fetch(`${srv.base}/api/result/123`, { headers: { Authorization: bearer() } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("not_found");
  });

  it("validasi body tetap jalan setelah auth", async () => {
    const res = await fetch(`${srv.base}/api/process`, {
      method: "POST", headers: { Authorization: bearer(), "Content-Type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(400);
  });
});

describe("agent-server tanpa RUNNER_SECRET", () => {
  let srv;
  beforeAll(async () => { srv = await startServer({ RUNNER_SECRET: undefined }); }, 40000);
  afterAll(() => srv?.child.kill());

  it("fail-closed: semua /api/* ditolak", async () => {
    for (const auth of [undefined, "Bearer ", "Bearer undefined"]) {
      const res = await fetch(`${srv.base}/api/result/1`, { headers: auth ? { Authorization: auth } : {} });
      expect(res.status).toBe(401);
    }
  });
});
