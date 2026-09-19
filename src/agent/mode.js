// Mode agent per chat: plan (read-only, observasi) vs build (full akses).
// Default build agar perilaku lama tidak berubah; user kunci via /plan, buka via /build.

export async function resolveAgentMode(env, chatId) {
  if (env.AGENT_MODE === 'plan' || env.AGENT_MODE === 'build') return env.AGENT_MODE;
  try {
    const saved = await env.CHAT_HISTORY?.get(`mode:${chatId}`);
    if (saved === 'plan' || saved === 'build') {
      env.AGENT_MODE = saved;
      return saved;
    }
  } catch (_) {}
  env.AGENT_MODE = 'build';
  return 'build';
}

export async function setAgentMode(env, chatId, mode) {
  try {
    if (!env?.CHAT_HISTORY?.put || !chatId) return;
    if (mode !== 'plan' && mode !== 'build') return;
    await env.CHAT_HISTORY.put(`mode:${chatId}`, mode);
  } catch (_) {}
}

export function planModeBanner() {
  return "mode plan aktif: kamu hanya boleh observasi pakai tool baca " +
    "(baca file, list direktori, grep, search, web, recall). " +
    "DILARANG memanggil tool tulis/eksekusi (create/update/delete file, branch, pr, merge, runCommand, remember, trello tulis, reminder, workflow). " +
    "sampaikan hasil analisismu, lalu akhiri dengan tawaran: ketik /build buat eksekusi.";
}
