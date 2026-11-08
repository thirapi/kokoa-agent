// Deteksi & jalankan test repo target (dipakai runner GHA sebelum membuka PR).
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

export function detectTestCommand(dir = ".") {
  const has = (f) => existsSync(join(dir, f));
  if (has("go.mod")) return { lang: "go", cmd: "go vet ./... && go test ./..." };
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const t = pkg.scripts?.test || "";
      if (t && !/no test specified/i.test(t)) {
        const install = has("package-lock.json") ? "npm ci" : "npm install";
        return { lang: "node", cmd: `${install} --no-audit --no-fund && npm test` };
      }
    } catch (_) {}
  }
  if (has("Cargo.toml")) return { lang: "rust", cmd: "cargo test" };
  if (has("pyproject.toml") || has("requirements.txt") || has("pytest.ini")) {
    if (has("tests") || has("test") || has("pytest.ini")) return { lang: "python", cmd: "python -m pytest -q" };
  }
  return null;
}

// -> { ran:false } | { ran:true, ok, lang, cmd, output }
export function runProjectTests({ dir = ".", timeoutMs = 600000, env } = {}) {
  const det = detectTestCommand(dir);
  if (!det) return { ran: false };
  try {
    const out = execSync(det.cmd, { cwd: dir, encoding: "utf8", stdio: "pipe", timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env, shell: "/bin/bash" });
    return { ran: true, ok: true, ...det, output: tail(out) };
  } catch (e) {
    return { ran: true, ok: false, ...det, output: tail(`${e.stdout || ""}\n${e.stderr || ""}\n${e.message || ""}`) };
  }
}

function tail(s, n = 2500) {
  const t = String(s || "").trim();
  return t.length > n ? "…" + t.slice(-n) : t;
}

export function testReportMarkdown(r) {
  if (!r?.ran) return "### Test otomatis\nTidak ada test yang terdeteksi di repo ini.";
  const fence = "```";
  return `### Test otomatis: ${r.ok ? "✅ lulus" : "❌ GAGAL"}\n\`${r.cmd}\`\n\n<details><summary>output</summary>\n\n${fence}\n${r.output}\n${fence}\n</details>`;
}
