import { callGitHubAPI } from "../services/github.js";
import { bufferToBase64 } from "../utils/array.js";
import { webSearch, webFetch, imageSearch, songSearch, youtubeSearch, freeMusicSearch, youtubeMp3 } from "../services/search.js";
import { sendTelegramPhoto, sendTelegramAudio, getTelegramUserInfo } from "../services/telegram.js";
import {
  getTrelloBoard,
  getTrelloLists,
  createTrelloList,
  createTrelloCard,
  addTrelloChecklist,
  addTrelloAttachment,
  moveTrelloCard,
  updateTrelloCard,
  createTrelloBoard,
} from "../services/trello.js";
import {
  createTasks,
  getTasks,
  updateTaskStatus,
  clearTasks,
  setMemory,
  getMemory,
  getAllMemories,
  deleteMemory,
  addReminder,
  getReminders,
  deleteReminder,
} from "../db/index.js";

import { withCoAuthor, coAuthorTrailer, ownerIdentity, withPrFooter } from "../utils/attribution.js";

// Merge hanya bila PR bisa di-merge dan CI tidak gagal/masih berjalan.
// Dilempar sebagai error -> user diberi tahu alasannya (lihat grantedToolFailure).
export async function assertPullRequestMergeable(env, owner, repo, number) {
  const pr = await callGitHubAPI(env, `repos/${owner}/${repo}/pulls/${number}`);
  if (!pr || typeof pr !== "object") return;
  if (pr.merged) throw new Error(`PR #${number} sudah di-merge sebelumnya`);
  if (pr.state && pr.state !== "open") throw new Error(`PR #${number} sudah ${pr.state}`);
  if (pr.draft) throw new Error(`PR #${number} masih draft (biasanya karena test gagal) — tandai ready for review dulu`);
  if (pr.mergeable === false) throw new Error(`PR #${number} tidak bisa di-merge (konflik / ${pr.mergeable_state || "blocked"})`);
  const sha = pr.head?.sha;
  if (!sha) return;
  const [runs, combined] = await Promise.all([
    callGitHubAPI(env, `repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`).catch(() => null),
    callGitHubAPI(env, `repos/${owner}/${repo}/commits/${sha}/status`).catch(() => null),
  ]);
  const checkRuns = Array.isArray(runs?.check_runs) ? runs.check_runs : [];
  const failed = checkRuns.filter((c) => c.status === "completed" && ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion));
  const pending = checkRuns.filter((c) => c.status !== "completed");
  if (combined?.total_count > 0 && combined.state === "failure") failed.push({ name: "status checks" });
  if (combined?.total_count > 0 && combined.state === "pending") pending.push({ name: "status checks" });
  if (failed.length) throw new Error(`merge ditolak: CI gagal (${failed.map((c) => c.name).join(", ")})`);
  if (pending.length) throw new Error(`merge ditunda: CI masih berjalan (${pending.map((c) => c.name).join(", ")}). coba lagi setelah selesai`);
}

// Repo tempat workflow kokoa-dev.yml berada (penerima repository_dispatch).
export function dispatchRepo(env) {
  return env?.GHA_DISPATCH_REPO || "thirapi/kokoa-agent";
}

