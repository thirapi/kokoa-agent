import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectTestCommand, runProjectTests, testReportMarkdown } from "../src/utils/project-tests.js";

const repo = (files) => {
  const d = mkdtempSync(join(tmpdir(), "kokoa-proj-"));
  for (const [f, c] of Object.entries(files)) {
    if (f.endsWith("/")) mkdirSync(join(d, f), { recursive: true });
    else writeFileSync(join(d, f), c);
  }
  return d;
};

describe("deteksi test repo", () => {
  it("go / node / python / tanpa test", () => {
    expect(detectTestCommand(repo({ "go.mod": "module x" })).cmd).toBe("go vet ./... && go test ./...");
    expect(detectTestCommand(repo({ "package.json": '{"scripts":{"test":"vitest run"}}', "package-lock.json": "{}" })).cmd).toMatch(/^npm ci .*&& npm test$/);
    expect(detectTestCommand(repo({ "package.json": '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' }))).toBeNull();
    expect(detectTestCommand(repo({ "requirements.txt": "", "tests/": "" })).lang).toBe("python");
    expect(detectTestCommand(repo({ "README.md": "x" }))).toBeNull();
  });
});

describe("menjalankan test", () => {
  it("lulus & gagal dilaporkan dengan output", () => {
    const pass = runProjectTests({ dir: repo({ "package.json": '{"scripts":{"test":"echo semua-lulus"}}' }), env: { ...process.env, npm_config_offline: "true" } });
    expect(pass).toMatchObject({ ran: true, ok: true });
    expect(pass.output).toContain("semua-lulus");
    const fail = runProjectTests({ dir: repo({ "package.json": '{"scripts":{"test":"echo boom-gagal && exit 3"}}' }) });
    expect(fail).toMatchObject({ ran: true, ok: false });
    expect(fail.output).toContain("boom-gagal");
    expect(testReportMarkdown(fail)).toMatch(/❌ GAGAL/);
    expect(testReportMarkdown({ ran: false })).toMatch(/Tidak ada test/);
  }, 60000);
});
