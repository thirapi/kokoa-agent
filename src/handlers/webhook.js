import { RATE_LIMIT_SECONDS } from "../config.js";
import { sendTelegramMessage } from "../services/telegram.js";
import { processMessage } from "./message.js";
import { checkGeminiQuota } from "../services/gemini.js";
import { checkGroqQuota } from "../services/groq.js";
import { clearHistory, acquireChatLock, releaseChatLock } from "../db/index.js";
import { logError, getRecentErrors } from "../utils/logger.js";

export async function handleWebhook(request, env, ctx) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const payload = await request.json();
    let message = payload.message || payload.edited_message;
    const updateId = payload.update_id;

    if (payload.callback_query) {
      const cb = payload.callback_query;
      message = {
        chat: cb.message.chat,
        from: cb.from,
        text: cb.data,
        message_id: cb.message.message_id
      };
    }

    if (!message || !message.chat || !message.chat.id) {
      return new Response("OK", { status: 200 });
    }

    const chatId = String(message.chat.id);
    const senderId = message.from ? String(message.from.id) : "";
    const rateLimitKey = `rate_limit:${chatId}`;
    const lastUpdateKey = `last_update:${chatId}`;

    const allowedIds = (env.ALLOWED_USER_ID || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    // Normalisasi ID: Hapus "-100" jika supergroup untuk kecocokan toleran
    const normalizeId = (idStr) => idStr.replace(/^-100/, "-");
    const normChatId = normalizeId(chatId);
    const normSenderId = normalizeId(senderId);

    const isAllowed = allowedIds.some((id) => {
      const normAllowed = normalizeId(id);
      return normAllowed === normChatId || normAllowed === normSenderId || id === chatId || id === senderId;
    });

    if (!isAllowed) {
      console.warn(`Unauthorized access: chatId=${chatId}, senderId=${senderId}. Allowed: ${allowedIds.join(", ")}`);
      return new Response("OK", { status: 200 });
    }

    // Jika pesan dari Grup / Supergroup, respon jika di-mention, di-reply, atau command eksplisit (/skill)
    const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
    if (isGroup) {
      const text = message.text || message.caption || "";
      const isReplyToBot = message.reply_to_message?.from?.is_bot;
      const hasMentionEntity = (message.entities || message.caption_entities || []).some(
        (e) => e.type === "mention" || e.type === "text_mention"
      );
      const isMentioned = text.toLowerCase().includes("@") || isReplyToBot || hasMentionEntity;
      const isExplicitCommand = text.trim().toLowerCase().startsWith("/skill");
      if (!isMentioned && !isExplicitCommand) {
        return new Response("OK", { status: 200 });
      }
    }

    const lastUpdateId = await env.CHAT_HISTORY.get(lastUpdateKey);
    if (lastUpdateId === String(updateId)) {
      console.log(`Duplicate update ${updateId} for chat ${chatId}, skipping.`);
      return new Response("OK", { status: 200 });
    }

    let text = message.text || message.caption || "";
    let normalizedText = text.trim().toLowerCase();

    // Command /skill <nama> [prompt]: paksa skill tertentu untuk pesan ini (+10 menit ke depan)
    if (normalizedText.startsWith("/skill")) {
      const { getSkill, setForcedSkill, SKILLS } = await import("../agent/skills.js");
      const parts = text.trim().split(/\s+/);
      const skillName = (parts[1] || "").toLowerCase();
      const skill = getSkill(skillName);
      if (!skill) {
        const names = SKILLS.map(s => s.name).join(", ");
        ctx.waitUntil(sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN, chatId,
          `skillnya ga ketemu bjir. yg ada: ${names}. contoh: /skill review-pr tolong review pr 42 di thirapi/tg-bot`
        ));
        await env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 });
        return new Response("OK", { status: 200 });
      }
      await setForcedSkill(env, chatId, skill.name);
      const remainder = parts.slice(2).join(" ").trim();
      if (!remainder) {
        ctx.waitUntil((async () => {
          await env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 });
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN, chatId,
            `skill ${skill.name} aktif 10 menit ke depan wkwk. tinggal kirim aja maumu apa`
          );
        })());
        return new Response("OK", { status: 200 });
      }
      if (message.text) message.text = remainder;
      if (message.caption) message.caption = remainder;
      text = remainder;
      normalizedText = text.trim().toLowerCase();
    }

    // Handle relay callback from Spaces via Telegram (when direct callback fails)
    if (text.startsWith("__CB__")) {
      ctx.waitUntil((async () => {
        try {
          const encoded = text.slice(6).trim();
          const payload = JSON.parse(atob(encoded));
          if (payload.token !== 'kokoa-runner-secret') {
            console.warn('[Webhook] Relay callback rejected: invalid token');
            return;
          }
          console.log(`[Webhook] Relay callback for chat ${payload.chatId}`);
          if (payload.isFinal) {
            await releaseChatLock(env, payload.chatId);
          }
          if (payload.newContents && payload.newContents.length > 0) {
            const { addHistory, trimHistory } = await import("../db/index.js");
            const cleaned = payload.newContents.map(c => ({
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
            await addHistory(env, payload.chatId, cleaned);
            await trimHistory(env, payload.chatId, payload.maxHistory || 15);
          }
          // Delete relay message so user doesn't see it
          if (message.message_id) {
            const { deleteTelegramMessage } = await import("../services/telegram.js");
            await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, payload.chatId || chatId, message.message_id).catch(() => {});
          }
        } catch (e) {
          console.error("[Webhook] Relay callback error:", e);
        }
      })());
      return new Response("OK", { status: 200 });
    }

    if (normalizedText === "/start" || normalizedText === "/reset") {
      ctx.waitUntil((async () => {
        await env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 });
        await clearHistory(env, chatId);
        await releaseChatLock(env, chatId);
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "oke, memorinya udh aku hapus ya. yuk kita mulai obrolan baru lagi, mau bahas apa nih?",
        );
      })());
      return new Response("OK", { status: 200 });
    }

    if (normalizedText === "/help" || normalizedText === "/menu") {
      ctx.waitUntil((async () => {
        await env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 });
        const helpMsg =
          "<b>Halo! Pilih menu cepat di bawah ini atau ketik langsung permintaanmu:</b>";
        const inlineKeyboard = {
          inline_keyboard: [
            [
              { text: "📊 Status Kuota", callback_data: "/quota" },
              { text: "🔄 Reset Chat", callback_data: "/reset" }
            ],
            [
              { text: "🔓 Unblock Cooldown", callback_data: "/unblock" },
              { text: "🐞 Debug Logs", callback_data: "/logs" }
            ]
          ]
        };
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, helpMsg, inlineKeyboard);
      })());
      return new Response("OK", { status: 200 });
    }

    if (normalizedText === "/unblock") {
      ctx.waitUntil((async () => {
        try {
          await env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 });
          const geminiKeys = (env.GEMINI_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
          const groqKeys = (env.GROQ_API_KEY || "").split(",").map((k) => k.trim()).filter(Boolean);
          const allKeys = [...geminiKeys, ...groqKeys];
          const deletePromises = allKeys.map(key => env.CHAT_HISTORY.delete(`cooldown:${key.slice(-6)}`));
          await Promise.all([
            ...deletePromises,
            releaseChatLock(env, chatId),
          ]);
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            "oke, semua status yang macet udh direset ya! aku siap lagi nih",
          );
        } catch (err) {
          console.error("Unblock Error:", err);
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "aduh, gagal reset blacklist nih...");
        }
      })());
      return new Response("OK", { status: 200 });
    }

    if (normalizedText === "/logs" || normalizedText === "/error" || normalizedText === "/debug") {
      ctx.waitUntil((async () => {
        try {
          await env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 });
          const errors = await getRecentErrors(env, chatId, 10);
          if (errors.length === 0) {
            await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "belum ada error yg tercatat.");
            return;
          }
          const lines = errors.map((e, i) => {
            const time = new Date(e.timestamp).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
            return `${i + 1}. [${time}] (${e.context})\n   ${e.message}`;
          });
          const msg = `<b>error log terbaru:</b>\n\n${lines.join("\n\n")}`;
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg);
        } catch (err) {
          console.error("Logs fetch error:", err);
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "gagal ambil log error.");
        }
      })());
      return new Response("OK", { status: 200 });
    }

    if (normalizedText === "/quota" || normalizedText === "/keys") {
      ctx.waitUntil((async () => {
        try {
          await env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 });
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "sip, tunggu bentar ya! aku cek dulu status koneksinya...");
          const geminiStatus = env.GEMINI_API_KEYS ? await checkGeminiQuota(env) : "";
          const groqStatus = env.GROQ_API_KEY ? await checkGroqQuota(env) : "";
          const quotaStatus = [geminiStatus, groqStatus].filter(Boolean).join("\n\n");
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, quotaStatus);
        } catch (err) {
          console.error("Quota Check Error:", err);
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "aduh, ada eror pas lagi cek kuota. coba lagi nanti ya!");
        }
      })());
      return new Response("OK", { status: 200 });
    }

    const lastReqTimeStr = await env.CHAT_HISTORY.get(rateLimitKey);
    const now = Date.now();
    if (lastReqTimeStr) {
      const lastReqTime = parseInt(lastReqTimeStr);
      if (now - lastReqTime < RATE_LIMIT_SECONDS * 1000) {
        console.log(`Chat ${chatId} hit rate limit cooldown, skipping.`);
        return new Response("OK", { status: 200 });
      }
    }

    const acquired = await acquireChatLock(env, chatId);
    if (!acquired) {
      console.log(`Chat ${chatId} locked (D1), queueing message.`);
      await env.CHAT_HISTORY.put(`pending:${chatId}`, JSON.stringify({
        updateId, text: message.text, caption: message.caption,
        photo: message.photo, voice: message.voice,
        timestamp: Date.now(),
      }), { expirationTtl: 300 });
      ctx.waitUntil(sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "oke, pesanmu masuk antrian ya! bentar aku selesain dulu yg sebelumnya, nanti langsung aku bales.",
      ));
      return new Response("OK", { status: 200 });
    }

    await Promise.all([
      env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 }),
      env.CHAT_HISTORY.put(rateLimitKey, String(now), { expirationTtl: 60 }),
    ]);

    const requestUrl = new URL(request.url);
    const workerUrl = requestUrl.origin;
    const dynamicEnv = { ...env, WORKER_URL: workerUrl };

    ctx.waitUntil(processMessage(message, dynamicEnv));

    return new Response("OK", { status: 200 });

  } catch (err) {
    console.error("Critical Webhook Error:", err);
    await logError(env, "global", "webhook", err).catch(() => {});
    return new Response("OK", { status: 200 });
  }
}