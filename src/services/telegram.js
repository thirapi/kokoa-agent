import { TG_MAX_MESSAGE_LENGTH } from "../config.js";
import { splitIntoChunks, stripHtml } from "../utils/formatter.js";

const TG_API = (token, method) =>
  `https://api.telegram.org/bot${token}/${method}`;

// Info publik user Telegram: nama, username, bio (bila dikembalikan API), foto profil.
// Hanya bisa untuk user yang pernah berinteraksi (punya user_id dari reply/konteks chat).
// Username saja (@seseorang) TIDAK bisa di-resolve — Telegram tidak mengizinkan bot lookup sembarang user.
// photoFileId dikembalikan (bukan URL) agar token bot tidak bocor ke history;
// teruskan langsung ke sendPhoto sebagai imageUrl (Telegram menerima file_id).
export async function getTelegramUserInfo(token, userId) {
  const id = String(userId || "").trim();
  if (!id) throw new Error("userId kosong.");
  const chatRes = await fetchWithTimeout(TG_API(token, "getChat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: id }),
  }, 15000);
  if (!chatRes.ok) {
    const errText = await chatRes.text().catch(() => "");
    throw new Error(`getChat gagal (${chatRes.status}): ${errText.slice(0, 150)}`);
  }
  const chat = (await chatRes.json()).result || {};
  const photosRes = await fetchWithTimeout(TG_API(token, "getUserProfilePhotos"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: Number(id), limit: 1 }),
  }, 15000);
  let photoFileId = null;
  let photoCount = 0;
  if (photosRes.ok) {
    const pdata = await photosRes.json();
    photoCount = pdata.result?.total_count || 0;
    const biggest = pdata.result?.photos?.[0];
    if (biggest && biggest.length > 0) {
      photoFileId = biggest[biggest.length - 1].file_id || null;
    }
  }
  const firstName = chat.first_name || "";
  const lastName = chat.last_name || "";
  return {
    id: chat.id ?? Number(id),
    name: `${firstName} ${lastName}`.trim() || "(tanpa nama)",
    username: chat.username ? `@${chat.username}` : "(tanpa username)",
    bio: chat.bio || null,
    bioNote: chat.bio ? null : "bio tidak dikembalikan API (user menyembunyikan atau belum pasang).",
    photoCount,
    photoFileId,
    photoNote: photoFileId
      ? "teruskan photoFileId ini sebagai imageUrl ke sendPhoto untuk mengirim foto profilnya."
      : "tidak ada foto profil yang bisa diambil.",
  };
}

function fetchWithTimeout(url, options, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .then(res => { clearTimeout(timeoutId); return res; })
    .catch(err => { clearTimeout(timeoutId); throw err; });
}

// POST ke Telegram dengan 1x retry KHUSUS saat fetch-nya sendiri gagal (network abort/reset).
// Aman dari double-send: retry hanya bila request tidak pernah sampai (throw),
// bukan saat Telegram sudah merespons (!ok ditangani caller via fallback).
async function postTGWithRetry(url, payload, timeoutMs = 10000) {
  try {
    return await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, timeoutMs);
  } catch (e) {
    await new Promise(r => setTimeout(r, 2000));
    return await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, timeoutMs);
  }
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

export async function sendTelegramPhoto(token, chatId, photoUrl, caption = "") {
  const url = TG_API(token, "sendPhoto");
  const payload = { chat_id: chatId, photo: photoUrl };
  if (caption) {
    payload.caption = caption.slice(0, 1000);
    payload.parse_mode = "HTML";
  }
  // 30s: Telegram harus download dulu file gambar dari URL remote (seperti sendAudio).
  let res = await postTGWithRetry(url, payload, 30000);
  if (!res.ok && caption) {
    delete payload.parse_mode;
    payload.caption = stripHtml(caption).slice(0, 1000);
    res = await postTGWithRetry(url, payload, 30000);
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
  let res = await postTGWithRetry(url, payload, 30000);
  if (!res.ok && (caption || performer || title)) {
    delete payload.parse_mode;
    if (payload.caption) payload.caption = stripHtml(payload.caption).slice(0, 1000);
    res = await postTGWithRetry(url, payload, 30000);
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
