
import { runnerAuthHeaders } from "../utils/auth.js";
import { cleanContentsForHistory } from "../utils/history.js";
import { MAX_HISTORY } from "../config.js";
import { isRetryableSpacesError } from "../agent/route.js";

// Simpan snapshot approval (KV) lalu kirim tombol ✅/❌. Tombol approval sebelumnya
// di chat yang sama dicopot agar tidak diketuk saat sudah basi.
export async function sendApprovalPrompt(env, chatId, approval) {
  const { saveApproval, approvalPromptText, approvalButtons } = await import("../agent/approval.js");
  const { sendTelegramMessage } = await import("../services/telegram.js");
  await saveApproval(env, approval.id, { status: "pending", snapshot: approval.snapshot });
  const prevMsgId = await env.CHAT_HISTORY.get(`last_approval_msg:${chatId}`);
  if (prevMsgId) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: Number(prevMsgId), reply_markup: { inline_keyboard: [] } }),
    }).catch(() => {});
  }
  const sent = await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
    approvalPromptText(approval.tool, approval.toolArgs), approvalButtons(approval.id));
  const mid = Array.isArray(sent) ? sent[sent.length - 1]?.message_id : null;
  if (mid) await env.CHAT_HISTORY.put(`last_approval_msg:${chatId}`, String(mid), { expirationTtl: 3600 });
}

