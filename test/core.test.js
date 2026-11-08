// Regresi untuk modul inti yang sudah ada sebelumnya.
import { describe, it, expect, vi } from "vitest";
import { markdownToRichHtml, splitIntoChunks, stripHtml } from "../src/utils/formatter.js";
import { runHarnessToolCall, safeTruncate, isWriteTool, modifiesRepoFiles } from "../src/tools/harness.js";
import { isHighRiskTool, needsApproval, toolCallKey, stripMediaForSnapshot, approvalPromptText, saveApproval, loadApproval } from "../src/agent/approval.js";
import { validateToolArgs, isReadOnlyTool, getToolsForMode } from "../src/agent/registry.js";
import { isTransientNetworkError, withNetworkRetry, noFinalTextMessage } from "../src/utils/net.js";
import { compactWithEvicted } from "../src/agent/compaction.js";
import { resolveAgentMode, setAgentMode } from "../src/agent/mode.js";
import { fakeKV } from "./helpers.js";

describe("formatter", () => {
  it("markdown -> HTML Telegram dan escape HTML di dalam kode", () => {
    const html = markdownToRichHtml("**tebal** dan `x<y`\n```\nif (a < b) {}\n```");
    expect(html).toContain("<b>tebal</b>");
    expect(html).toContain("<pre><code>if (a &lt; b) {}</code></pre>");
    expect(html).not.toMatch(/<y/);
  });

  it("splitIntoChunks tidak melebihi batas & tidak kehilangan teks", () => {
    const text = Array.from({ length: 50 }, (_, i) => `paragraf ${i} `.repeat(20)).join("\n\n");
    const chunks = splitIntoChunks(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });

  it("stripHtml", () => {
    expect(stripHtml("<b>a</b> &amp; &lt;b&gt;")).toBe("a & <b>");
  });
});

describe("harness", () => {
  it("cache hanya untuk tool baca", async () => {
    const exec = vi.fn(async () => ({ ok: 1 }));
    const cache = new Map();
    await runHarnessToolCall("webSearch", { q: 1 }, {}, "1", cache, { toolExecutor: exec });
    await runHarnessToolCall("webSearch", { q: 1 }, {}, "1", cache, { toolExecutor: exec });
    await runHarnessToolCall("remember", { k: 1 }, {}, "1", cache, { toolExecutor: exec });
    await runHarnessToolCall("remember", { k: 1 }, {}, "1", cache, { toolExecutor: exec });
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("error tool dibungkus, bukan dilempar", async () => {
    const res = await runHarnessToolCall("x", {}, {}, "1", null, { toolExecutor: async () => { throw new Error("boom"); } });
    expect(res).toEqual({ ok: false, error: "boom" });
  });

  it("safeTruncate memotong output besar", () => {
    expect(safeTruncate("a".repeat(20), 10)).toMatch(/^a{10}\n\n\.\.\. \[Hasil dipotong/);
    expect(safeTruncate({ stdout: "b".repeat(20) }, 10).is_truncated).toBe(true);
    expect(safeTruncate(null)).toBeNull();
  });

  it("klasifikasi tool tulis & modifikasi file", () => {
    expect(isWriteTool("runCommand")).toBe(true);
    expect(isWriteTool("webSearch")).toBe(false);
    expect(modifiesRepoFiles("remember")).toBe(false);
    expect(modifiesRepoFiles("createOrUpdateFile")).toBe(true);
  });
});

describe("approval", () => {
  it("izin hanya untuk perubahan langsung di GitHub", () => {
    for (const t of ["mergePullRequest", "deleteFile", "createOrUpdateFile"]) expect(needsApproval(t, {})).toBe(true);
    // PR & workflow GHA menghasilkan PR yang bisa direview -> tanpa izin
    for (const t of ["createPullRequest", "triggerDeveloperWorkflow", "webSearch", "cloneRepo"]) expect(needsApproval(t, {})).toBe(false);
    expect(isHighRiskTool("webSearch")).toBe(false);
  });

  it("kasus nyata: runCommand menulis file di workspace Spaces -> langsung jalan", () => {
    const cmd = "cat << 'EOF' > main.go\npackage main\n\nimport \"fmt\"\nEOF";
    expect(needsApproval("runCommand", { command: cmd })).toBe(false);
  });

  it.each(["go build ./... && go test ./...", "npm install", "rm -rf node_modules", "curl -s https://example.com", "ls -la /tmp", "rm -rf /tmp/x"])(
    "runCommand lokal tanpa izin: %s", (command) => expect(needsApproval("runCommand", { command })).toBe(false));

  it.each(["git push origin main", "cd repo && git push -f", "gh pr merge 1", "npm publish", "curl -X POST https://api.x", "curl -d a=1 https://x",
    "rm -rf /", "rm -rf ~", "git remote set-url origin https://evil"])(
    "runCommand yang menyentuh dunia luar butuh izin: %s", (command) => expect(needsApproval("runCommand", { command })).toBe(true));

  it("toolCallKey stabil & sensitif terhadap argumen", () => {
    expect(toolCallKey("a", { x: 1 })).toBe(toolCallKey("a", { x: 1 }));
    expect(toolCallKey("a", { x: 1 })).not.toBe(toolCallKey("a", { x: 2 }));
  });

  it("snapshot tidak membawa base64 media", () => {
    const s = JSON.stringify(stripMediaForSnapshot([{ role: "user", parts: [{ inline_data: { mime_type: "image/png", data: "BIGDATA" } }] }]));
    expect(s).not.toContain("BIGDATA");
  });

  it("prompt approval meng-escape argumen", () => {
    expect(approvalPromptText("runCommand", { command: "<script>" })).toContain("&lt;script&gt;");
  });

  it("simpan & muat approval dari KV", async () => {
    const env = { CHAT_HISTORY: fakeKV() };
    await saveApproval(env, "id1", { status: "pending" });
    expect((await loadApproval(env, "id1")).status).toBe("pending");
  });
});

describe("registry", () => {
  it("validasi argumen wajib", () => {
    expect(validateToolArgs("webSearch", {}).valid).toBe(false);
    expect(validateToolArgs("webSearch", { query: "x" }).valid).toBe(true);
    expect(validateToolArgs("toolPalsu", {}).valid).toBe(false);
  });

  it("tool Spaces tidak ditawarkan ke Worker", () => {
    const worker = getToolsForMode(false).map((t) => t.name);
    const spaces = getToolsForMode(true).map((t) => t.name);
    expect(worker).not.toContain("runCommand");
    expect(spaces).toContain("runCommand");
  });

  it("mode plan hanya tool baca", () => {
    expect(getToolsForMode(true, true).every((t) => isReadOnlyTool(t.name))).toBe(true);
    expect(isReadOnlyTool("toolPalsu")).toBe(false);
  });
});

describe("net", () => {
  it("klasifikasi error transient", () => {
    expect(isTransientNetworkError(new Error("Client network socket disconnected before secure TLS connection"))).toBe(true);
    expect(isTransientNetworkError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientNetworkError(new Error("ETIMEDOUT"))).toBe(false);
    expect(isTransientNetworkError(new Error("HTTP 429"))).toBe(false);
  });

  it("withNetworkRetry hanya retry error transient", async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue("ok");
    expect(await withNetworkRetry(flaky, { backoffMs: [1] })).toBe("ok");
    const hard = vi.fn().mockRejectedValue(new Error("HTTP 500"));
    await expect(withNetworkRetry(hard, { backoffMs: [1] })).rejects.toThrow("HTTP 500");
    expect(hard).toHaveBeenCalledTimes(1);
  });

  it("noFinalTextMessage jujur sesuai filesModified", () => {
    expect(noFinalTextMessage({ filesModified: true })).toMatch(/udah aku lakuin/);
    expect(noFinalTextMessage({ filesModified: false })).toMatch(/ga ada file yang berubah/);
  });
});

describe("compaction", () => {
  it("membuang pesan lama sampai muat, menjaga system message", () => {
    const msgs = [{ role: "system", content: "S" }, ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(400) }))];
    const { kept, evicted } = compactWithEvicted(msgs, 1000);
    expect(kept[0].role).toBe("system");
    expect(evicted.length).toBeGreaterThan(0);
    expect(Math.ceil(JSON.stringify(kept).length / 4)).toBeLessThanOrEqual(1000);
  });

  it("tidak menyentuh pesan yang sudah muat", () => {
    const msgs = [{ role: "user", content: "hai" }];
    expect(compactWithEvicted(msgs).evicted).toEqual([]);
  });
});

describe("mode plan/build", () => {
  it("default build, bisa di-set per chat", async () => {
    const env = { CHAT_HISTORY: fakeKV() };
    expect(await resolveAgentMode({ ...env }, "1")).toBe("build");
    await setAgentMode(env, "1", "plan");
    expect(await resolveAgentMode({ ...env }, "1")).toBe("plan");
    await setAgentMode(env, "1", "hack");
    expect(await resolveAgentMode({ ...env }, "1")).toBe("plan");
  });
});
