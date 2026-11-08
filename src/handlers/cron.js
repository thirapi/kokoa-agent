import { getDueReminders, markReminderTriggered, getPendingSpaces, cleanupExpiredPending } from "../db/index.js";
import { sendTelegramMessage } from "../services/telegram.js";
import { handleSpacesResult } from "../services/spaces-poll.js";
import { runnerAuthHeaders } from "../utils/auth.js";

async function pollSpacesResults(env, ctx) {
  if (!env.HF_SPACES_URL) return;

  try {
    await cleanupExpiredPending(env, 3600);
    const pending = await getPendingSpaces(env);
    if (pending.length === 0) return;

    for (const row of pending) {
      const chatId = row.chat_id;
      try {
        const res = await fetch(`${env.HF_SPACES_URL}/api/result/${encodeURIComponent(chatId)}`, {
          headers: runnerAuthHeaders(env),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json();

        if (data.status === 'processing') continue;

        if (data.status === 'not_found') {
          const cbDone = await env.CHAT_HISTORY.get(`callback_done:${chatId}`);
          const hdlExists = await env.CHAT_HISTORY.get(`hdl:${chatId}`);
          console.log(`[Cron] Spaces result not_found for chat ${chatId} callback_done=${!!cbDone} hdl=${!!hdlExists}`);
          if (cbDone) {
            console.log(`[Cron] Chat ${chatId} already handled (callback_done), cleaning up pending space only`);
            const { removePendingSpace } = await import("../db/index.js");
            await removePendingSpace(env, chatId);
            continue;
          }
          console.log(`[Cron] Sending restart error for chat ${chatId}`);
          const { releaseChatLock, removePendingSpace } = await import("../db/index.js");
          const { deleteTelegramMessage } = await import("../services/telegram.js");
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN, chatId,
            "server Spaces aku restart atau kereset sebelum sempat selesai. coba kirim lagi ya!",
          );
          let errProgressId = data.progressMsgId;
          if (!errProgressId) {
            errProgressId = await env.CHAT_HISTORY.get(`progress_msg:${chatId}`);
          }
          if (errProgressId) {
            await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, parseInt(errProgressId)).catch(() => {});
            await env.CHAT_HISTORY.delete(`progress_msg:${chatId}`).catch(() => {});
          }
          await removePendingSpace(env, chatId);
          await releaseChatLock(env, chatId);
          continue;
        }

        if (data.status !== 'ready') continue;

        const mutexKey = `hdl:${chatId}`;
        if (await env.CHAT_HISTORY.get(mutexKey)) {
          console.log(`[Cron] Chat ${chatId} already being handled, skipping`);
          continue;
        }

        const callbackDone = await env.CHAT_HISTORY.get(`callback_done:${chatId}`);
        if (callbackDone) {
          console.log(`[Cron] Chat ${chatId} already handled (callback_done), skipping`);
          continue;
        }

        // Prompt asli disimpan saat dikirim ke Spaces; kalau ada, kegagalan jaringan
        // dikerjakan ulang di Worker alih-alih langsung mengirim pesan error.
        const retryPrompt = await env.CHAT_HISTORY.get(`spaces_prompt:${chatId}`);
        const { retryable } = await handleSpacesResult(env, chatId, data, data.progressMsgId, { fallbackOnRetryable: !!retryPrompt })
          || {};
        if (retryable) {
          await env.CHAT_HISTORY.delete(`spaces_prompt:${chatId}`).catch(() => {});
          const { processMessage } = await import("./message.js");
          // Lock chat masih dipegang (tidak dilepas handleSpacesResult); processMessage melepasnya.
          await processMessage({ chat: { id: chatId }, text: retryPrompt }, env, { forceRuntime: "worker" });
        }
      } catch (e) {
        console.error(`[Cron] Failed to poll Spaces result for chat ${chatId}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Cron] Spaces polling error:', e.message);
  }
}

// Watchdog: tugas di Vercel yang tidak memberi kabar > 6 menit (maxDuration 300 detik +
// pengantaran) dianggap mati. User diberi tahu, lock & pesan progres dibersihkan.
export async function reapStaleRemoteJobs(env, maxAgeSeconds = 360) {
  const { getStaleRemoteJobs, markRemoteJobDone, releaseChatLock } = await import("../db/index.js");
  const { deleteTelegramMessage } = await import("../services/telegram.js");
  const stale = await getStaleRemoteJobs(env, maxAgeSeconds);
  for (const job of stale) {
    const chatId = job.chat_id;
    await markRemoteJobDone(env, chatId);
    if (await env.CHAT_HISTORY.get(`hdl:${chatId}`)) continue; // hasil sedang diantar
    const pid = await env.CHAT_HISTORY.get(`progress_msg:${chatId}`);
    if (pid) {
      await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, parseInt(pid)).catch(() => {});
      await env.CHAT_HISTORY.delete(`progress_msg:${chatId}`).catch(() => {});
    }
    await releaseChatLock(env, chatId);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      `tugas yang tadi (${job.runtime}) ga ngasih kabar lebih dari ${Math.round(maxAgeSeconds / 60)} menit, kayaknya keputus di tengah jalan 😥\n` +
      `ketik /retry buat ngulang, atau /trace buat liat sampai mana.`);
    console.warn(`[Watchdog] job ${job.runtime} untuk chat ${chatId} dianggap mati`);
  }
  return stale.length;
}

// Akun bot (pemilik GITHUB_PAT_TOKEN) otomatis menerima undangan collaborator —
// HANYA dari pemilik (OWNER_GITHUB_LOGIN, default thirapi). Undangan lain diabaikan.
export async function acceptOwnerInvitations(env) {
  if (!env.GITHUB_PAT_TOKEN) return [];
  const { callGitHubAPI } = await import("../services/github.js");
  const owner = String(env.OWNER_GITHUB_LOGIN || "thirapi").toLowerCase();
  const invites = await callGitHubAPI(env, "user/repository_invitations");
  const accepted = [];
  for (const inv of Array.isArray(invites) ? invites : []) {
    if (String(inv?.inviter?.login || "").toLowerCase() !== owner) continue;
    try {
      await callGitHubAPI(env, `user/repository_invitations/${inv.id}`, "PATCH");
      accepted.push(inv.repository?.full_name || String(inv.id));
    } catch (e) {
      console.error(`[Cron] gagal menerima undangan ${inv.id}:`, e.message);
    }
  }
  if (accepted.length) console.log(`[Cron] undangan diterima: ${accepted.join(", ")}`);
  return accepted;
}

export async function handleCron(event, env, ctx) {
  // 1. Handle reminders
  const now = Math.floor(Date.now() / 1000);
  const due = await getDueReminders(env, now);

  for (const reminder of due) {
    try {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        reminder.chat_id,
        `<b>eeh inget!</b>\n${reminder.title}`,
      );

      let nextTrigger = null;
      if (reminder.recurring && reminder.interval_seconds > 0) {
        nextTrigger = now + reminder.interval_seconds;
      }
      await markReminderTriggered(env, reminder.id, now, nextTrigger);
    } catch (e) {
      console.error(`Cron: gagal kirim reminder ${reminder.id}:`, e.message);
    }
  }

  if (due.length > 0) {
    console.log(`Cron: ${due.length} reminder(s) terkirim.`);
  }

  // 2. Poll Spaces for pending results (fallback for short-poll failures)
  await pollSpacesResults(env, ctx);

  // 2b. Watchdog tugas Vercel yang mati tanpa kabar.
  await reapStaleRemoteJobs(env).catch((e) => console.error("[Watchdog] error:", e.message));

  // 3. Sekali sehari (03:00 WIB): buang trace > 7 hari.
  const at = new Date(event?.scheduledTime || Date.now());
  if (at.getUTCHours() === 20 && at.getUTCMinutes() === 0) {
    const { pruneTaskTraces } = await import("../db/index.js");
    await pruneTaskTraces(env);
  }

  // 4. Tiap 15 menit: terima undangan repo dari pemilik.
  const minute = new Date(event?.scheduledTime || Date.now()).getUTCMinutes();
  if (minute % 15 === 0) {
    await acceptOwnerInvitations(env).catch((e) => console.error("[Cron] cek undangan gagal:", e.message));
  }
}