// opts.fallbackOnRetryable: pemanggil akan mengerjakan ulang di Worker bila Spaces gagal
// karena jaringan/provider. Dalam kasus itu: jangan kirim pesan error, jangan lepas lock,
// jangan proses antrean — pemanggil yang melanjutkan. Return { retryable }.
export async function handleSpacesResult(env, chatId, data, progressMsgId, opts = {}) {
  const retryable = !!opts.fallbackOnRetryable && !data.finalText && !data.proxySent
    && !data.escalationTriggered && !!data.error && isRetryableSpacesError(data.error);
  const { addHistory, trimHistory, removePendingSpace, releaseChatLock } = await import("../db/index.js");
  const { sendTelegramMessage, deleteTelegramMessage, sendTelegramPhoto, sendTelegramAudio } = await import("../services/telegram.js");
  const { markdownToRichHtml } = await import("../utils/formatter.js");

  console.log(`[SpacesResult] Result ready for chat ${chatId}`);
  console.log(`[SpacesResult] chatId=${chatId} newContent=${data.newContent?.length} finalText=${data.finalText?.slice(0,30)} proxySent=${data.proxySent}`);

  try {
    // historySynced = Spaces sudah sync riwayat via callback; jangan simpan dua kali
    if (data.newContent && data.newContent.length > 0 && !data.historySynced) {
      await addHistory(env, chatId, cleanContentsForHistory(data.newContent));
      await trimHistory(env, chatId, MAX_HISTORY);
    }
    console.log(`[SpacesResult] Step1: addHistory done for ${chatId}`);
  } catch (e) { console.error(`[SpacesResult] Step1 FAIL (addHistory):`, e.message); }

  // Media yang gagal dikirim dari Spaces (egress HF diblokir untuk api.telegram.org)
  // diantar dari sini (Worker -> Telegram). Dijamin sekali-kirim oleh mutex hdl: + removePendingSpace.
  try {
    const queued = Array.isArray(data.pendingMedia) ? data.pendingMedia.slice(0, 2) : [];
    for (const m of queued) {
      try {
        if (m.kind === 'audio') {
          await sendTelegramAudio(env.TELEGRAM_BOT_TOKEN, chatId, m.url, m.performer || "", m.title || "", m.caption || "");
        } else {
          await sendTelegramPhoto(env.TELEGRAM_BOT_TOKEN, chatId, m.url, m.caption || "");
        }
        console.log(`[SpacesResult] Delivered queued ${m.kind} for ${chatId}`);
      } catch (e) {
        console.error(`[SpacesResult] Queued ${m?.kind} delivery FAIL:`, e.message);
      }
    }
  } catch (e) { console.error(`[SpacesResult] Queued media block FAIL:`, e.message); }

  if (data.approval?.id && data.approval?.snapshot) {
    // Spaces berhenti menunggu izin: simpan snapshot & kirim tombol dari sini.
    try {
      await sendApprovalPrompt(env, chatId, data.approval);
      console.log(`[SpacesResult] Approval ${data.approval.id} dikirim untuk ${chatId}`);
    } catch (e) { console.error(`[SpacesResult] Approval FAIL:`, e.message); }
  } else if (retryable) {
    console.warn(`[SpacesResult] Spaces gagal (${String(data.error).slice(0, 80)}), dikerjakan ulang di Worker untuk ${chatId}`);
  } else if (!data.proxySent) {
    try {
      if (data.escalationTriggered) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
          "tugas ini butuh akses sistem yang lebih dalam. aku kerjakan di GitHub Actions ya...");
      } else if (data.finalText) {
        const richHtml = markdownToRichHtml(data.finalText);
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, richHtml);
      } else if (data.error) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
          `yah eror pas jalanin di server: ${data.error}. coba kirim lagi ya!`);
      } else {
        const { noFinalTextMessage } = await import("../utils/net.js");
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
          noFinalTextMessage(data));
      }
      console.log(`[SpacesResult] Step2: sendTelegram done for ${chatId}`);
    } catch (e) { console.error(`[SpacesResult] Step2 FAIL (sendTelegram):`, e.message); }
  } else {
    console.log(`[SpacesResult] Step2: sendTelegram skipped (already sent by proxy) for ${chatId}`);
  }

  try {
    await removePendingSpace(env, chatId);
    console.log(`[SpacesResult] Step3: removePendingSpace done for ${chatId}`);
  } catch (e) { console.error(`[SpacesResult] Step3 FAIL (removePendingSpace):`, e.message); }

  try {
    let pid = progressMsgId || data.progressMsgId;
    if (!pid) {
      pid = await env.CHAT_HISTORY.get(`progress_msg:${chatId}`);
    }
    if (pid) {
      await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, parseInt(pid)).catch(e =>
        console.error(`[SpacesResult] Step4 deleteProgress FAIL:`, e.message)
      );
      await env.CHAT_HISTORY.delete(`progress_msg:${chatId}`).catch(() => {});
    }
    console.log(`[SpacesResult] Step4: deleteProgress done for ${chatId}`);
  } catch (e) { console.error(`[SpacesResult] Step4 FAIL (deleteProgress):`, e.message); }

  if (!retryable) {
  try {
    await releaseChatLock(env, chatId);
    console.log(`[SpacesResult] Step5: releaseChatLock done for ${chatId}`);
  } catch (e) { console.error(`[SpacesResult] Step5 FAIL (releaseChatLock):`, e.message); }

  try {
    const { processMessage } = await import("../handlers/message.js");
    const pendingRaw = await env.CHAT_HISTORY.get(`pending:${chatId}`);
    if (pendingRaw) {
      await env.CHAT_HISTORY.delete(`pending:${chatId}`).catch(() => {});
      const pending = JSON.parse(pendingRaw);
      const { acquireChatLock } = await import("../db/index.js");
      const acquired = await acquireChatLock(env, chatId);
      if (acquired) {
        const fakeMsg = {
          chat: { id: chatId },
          text: pending.text,
          caption: pending.caption,
          photo: pending.photo,
          voice: pending.voice,
        };
        processMessage(fakeMsg, env).catch(e =>
          console.error(`[SpacesResult] Dequeue processMessage error:`, e)
        );
      }
    }
  } catch (e) {
    console.error(`[SpacesResult] Dequeue pending message failed for chat ${chatId}:`, e);
  }

  }

  try {
    await fetch(`${env.HF_SPACES_URL}/api/result?chatId=${encodeURIComponent(chatId)}`, {
      method: 'DELETE',
      headers: runnerAuthHeaders(env),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {}

  await env.CHAT_HISTORY.put(`callback_done:${chatId}`, "1", { expirationTtl: 300 }).catch(() => {});
  await env.CHAT_HISTORY.delete(`hdl:${chatId}`).catch(() => {});
  console.log(`[SpacesResult] Completed for chat ${chatId}`);
  return { retryable };
}

export async function pollSpacesResult(env, chatId, progressMsgId) {
  const maxTime = 30000;
  const startTime = Date.now();
  let attempt = 0;
  let lastData = null;
  const delays = [0, 2000, 3000, 5000, 10000];

  while (Date.now() - startTime < maxTime) {
    attempt++;

    const idx = Math.min(attempt - 1, delays.length - 1);
    if (delays[idx] > 0) {
      await new Promise(r => setTimeout(r, delays[idx]));
    }

    try {
      const res = await fetch(`${env.HF_SPACES_URL}/api/result/${encodeURIComponent(chatId)}`, {
        headers: runnerAuthHeaders(env),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      lastData = data;

      if (data.status === 'processing') continue;
      if (data.status === 'not_found') continue;
      if (data.status !== 'ready') continue;

      const mutexKey = `hdl:${chatId}`;
      if (await env.CHAT_HISTORY.get(mutexKey)) {
        console.log(`[ShortPoll] Chat ${chatId} already being handled, skipping`);
        return true;
      }

      await env.CHAT_HISTORY.put(mutexKey, "1", { expirationTtl: 120 });

      const { retryable } = await handleSpacesResult(env, chatId, data, progressMsgId, { fallbackOnRetryable: true });
      // Gagal karena jaringan/provider -> false: message.js mengerjakan ulang di Worker.
      // Error lain sudah dilaporkan ke user oleh handleSpacesResult -> selesai.
      if (retryable) return false;
      return true;
    } catch (e) {
      console.error(`[ShortPoll] Attempt ${attempt} failed for ${chatId}:`, e.message);
      await env.CHAT_HISTORY.delete(`hdl:${chatId}`).catch(() => {});
    }
  }

  console.log(`[ShortPoll] Timed out for ${chatId} after ${attempt} attempts, leaving for cron`);
  const { releaseChatLock } = await import("../db/index.js");
  await releaseChatLock(env, chatId);
  console.log(`[ShortPoll] Released lock for ${chatId} after timeout`);
  return false;
}