export async function executeTool(name, args, env, chatId) {
  switch (name) {
    case "listGitHubIssues": {
      const endpoint = `repos/${args.owner}/${args.repo}/issues?state=${args.state || "open"}`;
      return callGitHubAPI(env, endpoint);
    }
    case "getPRDiff": {
      const pull_number = parseInt(args.pull_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/pulls/${pull_number}`;
      return callGitHubAPI(env, endpoint, "GET", null, {
        Accept: "application/vnd.github.v3.diff",
      });
    }
    case "createGitHubIssue": {
      const endpoint = `repos/${args.owner}/${args.repo}/issues`;
      return callGitHubAPI(env, endpoint, "POST", {
        title: args.title,
        body: args.body,
        labels: args.labels,
      });
    }
    case "getFileContent": {
      const endpoint = `repos/${args.owner}/${args.repo}/contents/${args.path}${args.ref ? "?ref=" + args.ref : ""}`;
      const res = await callGitHubAPI(env, endpoint);
      if (res && res.type === "file" && res.encoding === "base64" && res.content) {
        const decoded = new TextDecoder().decode(
          Uint8Array.from(atob(res.content.replace(/\s/g, "")), (c) => c.charCodeAt(0))
        );
        return { ...res, content: decoded };
      }
      return res;
    }
    case "createOrUpdateFile": {
      const endpoint = `repos/${args.owner}/${args.repo}/contents/${args.path}`;
      let sha = args.sha;
      const refParam = args.branch ? `?ref=${args.branch}` : '';
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!sha) {
          try {
            const existing = await callGitHubAPI(env, endpoint + refParam);
            if (existing && existing.sha) sha = existing.sha;
          } catch (_) {}
        }
        const bytes = new TextEncoder().encode(args.content);
        const base64Content = bufferToBase64(bytes);
        const body = {
          message: withCoAuthor(args.message, env),
          content: base64Content,
          author: ownerIdentity(env),
        };
        if (sha) body.sha = sha;
        if (args.branch) body.branch = args.branch;
        try {
          return await callGitHubAPI(env, endpoint, "PUT", body);
        } catch (err) {
          const is409 = err.message.includes("409") || err.message.includes('does not match');
          if (is409 && attempt < 2) {
            sha = null;
            continue;
          }
          throw err;
        }
      }
    }
    case "createPullRequest": {
      const endpoint = `repos/${args.owner}/${args.repo}/pulls`;
      const body = {
        title: args.title,
        head: args.head,
        base: args.base,
      };
      body.body = withPrFooter(args.body);
      return callGitHubAPI(env, endpoint, "POST", body);
    }
    case "createBranch": {
      const refEndpoint = `repos/${args.owner}/${args.repo}/git/refs`;
      let baseSha;
      try {
        const fromBranch = args.from_branch || 'main';
        const ref = await callGitHubAPI(env, `repos/${args.owner}/${args.repo}/git/refs/heads/${fromBranch}`);
        baseSha = ref.object.sha;
      } catch (_) {
        return { error: `Gagal mendapatkan SHA branch sumber. Pastikan branch '${args.from_branch || 'main'}' ada.` };
      }
      return callGitHubAPI(env, refEndpoint, "POST", {
        ref: `refs/heads/${args.branch}`,
        sha: baseSha,
      });
    }
    case "mergePullRequest": {
      const pull_number = parseInt(args.pull_number, 10);
      await assertPullRequestMergeable(env, args.owner, args.repo, pull_number);
      const endpoint = `repos/${args.owner}/${args.repo}/pulls/${pull_number}/merge`;
      const body = { commit_message: coAuthorTrailer(env) };
      if (args.commit_title) body.commit_title = args.commit_title;
      if (args.merge_method) body.merge_method = args.merge_method;
      return callGitHubAPI(env, endpoint, "PUT", body);
    }
    case "addLabels": {
      const issue_number = parseInt(args.issue_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/issues/${issue_number}/labels`;
      return callGitHubAPI(env, endpoint, "POST", { labels: args.labels });
    }
    case "assignUser": {
      const issue_number = parseInt(args.issue_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/issues/${issue_number}/assignees`;
      return callGitHubAPI(env, endpoint, "POST", { assignees: args.assignees });
    }
    case "createIssueComment": {
      const issue_number = parseInt(args.issue_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/issues/${issue_number}/comments`;
      return callGitHubAPI(env, endpoint, "POST", { body: args.body });
    }
    case "updateIssueState": {
      const issue_number = parseInt(args.issue_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/issues/${issue_number}`;
      const body = {};
      if (args.state) body.state = args.state;
      if (args.title) body.title = args.title;
      if (args.body) body.body = args.body;
      return callGitHubAPI(env, endpoint, "PATCH", body);
    }
    case "updatePRState": {
      const pull_number = parseInt(args.pull_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/pulls/${pull_number}`;
      const body = {};
      if (args.state) body.state = args.state;
      if (args.title) body.title = args.title;
      if (args.body) body.body = args.body;
      if (args.base) body.base = args.base;
      return callGitHubAPI(env, endpoint, "PATCH", body);
    }
    case "listDirectoryContents": {
      const dirPath = (args.path || "").replace(/^\/+/, "");
      const endpoint = `repos/${args.owner}/${args.repo}/contents${dirPath ? "/" + dirPath : ""}${args.ref ? "?ref=" + args.ref : ""}`;
      return callGitHubAPI(env, endpoint);
    }
    case "deleteFile": {
      const endpoint = `repos/${args.owner}/${args.repo}/contents/${args.path}`;
      const body = {
        message: withCoAuthor(args.message, env),
        sha: args.sha,
        author: ownerIdentity(env),
      };
      if (args.branch) body.branch = args.branch;
      return callGitHubAPI(env, endpoint, "DELETE", body);
    }
    case "searchInFiles": {
      const endpoint = `search/code?q=${encodeURIComponent(args.q)}${args.sort ? "&sort=" + args.sort : ""}${args.order ? "&order=" + args.order : ""}`;
      return callGitHubAPI(env, endpoint);
    }
    case "triggerDeveloperWorkflow": {
      const dispatchEndpoint = `repos/${dispatchRepo(env)}/dispatches`;
      const mode = args.mode || "code";
      const body = {
        event_type: "kokoa-dev-task",
        client_payload: {
          target_repo: args.target_repo,
          instruction: args.instruction,
          mode,
          chat_id: chatId,
          context_id: args.context_id || "",
          worker_url: args.worker_url || env.WORKER_URL || "",
        },
      };
      await callGitHubAPI(env, dispatchEndpoint, "POST", body);
      const msg = mode === "analysis"
        ? "oke, aku kirim tim analis ke repo itu ya. nanti hasilnya aku kirim ke sini kalo udah selesai!"
        : "Workflow pengembangan berhasil dipicu di GitHub Actions. Proses ini akan berjalan di latar belakang (Ubuntu Runner). Aku akan memberikan notifikasi setelah tugas selesai atau jika ada perkembangan lebih lanjut.";
      return { message: msg };
    }
    case "checkWorkflowStatus": {
      // Workflow selalu jalan di repo "command center" (bukan repo target),
      // jadi status dicek di sana — bukan di args.owner/args.repo.
      const runsEndpoint = `repos/${dispatchRepo(env)}/actions/runs?event=repository_dispatch&per_page=3`;
      const runs = await callGitHubAPI(env, runsEndpoint);
      if (!runs || !runs.workflow_runs || runs.workflow_runs.length === 0) {
        return { message: "Belum ada workflow yang pernah dijalankan." };
      }
      const latest = runs.workflow_runs[0];
      const status = latest.status === "completed" ? `completed (${latest.conclusion})` : latest.status;
      return {
        workflow_status: status,
        created_at: latest.created_at,
        updated_at: latest.updated_at,
        html_url: latest.html_url,
        run_id: latest.id,
      };
    }
    case "webSearch": {
      return await webSearch(args.query, env);
    }
    case "webFetch": {
      return await webFetch(args.url);
    }
    case "imageSearch": {
      return await imageSearch(args.query);
    }
    case "songSearch": {
      return await songSearch(args.query);
    }
    case "youtubeSearch": {
      return await youtubeSearch(args.query);
    }
    case "freeMusicSearch": {
      return await freeMusicSearch(args.query);
    }
    case "youtubeMp3": {
      return await youtubeMp3(args.query, env);
    }
    case "sendLegalFile": {
      if (!env.TELEGRAM_BOT_TOKEN) return { error: "Token Telegram tidak tersedia." };
      // Allowlist domain legal (CC/public domain). Di luar ini = tolak, tanpa kecuali.
      const LEGAL_HOSTS = ["ccmixter.org", "upload.wikimedia.org"];
      let hostname = "";
      try {
        hostname = new URL(args.fileUrl).hostname.toLowerCase();
      } catch (_) {
        return { error: "URL file tidak valid." };
      }
      const allowed = LEGAL_HOSTS.some(h => hostname === h || hostname.endsWith("." + h));
      if (!allowed) {
        return { error: `Domain ${hostname} tidak diizinkan. Hanya file dari sumber legal (ccmixter.org, upload.wikimedia.org) yang boleh dikirim full.` };
      }
      let kind = args.kind || "auto";
      if (kind === "auto") {
        const lower = args.fileUrl.toLowerCase();
        kind = /\.(mp3|m4a|aac|ogg|wav|flac)(\?|#|$)/.test(lower) ? "audio"
          : /\.(jpg|jpeg|png|webp|gif)(\?|#|$)/.test(lower) ? "image" : "audio";
      }
      if (kind === "image") {
        return await sendTelegramPhoto(env.TELEGRAM_BOT_TOKEN, chatId, args.fileUrl, args.title || "");
      }
      return await sendTelegramAudio(env.TELEGRAM_BOT_TOKEN, chatId, args.fileUrl, args.performer || "", args.title || "", "");
    }
    case "sendPhoto": {
      if (!env.TELEGRAM_BOT_TOKEN) return { error: "Token Telegram tidak tersedia." };
      return await sendTelegramPhoto(env.TELEGRAM_BOT_TOKEN, chatId, args.imageUrl, args.caption || "");
    }
    case "sendAudio": {
      if (!env.TELEGRAM_BOT_TOKEN) return { error: "Token Telegram tidak tersedia." };
      return await sendTelegramAudio(env.TELEGRAM_BOT_TOKEN, chatId, args.audioUrl, args.performer || "", args.title || "", args.caption || "");
    }
    case "inspectTelegramUser": {
      if (!env.TELEGRAM_BOT_TOKEN) return { error: "Token Telegram tidak tersedia." };
      if (!args.userId) {
        return { error: "userId kosong. Minta user reply pesan orangnya dulu — user_id ada di konteks reply. Username saja (@seseorang) tidak bisa di-resolve oleh API Telegram." };
      }
      return await getTelegramUserInfo(env.TELEGRAM_BOT_TOKEN, args.userId);
    }
    case "createTaskPlan": {
      await clearTasks(env, chatId).catch(() => {});
      const tasks = (args.steps || []).map((step, i) => ({
        title: step,
        description: `Langkah ${i + 1}: ${step}`,
        priority: "medium",
      }));
      if (tasks.length === 0) return { error: "Tidak ada langkah yang diberikan." };
      const ids = await createTasks(env, chatId, tasks);
      const summary = tasks.map((t, i) => ({
        id: ids[i],
        title: t.title,
        status: "pending",
      }));
      return {
        message: `Rencana "${args.title || "Tanpa judul"}" berhasil dibuat dengan ${tasks.length} langkah.`,
        plan: summary,
        total: tasks.length,
      };
    }
    case "getTaskPlan": {
      const tasks = await getTasks(env, chatId);
      return tasks.length > 0
        ? { tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status, priority: t.priority })) }
        : { message: "Belum ada task plan yang dibuat. Gunakan createTaskPlan untuk membuatnya." };
    }
    case "updateTaskStatus": {
      const validStatuses = ["pending", "in_progress", "completed", "failed"];
      if (!validStatuses.includes(args.status)) {
        return { error: `Status tidak valid. Pilihan: ${validStatuses.join(", ")}` };
      }
      await updateTaskStatus(env, chatId, args.task_id, args.status);

      const remaining = await getTasks(env, chatId, "pending");
      const inProgress = await getTasks(env, chatId, "in_progress");
      const allDone = remaining.length === 0 && inProgress.length === 0;

      return {
        message: `Tugas #${args.task_id} diupdate ke "${args.status}".`,
        remaining: remaining.length,
        all_done: allDone,
      };
    }
    case "clearTaskPlan": {
      await clearTasks(env, chatId);
      return { message: "Semua tugas dalam plan berhasil dihapus." };
    }
    case "remember": {
      await setMemory(env, chatId, args.key, args.value);
      const { indexMemory } = await import("../agent/semantic-memory.js");
      await indexMemory(env, chatId, args.key, args.value);
      return { message: `Oke, aku ingat ${args.key}: ${args.value}` };
    }
    case "searchMemory": {
      const { searchMemories, semanticMemoryAvailable } = await import("../agent/semantic-memory.js");
      if (!semanticMemoryAvailable(env)) return { error: "pencarian memori semantik tidak tersedia di runtime ini — pakai recall/recallAll" };
      const matches = await searchMemories(env, chatId, args.query, Math.min(Number(args.limit) || 5, 10));
      return matches.length ? { matches } : { matches: [], message: "tidak ada memori yang relevan" };
    }
    case "recall": {
      const value = await getMemory(env, chatId, args.key);
      return value
        ? { key: args.key, value }
        : { message: `Aku gak nemu info soal "${args.key}" di memori.` };
    }
    case "recallAll": {
      const all = await getAllMemories(env, chatId);
      return all.length > 0
        ? { memories: all.map(m => ({ key: m.key, value: m.value })) }
        : { message: "Belum ada memori yang disimpan." };
    }
    case "forget": {
      await deleteMemory(env, chatId, args.key);
      const { forgetMemoryVector } = await import("../agent/semantic-memory.js");
      await forgetMemoryVector(env, chatId, args.key);
      return { message: `Oke, info soal "${args.key}" udah aku hapus dari memori.` };
    }
    case "setReminder": {
      const delayS = Math.max(60, (args.delay_minutes || 1) * 60);
      const triggerAt = Math.floor(Date.now() / 1000) + delayS;
      const recurring = args.recurring === "daily" ? 1 : 0;
      const id = await addReminder(
        env, chatId, args.title, triggerAt, recurring,
        recurring ? 86400 : 0,
      );
      if (!id) return { error: "Gagal buat reminder." };
      const recurringLabel = recurring ? " (harian)" : "";
      return {
        message: `Oke, aku ingetin kamu "${args.title}" dalam ${args.delay_minutes} menit${recurringLabel}.`,
        reminder_id: id,
        trigger_at: triggerAt,
      };
    }
    case "getReminders": {
      const list = await getReminders(env, chatId);
      if (list.length === 0) return { message: "Tidak ada pengingat yang aktif." };
      return {
        reminders: list.map(r => ({
          id: r.id,
          title: r.title,
          trigger_at: r.trigger_at,
          recurring: !!r.recurring,
          last_triggered: r.last_triggered,
        })),
      };
    }
    case "deleteReminder": {
      await deleteReminder(env, chatId, args.reminder_id);
      return { message: `Pengingat #${args.reminder_id} udah dihapus.` };
    }
    case "getTrelloBoard": {
      return await getTrelloBoard(env, chatId, args.boardId);
    }
    case "getTrelloLists": {
      return await getTrelloLists(env, chatId, args.boardId);
    }
    case "createTrelloList": {
      return await createTrelloList(env, chatId, args.boardId, args.name);
    }
    case "createTrelloCard": {
      return await createTrelloCard(env, chatId, args);
    }
    case "addTrelloChecklist": {
      return await addTrelloChecklist(env, chatId, args.cardId, args.title, args.items);
    }
    case "addTrelloAttachment": {
      return await addTrelloAttachment(env, chatId, args.cardId, args.url, args.name);
    }
    case "moveTrelloCard": {
      return await moveTrelloCard(env, chatId, args.cardId, args);
    }
    case "updateTrelloCard": {
      return await updateTrelloCard(env, chatId, args.cardId, args);
    }
    case "createTrelloBoard": {
      return await createTrelloBoard(env, chatId, args.name, args.desc);
    }
    default:
      throw new Error(`Tool "${name}" tidak dikenal atau belum diimplementasikan.`);
  }
}
