
export async function handleSpacesResult(env, chatId, data, progressMsgId) {
  const { addHistory, trimHistory, removePendingSpace, releaseChatLock } = await import("../db/index.js");
  const { sendTelegramMessage, deleteTelegramMessage, followUpKeyboard } = await import("../services/telegram.js");
  const { markdownToRichHtml } = await import("../utils/formatter.js");

  console.log(`[SpacesResult] Result ready for chat ${chatId}`);
  console.log(`[SpacesResult] chatId=${chatId} newContent=${data.newContent?.length} finalText=${data.finalText?.slice(0,30)} proxySent=${data.proxySent}`);

  try {
    if (data.newContent && data.newContent.length > 0) {
      const cleaned = data.newContent.map(c => ({
        role: c.role,
        parts: c.parts.map(p => {
          if (p.inline_data) return { text: `[Media: ${p.inline_data.mime_type}]` };
          const cp = {};
          if (p.text !== undefined) cp.text = p.text;
          if (Object.keys(cp).length > 0) return cp;
          if (p.functionCall) return { text: `[FunctionCall: ${p.functionCall.name}]` };
          if (p.functionResponse) return { text: `[FunctionResponse: ${p.functionResponse.name}]` };
          return { text: '' };
        }).filter(p => p.text || Object.keys(p).length > 0)
      }));
      await addHistory(env, chatId, cleaned);
      await trimHistory(env, chatId, 15);
    }
    console.log(`[SpacesResult] Step1: addHistory done for ${chatId}`);
  } catch (e) { console.error(`[SpacesResult] Step1 FAIL (addHistory):`, e.message); }

  // Skip sending if proxy already sent the message
  if (!data.proxySent) {
    try {
      if (data.escalationTriggered) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
          "tugas ini butuh akses sistem yang lebih dalam. aku kerjakan di GitHub Actions ya...");
      } else if (data.finalText) {
        const richHtml = markdownToRichHtml(data.finalText);
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, richHtml, followUpKeyboard());
      } else if (data.error) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
          `yah eror pas jalanin di server: ${data.error}. coba kirim lagi ya!`);
      } else {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
          "tugasnya udah aku jalanin ya! tp aku ga dapet respons teks penutup dr sistem. coba cek repo kamu deh, harusnya kodenya udh ke-update");
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

  try {
    await fetch(`${env.HF_SPACES_URL}/api/result?chatId=${chatId}`, { method: 'DELETE' });
  } catch (_) {}

  await env.CHAT_HISTORY.put(`callback_done:${chatId}`, "1", { expirationTtl: 300 }).catch(() => {});
  await env.CHAT_HISTORY.delete(`hdl:${chatId}`).catch(() => {});
  console.log(`[SpacesResult] Completed for chat ${chatId}`);
}

export async function pollSpacesResult(env, chatId, progressMsgId) {
  const maxTime = 30000;
  const startTime = Date.now();
  let attempt = 0;
  const delays = [0, 2000, 3000, 5000, 10000];

  while (Date.now() - startTime < maxTime) {
    attempt++;

    const idx = Math.min(attempt - 1, delays.length - 1);
    if (delays[idx] > 0) {
      await new Promise(r => setTimeout(r, delays[idx]));
    }

    try {
      const res = await fetch(`${env.HF_SPACES_URL}/api/result/${chatId}`, {
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();

      if (data.status === 'processing') continue;
      if (data.status === 'not_found') continue;
      if (data.status !== 'ready') continue;

      const mutexKey = `hdl:${chatId}`;
      if (await env.CHAT_HISTORY.get(mutexKey)) {
        console.log(`[ShortPoll] Chat ${chatId} already being handled, skipping`);
        return true;
      }

      await env.CHAT_HISTORY.put(mutexKey, "1", { expirationTtl: 120 });

      await handleSpacesResult(env, chatId, data, progressMsgId);
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
