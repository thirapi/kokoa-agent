// Runner eval: node evals/run.js [--only id1,id2] [--repeat N]
// Butuh key provider di env (GEMINI_API_KEYS / CEREBRAS_API_KEY / OPENROUTER_API_KEY / ...).
// Tool dijalankan TIRUAN: tidak ada efek ke GitHub/Telegram/web.
import { appendFileSync, writeFileSync, readFileSync } from "fs";
import { runAgentLoop, buildProviderConfigs } from "../src/handlers/message.js";
import { ApprovalPending } from "../src/agent/approval.js";
import { buildDetachedEnv } from "../src/agent/detached-env.js";
import { createTracer } from "../src/agent/trace.js";
import { SCENARIOS } from "./scenarios.js";

const DEFAULT_FIXTURES = {
  getPRDiff: "diff --git a/x b/x\n+ok",
  listDirectoryContents: [{ name: "main.go", type: "file" }, { name: "go.mod", type: "file" }],
  getFileContent: { content: "package main" },
  triggerDeveloperWorkflow: { message: "Workflow dipicu di GitHub Actions." },
  createIssueComment: { id: 1 },
  createGitHubIssue: { number: 12, html_url: "https://github.com/thirapi/htmx/issues/12" },
  webSearch: { results: [{ title: "contoh", url: "https://example.com", snippet: "contoh" }] },
  recall: { value: null }, recallAll: { memories: [] }, getTaskPlan: { tasks: [] },
};

export async function runScenario(sc, platformEnv) {
  const env = buildDetachedEnv(platformEnv, { config: platformEnv });
  const tracer = createTracer();
  const toolCalls = [];
  const approvals = [];
  const fixtures = { ...DEFAULT_FIXTURES, ...(sc.fixtures || {}) };
  const toolExecutor = async (name, args) => {
    toolCalls.push({ name, args });
    const f = fixtures[name];
    if (f && typeof f === "object" && f.__error) throw new Error(f.__error);
    return f !== undefined ? f : { ok: true };
  };
  const contents = [...(sc.history || []), { role: "user", parts: [{ text: sc.prompt }] }];
  const run = { id: sc.id, toolCalls, approvals, finalText: null, error: null, approvalAtCall: Infinity };
  const t0 = Date.now();
  try {
    const providers = await buildProviderConfigs(env);
    const res = await runAgentLoop(contents, env, "eval", sc.prompt, providers, sc.history || [], Date.now(), {
      executionTimeout: 120000, iterationTimeout: 30000, toolExecutor, tracer, runtime: "eval",
      saveSnapshot: async () => {},
      notifyApproval: async ({ tool, toolArgs }) => { approvals.push({ tool, toolArgs }); run.approvalAtCall = toolCalls.length; },
    });
    run.finalText = res.finalText;
  } catch (err) {
    const msg = String(err?.message || err);
    // Pesan error yang memang ditampilkan ke user (lihat processMessage) = jawaban akhir.
    if (/^(duh,|server|gagal)/.test(msg)) run.finalText = msg;
    else if (!(err instanceof ApprovalPending)) run.error = msg;
  }
  run.ms = Date.now() - t0;
  run.trace = tracer.events;
  run.llmCalls = tracer.events.filter((e) => e.kind === "llm").length;
  const verdict = run.error && !approvals.length ? { pass: false, reason: `error: ${run.error.slice(0, 120)}` } : sc.check(run);
  return { ...run, ...verdict };
}

// Persona, model & urutan provider sama dengan production (vars di wrangler.jsonc).
export function loadWranglerVars(path = "wrangler.jsonc") {
  try {
    const raw = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
    return JSON.parse(raw).vars || {};
  } catch (_) {
    return {};
  }
}

async function main() {
  const args = process.argv.slice(2);
  const only = (args[args.indexOf("--only") + 1] || "").split(",").filter((x) => args.includes("--only") && x);
  const repeat = Number(args.includes("--repeat") ? args[args.indexOf("--repeat") + 1] : 1) || 1;
  const list = SCENARIOS.filter((s) => !only.length || only.includes(s.id));
  const results = [];
  for (const sc of list) {
    for (let i = 0; i < repeat; i++) {
      const r = await runScenario(sc, { ...loadWranglerVars(), ...process.env });
      results.push(r);
      console.log(`${r.pass ? "PASS" : "FAIL"} ${sc.id} (${(r.ms / 1000).toFixed(1)}s, ${r.llmCalls} llm, tools: ${r.toolCalls.map((c) => c.name).join(">") || "-"}) — ${r.reason}`);
    }
  }
  const passed = results.filter((r) => r.pass).length;
  const score = results.length ? Math.round((passed / results.length) * 100) : 0;
  console.log(`\nSKOR: ${passed}/${results.length} (${score}%)`);
  writeFileSync("eval-results.json", JSON.stringify({ score, results: results.map(({ trace, ...r }) => ({ ...r, trace })) }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => `| ${r.pass ? "✅" : "❌"} | ${r.id} | ${(r.ms / 1000).toFixed(1)}s | ${r.toolCalls.map((c) => c.name).join(" → ") || "-"} | ${r.reason} |`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Eval agent: ${passed}/${results.length} (${score}%)\n\n| | skenario | durasi | tool | alasan |\n|---|---|---|---|---|\n${rows.join("\n")}\n`);
  }
  const min = Number(process.env.EVAL_MIN_SCORE || 0);
  if (score < min) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
