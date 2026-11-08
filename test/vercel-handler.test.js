import { describe, it, expect, vi, beforeEach } from "vitest";

const pending = [];
vi.mock("@vercel/functions", () => ({ waitUntil: (p) => pending.push(p) }));
vi.mock("../src/agent/remote-job.js", () => ({
  executeRemoteJob: vi.fn(async () => ({ finalText: "ok" })),
  deliverToWorker: vi.fn(async () => true),
}));

import handler from "../api/agent.js";
import { executeRemoteJob, deliverToWorker } from "../src/agent/remote-job.js";
import { SECRET, bearer } from "./helpers.js";

function mockRes() {
  const r = { statusCode: 0, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const req = (method, { auth, body } = {}) => ({ method, headers: auth ? { authorization: auth } : {}, body });

beforeEach(() => { vi.clearAllMocks(); pending.length = 0; process.env.RUNNER_SECRET = SECRET; });

describe("api/agent.js (Vercel)", () => {
  it("GET = health check publik", async () => {
    const res = mockRes(); await handler(req("GET"), res);
    expect(res.statusCode).toBe(200);
  });

  it.each([undefined, "Bearer kokoa-runner-secret", "Bearer salah"])("POST tanpa token valid (%s) -> 401", async (auth) => {
    const res = mockRes(); await handler(req("POST", { auth, body: { chatId: 1, workerUrl: "https://w" } }), res);
    expect(res.statusCode).toBe(401);
    expect(executeRemoteJob).not.toHaveBeenCalled();
  });

  it("POST valid -> 202 segera, kerja lanjut di waitUntil lalu hasil dikirim ke Worker", async () => {
    const res = mockRes();
    await handler(req("POST", { auth: bearer(), body: { chatId: 1, workerUrl: "https://w", userPrompt: "x" } }), res);
    expect(res.statusCode).toBe(202);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(executeRemoteJob).toHaveBeenCalledWith(expect.objectContaining({ chatId: 1 }), process.env, { runtime: "vercel" });
    expect(deliverToWorker).toHaveBeenCalledWith("https://w", process.env, 1, { finalText: "ok" });
  });

  it("chatId/workerUrl wajib", async () => {
    delete process.env.WORKER_URL;
    const res = mockRes(); await handler(req("POST", { auth: bearer(), body: { chatId: 1 } }), res);
    expect(res.statusCode).toBe(400);
  });
});
