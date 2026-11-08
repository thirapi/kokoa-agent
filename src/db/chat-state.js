// Dedupe update Telegram & rate limit per chat. Utama di D1 (tabel chat_state);
// otomatis jatuh ke KV bila tabel belum ada (migrasi belum dijalankan).

async function d1(env, fn) {
  if (!env?.DB?.prepare) throw new Error("no D1");
  return fn(env.DB);
}

export async function getChatState(env, chatId) {
  try {
    const row = await d1(env, (db) => db.prepare(
      "SELECT last_update_id, last_request_at FROM chat_state WHERE chat_id = ?").bind(String(chatId)).first());
    return { lastUpdateId: row?.last_update_id ?? null, lastRequestAt: row?.last_request_at ?? null, backend: "d1" };
  } catch (_) {
    const [u, r] = await Promise.all([
      env.CHAT_HISTORY.get(`last_update:${chatId}`), env.CHAT_HISTORY.get(`rate_limit:${chatId}`),
    ]);
    return { lastUpdateId: u, lastRequestAt: r ? parseInt(r, 10) : null, backend: "kv" };
  }
}

// Tandai update sudah dilihat (dan opsional waktu request untuk rate limit). Satu tulis D1.
export async function markUpdateSeen(env, chatId, updateId, { requestAt = null } = {}) {
  try {
    await d1(env, (db) => db.prepare(
      `INSERT INTO chat_state (chat_id, last_update_id, last_request_at, updated_at) VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(chat_id) DO UPDATE SET last_update_id = excluded.last_update_id,
         last_request_at = COALESCE(excluded.last_request_at, chat_state.last_request_at), updated_at = unixepoch()`
    ).bind(String(chatId), String(updateId), requestAt).run());
  } catch (_) {
    await env.CHAT_HISTORY.put(`last_update:${chatId}`, String(updateId), { expirationTtl: 300 });
    if (requestAt != null) await env.CHAT_HISTORY.put(`rate_limit:${chatId}`, String(requestAt), { expirationTtl: 60 });
  }
}
