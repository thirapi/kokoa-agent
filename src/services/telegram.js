import { TG_MAX_MESSAGE_LENGTH } from "../config.js";
import { splitIntoChunks, stripHtml } from "../utils/formatter.js";

const TG_API = (token, method) =>
  `https://api.telegram.org/bot${token}/${method}`;

function fetchWithTimeout(url, options, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .then(res => { clearTimeout(timeoutId); return res; })
    .catch(err => { clearTimeout(timeoutId); throw err; });
}

export async function sendTelegramAction(token, chatId, action) {
  return fetchWithTimeout(TG_API(token, "sendChatAction"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  }, 5000);
}

export async function sendTelegramMessage(token, chatId, htmlText, replyMarkup = null) {
  const url = TG_API(token, "sendMessage");
  const chunks = splitIntoChunks(htmlText, TG_MAX_MESSAGE_LENGTH);
  const sentMsgs = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const payload = {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
    };
    if (i === chunks.length - 1 && replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const plainText = stripHtml(chunk);
      const fallbackPayload = { chat_id: chatId, text: plainText };
      if (i === chunks.length - 1 && replyMarkup) {
        fallbackPayload.reply_markup = replyMarkup;
      }
      const fallbackRes = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fallbackPayload),
      });
      if (fallbackRes.ok) {
        const data = await fallbackRes.json();
        if (data.result) sentMsgs.push(data.result);
      }
    } else {
      const data = await res.json();
      if (data.result) sentMsgs.push(data.result);
    }
  }
  return sentMsgs;
}

export function followUpKeyboard() {
  // callback_data dibuat super pendek (1 kata) agar terbaca sebagai lanjutan topik,
  // bukan permintaan umum baru (lihat detectScope di src/agent/scope.js)
  return {
    inline_keyboard: [
      [
        { text: "🔍 detailin", callback_data: "detailin" },
        { text: "➡️ lanjutin", callback_data: "lanjutkan" }
      ]
    ]
  };
}

export async function sendTelegramPhoto(token, chatId, photoUrl, caption = "") {
  const url = TG_API(token, "sendPhoto");
  const payload = { chat_id: chatId, photo: photoUrl };
  if (caption) {
    payload.caption = caption.slice(0, 1000);
    payload.parse_mode = "HTML";
  }
  // 30s: Telegram harus download dulu file gambar dari URL remote (seperti sendAudio).
  let res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, 30000);
  if (!res.ok && caption) {
    delete payload.parse_mode;
    payload.caption = stripHtml(caption).slice(0, 1000);
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, 30000);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`sendPhoto gagal (${res.status}): ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.result || { ok: true };
}

export async function sendTelegramAudio(token, chatId, audioUrl, performer = "", title = "", caption = "") {
  const url = TG_API(token, "sendAudio");
  const payload = { chat_id: chatId, audio: audioUrl };
  if (performer) payload.performer = performer.slice(0, 200);
  if (title) payload.title = title.slice(0, 200);
  if (caption) {
    payload.caption = caption.slice(0, 1000);
    payload.parse_mode = "HTML";
  }
  let res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, 30000);
  if (!res.ok && (caption || performer || title)) {
    delete payload.parse_mode;
    if (payload.caption) payload.caption = stripHtml(payload.caption).slice(0, 1000);
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, 30000);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`sendAudio gagal (${res.status}): ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.result || { ok: true };
}

export async function editTelegramMessage(token, chatId, messageId, htmlText) {
  const url = TG_API(token, "editMessageText");
  const payload = {
    chat_id: chatId,
    message_id: parseInt(messageId, 10),
    text: htmlText,
    parse_mode: "HTML",
  };
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, 5000);
  if (!res.ok) {
    const plainText = stripHtml(htmlText);
    await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: parseInt(messageId, 10),
        text: plainText,
      }),
    }, 5000).catch(() => {});
  }
}

export async function deleteTelegramMessage(token, chatId, messageId) {
  const url = TG_API(token, "deleteMessage");
  await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: parseInt(messageId, 10),
    }),
  }, 5000).catch(() => {});
}
