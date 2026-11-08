// Shared-secret auth antara Worker <-> HF Spaces <-> GitHub Actions runner.
// Secret WAJIB datang dari env (RUNNER_SECRET), tidak pernah di-hardcode:
// repo & Space ini publik, jadi nilai apa pun yang ada di kode = bocor.

const MIN_SECRET_LENGTH = 16;

export function getRunnerSecret(env) {
  const s = env?.RUNNER_SECRET;
  return typeof s === "string" && s.length >= MIN_SECRET_LENGTH ? s : null;
}

// Perbandingan waktu-konstan agar secret tidak bisa ditebak lewat timing.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Fail-closed: kalau RUNNER_SECRET belum diset, SEMUA request ditolak.
export function isAuthorizedHeader(authHeader, env) {
  const secret = getRunnerSecret(env);
  if (!secret) return false;
  return safeEqual(authHeader || "", `Bearer ${secret}`);
}

export function isAuthorizedRequest(request, env) {
  return isAuthorizedHeader(request.headers.get("Authorization"), env);
}

export function runnerAuthHeaders(env, extra = {}) {
  const secret = getRunnerSecret(env);
  if (!secret) throw new Error("RUNNER_SECRET belum diset (min 16 karakter)");
  return { ...extra, Authorization: `Bearer ${secret}` };
}

// Verifikasi header X-Telegram-Bot-Api-Secret-Token (diset lewat setWebhook secret_token).
// Kalau TELEGRAM_WEBHOOK_SECRET belum diset, verifikasi dilewati (kompatibel mundur)
// — allowlist ALLOWED_USER_ID tetap berlaku.
export function isValidTelegramWebhook(request, env) {
  const expected = env?.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true;
  return safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", expected);
}
