// Menjalankan satu tugas agent di runtime jarak jauh (Vercel) lalu mengirim hasil
// ke Worker (POST /api/agent-result). Worker yang menyimpan riwayat, mengirim jawaban,
// menangani approval & melepas lock — sama seperti hasil dari Spaces.
import { runAgentLoop, buildProviderConfigs } from "../handlers/message.js";
import { ApprovalPending } from "./approval.js";
import { buildDetachedEnv } from "./detached-env.js";
import { runnerAuthHeaders } from "../utils/auth.js";

export const REMOTE_EXECUTION_TIMEOUT_MS = 270000; // < maxDuration Vercel 300 detik

function captureApproval() {
  const box = {};
  return {
    box,
    saveSnapshot: async (id, snapshot) => { box.id = id; box.snapshot = snapshot; },
    notifyApproval: async ({ id, tool, toolArgs, reason }) => { box.id = id; box.tool = tool; box.toolArgs = toolArgs; box.reason = reason || ''; },
  };
}

// job: { chatId, userPrompt, currentContents, historyLen, memories, tasks, mode, progressMsgId,
//        workerUrl, config, resume?: { decision, snapshot } }
export async function executeRemoteJob(job, platformEnv, { runtime = "vercel" } = {}) {
  const chatId = String(job.chatId);
  const env = buildDetachedEnv(platformEnv, job);
  const cap = captureApproval();
  const progressMsgId = job.progressMsgId || null;
  let contents, historyLen, userPrompt, resume = null;

  if (job.resume?.snapshot) {
    const snap = job.resume.snapshot;
    contents = snap.contents || [];
    historyLen = snap.historyLen || 0;
    userPrompt = snap.userPrompt || "";
    if (snap.mode === "plan" || snap.mode === "build") env.AGENT_MODE = snap.mode;
    resume = {
      contents, historyLen,
      pendingTool: snap.pending || null,
      grantedKey: job.resume.decision === "approve" ? snap.pending?.key : null,
      deniedKey: job.resume.decision === "deny" ? snap.pending?.key : null,
    };
  } else {
    contents = job.currentContents || [{ role: "user", parts: [{ text: job.userPrompt || "" }] }];
    historyLen = Number.isInteger(job.historyLen) ? job.historyLen : Math.max(0, contents.length - 1);
    userPrompt = job.userPrompt || "";
  }

  const data = { status: "ready", finalText: null, newContent: [], escalationTriggered: false,
    filesModified: null, error: null, proxySent: false, historySynced: false, pendingMedia: [], progressMsgId };
  try {
    const providers = await buildProviderConfigs(env);
    if (providers.length === 0) throw new Error("gak ada provider AI yang aktif di runtime " + runtime);
    const result = await runAgentLoop(contents, env, chatId, userPrompt, providers, contents.slice(0, historyLen),
      Date.now(), {
        executionTimeout: REMOTE_EXECUTION_TIMEOUT_MS, iterationTimeout: 30000, runtime,
        resume, saveSnapshot: cap.saveSnapshot, notifyApproval: cap.notifyApproval,
      });
    const full = result.contents || contents;
    data.newContent = full.slice(historyLen).filter((c) => !c._selfReflection);
    data.escalationTriggered = !!result.escalationTriggered;
    data.finalText = result.escalationTriggered ? null : (result.finalText || null);
    data.filesModified = result.filesModified ?? null;
  } catch (err) {
    if (err instanceof ApprovalPending || err?.message === "__APPROVAL_PENDING__") {
      data.approval = { id: cap.box.id, snapshot: cap.box.snapshot, tool: cap.box.tool, toolArgs: cap.box.toolArgs || {}, reason: cap.box.reason || '' };
    } else {
      console.error(`[${runtime}] agent loop error:`, err);
      data.error = String(err?.message || err);
    }
  }
  return data;
}

// Kirim hasil ke Worker, coba ulang bila jaringan/5xx gagal.
export async function deliverToWorker(workerUrl, platformEnv, chatId, data, { attempts = 3, fetchImpl = fetch } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(`${workerUrl}/api/agent-result`, {
        method: "POST",
        headers: runnerAuthHeaders(platformEnv, { "Content-Type": "application/json" }),
        body: JSON.stringify({ chatId: String(chatId), data }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return true;
      lastErr = new Error(`Worker HTTP ${res.status}`);
      if (res.status >= 400 && res.status < 500) break;
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  console.error(`[remote] gagal kirim hasil ke Worker untuk ${chatId}:`, lastErr?.message);
  return false;
}
