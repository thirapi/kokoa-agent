// Helper jaringan untuk NAT HF Spaces yang suka me-RST koneksi TLS
// ("Client network socket disconnected before secure TLS connection...").
// Lihat docs/features.md §5.8 dan docs/research/huggingclaw-*.md.

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// True hanya untuk gagal koneksi yang CEPAT (RST/TLS/dll) — BUKAN timeout.
// Timeout (AbortError/ETIMEDOUT) sengaja dikecualikan: retry-nya bisa
// menggantung lama dan sudah ditangani rotasi provider di atasnya.
export function isTransientNetworkError(e) {
  const m = String(e?.message || e);
  return /socket disconnected|socket hang up|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network socket|secure TLS|SSL/i.test(m);
}

// Jalankan fn() hingga maxAttempts; HANYA error jaringan transient yang
// di-retry (backoff). Error lain (HTTP 4xx/5xx, timeout, dsb) langsung dilempar
// agar ditangani rotasi provider — bukan disembunyikan di sini.
export async function withNetworkRetry(fn, { attempts = 3, backoffMs = [2000, 5000] } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1 && isTransientNetworkError(e)) {
        console.warn(`[net] transient (${String(e.message || e).slice(0, 100)}), retry ${i + 1}/${attempts - 1}...`);
        await sleep(backoffMs[Math.min(i, backoffMs.length - 1)]);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// Teks pengganti JUJUR saat loop selesai tanpa teks penutup dari model.
// Versi lama ("tugasnya udah aku jalanin... harusnya kodenya udh ke-update")
// berbohong di dua arah: kadang tidak ada yang dikerjakan, kadang ada.
// Tiga status eksplisit berdasarkan filesModified dari runAgentLoop.
export function noFinalTextMessage(result = {}) {
  if (result.filesModified === true) {
    return "perubahan file udah aku lakuin, tapi teks penutupnya ga keluar dari sistem. coba cek repo/workspace kamu — harusnya udah ke-update. kalo ada yang kurang, tinggal bilang aja!";
  }
  if (result.filesModified === false) {
    return "loop-nya selesai tapi ga ada file yang berubah dan teks penutupnya ga keluar. coba jelasin lagi maumu apa, atau kirim ulang perintahnya ya!";
  }
  return "loop-nya selesai tapi teks penutupnya ga keluar dari sistem. coba cek dulu hasilnya, kalo ga sesuai bilang aja maumu apa!";
}
