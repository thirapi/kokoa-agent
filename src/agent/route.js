// Memilih runtime untuk satu pesan: Cloudflare Worker (cepat, ~23 detik) atau
// runtime jarak jauh "remote" (Vercel 270 detik, cadangan HF Spaces 240 detik).
//
// Prinsip: Worker dulu. Spaces hanya untuk pesan yang memang butuh repo/kode/shell,
// karena jalur Spaces menambah hop jaringan (Worker -> HF -> proxy -> Worker -> Telegram)
// dan rentan TLS reset / Space tidur.

import { detectScope, hasRepoSignal } from "./scope.js";

// Sapaan / basa-basi pendek tidak pernah butuh shell — walau topik sebelumnya repo.
const SMALL_TALK = /^(h+a+i+|h+a+l+o+|hel+o+|hi+|hey+|yo+|p+a+g+i+|siang|sore|mal[ae]m|met (pagi|siang|sore|malam)|makasih|terima kasih|thanks?|thx|tq|ok(e|ay)? makasih|(wk){2,}w?|(ha){2,}h?|(he){2,}h?|gws|selamat (pagi|siang|sore|malam))\b[\s!.?~]*\S{0,20}$/i;

export function isSmallTalk(text) {
  return SMALL_TALK.test(String(text || "").trim());
}

export function chooseRuntime({ hasRemote, userPrompt, historyTexts = [] }) {
  if (!hasRemote) return "worker";
  if (isSmallTalk(userPrompt)) return "worker";
  const scope = detectScope(userPrompt || "", historyTexts);
  if (scope === "repo") return "remote";
  if (scope === "continue") {
    // Lanjutan ("oke", "coba lagi") ikut runtime topik sebelumnya.
    return historyTexts.slice(-3).some(hasRepoSignal) ? "remote" : "worker";
  }
  return "worker";
}

// Error dari Spaces yang disebabkan jaringan/provider (bukan logika) — aman dicoba
// ulang di Worker, yang jalur keluarnya ke Google tidak lewat NAT HF.
export function isRetryableSpacesError(message) {
  return /request timeout|fetch failed|socket|ECONNRESET|ETIMEDOUT|TLS|network|\b503\b|UNAVAILABLE|high demand|aborted/i
    .test(String(message || ""));
}

// Worker kehabisan waktu: boleh diulang di Spaces hanya kalau belum ada tool yang
// mengubah state (supaya issue/file/reminder tidak dibuat dua kali).
export function shouldRetryRemote(err, hasRemote) {
  return !!hasRemote && err?.code === "EXECUTION_TIMEOUT" && err.stateMutated === false;
}
