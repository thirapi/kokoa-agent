import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sanitizedChildEnv, executeSpacesTool, isSpacesTool } from "../src/tools/spaces-executor.js";

describe("sanitizedChildEnv", () => {
  it("membuang secret tapi mempertahankan variabel biasa", () => {
    const out = sanitizedChildEnv({
      PATH: "/bin", HOME: "/root", NODE_OPTIONS: "x", KEYBOARD: "us",
      RUNNER_SECRET: "s", TELEGRAM_BOT_TOKEN: "t", GEMINI_API_KEYS: "k", GROQ_API_KEY: "k",
      GITHUB_PAT_TOKEN: "p", GLOBAL_WORKER_PAT: "p", HF_TOKEN: "h", DB_PASSWORD: "x", OPENROUTER_API_KEY: "o",
    });
    expect(out).toEqual({ PATH: "/bin", HOME: "/root", NODE_OPTIONS: "x", KEYBOARD: "us" });
  });
});

describe("runCommand", () => {
  it("perintah buatan model tidak bisa membaca secret dari env", async () => {
    process.env.RUNNER_SECRET = "very-secret-value-123456";
    process.env.TELEGRAM_BOT_TOKEN = "tg-token-abc";
    try {
      const cwd = mkdtempSync(join(tmpdir(), "kokoa-test-"));
      const res = await executeSpacesTool("runCommand", { command: "env", cwd }, {}, "1");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("PATH=");
      expect(res.stdout).not.toContain("very-secret-value-123456");
      expect(res.stdout).not.toContain("tg-token-abc");
    } finally {
      delete process.env.RUNNER_SECRET;
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("exit code non-zero dilaporkan, bukan dilempar", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kokoa-test-"));
    const res = await executeSpacesTool("runCommand", { command: "exit 3", cwd }, {}, "1");
    expect(res.exitCode).toBe(3);
  });

  it("isSpacesTool", () => {
    expect(isSpacesTool("runCommand")).toBe(true);
    expect(isSpacesTool("webSearch")).toBe(false);
  });
});
