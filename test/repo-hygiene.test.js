// Penjaga regresi level repo: secret tidak boleh kembali ter-hardcode,
// dan workflow GHA wajib punya pengaman dasar.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", ".wrangler", "test", "dist"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx|mjs|json|jsonc|ya?ml|toml)$/.test(name) || name === "Dockerfile") out.push(p);
  }
  return out;
}

describe("repo hygiene", () => {
  const files = walk(".").filter((f) => !f.endsWith("package-lock.json"));

  it("tidak ada secret runner yang ter-hardcode", () => {
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes("kokoa-runner-secret"));
    expect(offenders).toEqual([]);
  });

  it("tidak ada token Telegram/GitHub/Gemini mentah di kode", () => {
    const patterns = [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/, /\bghp_[A-Za-z0-9]{30,}\b/, /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, /\bAIza[0-9A-Za-z_-]{35}\b/];
    const offenders = files.filter((f) => {
      const s = readFileSync(f, "utf8");
      return patterns.some((p) => p.test(s));
    });
    expect(offenders).toEqual([]);
  });

  it("workflow kokoa-dev punya timeout, concurrency, notifikasi gagal, dan RUNNER_SECRET", () => {
    const y = readFileSync(".github/workflows/kokoa-dev.yml", "utf8");
    expect(y).toMatch(/timeout-minutes:\s*\d+/);
    expect(y).toMatch(/concurrency:/);
    expect(y).toMatch(/if:\s*failure\(\)/);
    expect(y).toMatch(/RUNNER_SECRET:\s*\$\{\{\s*secrets\.RUNNER_SECRET\s*\}\}/);
  });

  it("deploy hanya jalan setelah test lulus", () => {
    const y = readFileSync(".github/workflows/deploy.yml", "utf8");
    expect(y).toMatch(/npm test/);
    expect(y).toMatch(/needs:\s*test/);
  });

  it("deploy menyebar RUNNER_SECRET ke Worker & Space sebelum kode baru live", () => {
    const y = readFileSync(".github/workflows/deploy.yml", "utf8");
    const cf = y.indexOf("wrangler secret put RUNNER_SECRET");
    const hf = y.indexOf("/api/spaces/thirapi/tg-bot-cocoa/secrets");
    expect(cf).toBeGreaterThan(-1);
    expect(hf).toBeGreaterThan(-1);
    expect(cf).toBeLessThan(y.indexOf("npx wrangler deploy"));
    expect(hf).toBeLessThan(y.indexOf("git push -f hf main"));
  });

  it("web UI sudah tidak dibundel", () => {
    const w = readFileSync("wrangler.jsonc", "utf8");
    expect(w).not.toMatch(/"assets"/);
  });
});
