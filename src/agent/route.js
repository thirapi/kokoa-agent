// Memilih runtime untuk satu pesan: Cloudflare Worker (cepat, ~23 detik) atau
// HF Spaces (lambat start, 240 detik, punya shell + filesystem).
//
// Prinsip: Worker dulu. Spaces hanya untuk pesan yang memang butuh repo/kode/shell,
// karena jalur Spaces menambah hop jaringan (Worker -> HF -> proxy -> Worker -> Telegram)
// dan rentan TLS reset / Space tidur.

import { detectScope, hasRepoSignal } from "./scope.js";

export function chooseRuntime({ hasSpaces, userPrompt, historyTexts = [] }) {
  if (!hasSpaces) return "worker";
  const scope = detectScope(userPrompt || "", historyTexts);
  if (scope === "repo") return "spaces";
  if (scope === "continue") {
    // Lanjutan ("oke", "coba lagi") ikut runtime topik sebelumnya.
    return historyTexts.slice(-3).some(hasRepoSignal) ? "spaces" : "worker";
  }
  return "worker";
}

// Worker kehabisan waktu: boleh diulang di Spaces hanya kalau belum ada tool yang
// mengubah state (supaya issue/file/reminder tidak dibuat dua kali).
export function shouldRetryOnSpaces(err, hasSpaces) {
  return !!hasSpaces && err?.code === "EXECUTION_TIMEOUT" && err.stateMutated === false;
}
