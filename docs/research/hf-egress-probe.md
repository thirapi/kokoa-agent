# Pengukuran Koneksi Keluar dari HF Spaces (2026-11-08)

Diukur dari Space `thirapi/tg-bot-cocoa` lewat `GET /health?probe=1`
(`src/utils/egress-probe.js`): 5 percobaan per tujuan, jeda 1,5 detik,
**koneksi TCP+TLS baru tiap percobaan** (`agent:false`).

| Tujuan | Run 1 | Run 2 | Median |
|---|---|---|---|
| generativelanguage.googleapis.com (Gemini) | 5/5 | 5/5 | ~25 ms |
| api.groq.com | 5/5 | 5/5 | ~100 ms |
| openrouter.ai | 5/5 | 5/5 | ~45 ms |
| api.github.com | 5/5 | 5/5 | ~15 ms |
| api.telegram.org | 0/5 timeout | 0/5 timeout | — |
| tg-bot.thirapi.workers.dev | 1/5 (`✓✗✗✗✗`, ECONNRESET) | 0/5 ECONNRESET | — |
| workers.dev → /api/ai-proxy → Gemini | 1/5 | 0/5 | — |

## Kesimpulan

1. **Host AI & GitHub TIDAK diblokir** dari HF — justru tercepat bila langsung.
2. **Telegram diblokir total** (konsisten dengan laporan forum HF & HuggingMes/HuggingClaw).
3. **`*.workers.dev` di-throttle/RST**: paling banyak 1 koneksi lolos per jendela waktu.
   Asumsi lama ("host AI diblokir, lewatkan via Worker") terbalik: proxy AI via Worker
   menghabiskan satu-satunya koneksi yang lolos, lalu semua panggilan Gemini berikutnya
   `fetch failed` → `GEMINI_RETRY_TRIGGER: Request Timeout`.

## Perubahan desain

- AI dihubungi langsung (`AI_EGRESS_MODE=direct`, default); Worker hanya cadangan.
- Spaces hanya membuat **satu** panggilan ke Worker per tugas (kirim jawaban akhir
  ke Telegram). Riwayat & fallback diurus Worker lewat polling (Worker → Space selalu lancar).
- Kalau satu panggilan itu pun gagal, Worker mengambil hasil (short-poll ≤30 detik,
  lalu cron tiap menit) dan mengirimnya sendiri.

## Bisakah HF saja tanpa Cloudflare?

Belum. Telegram keluar diblokir, jadi bot tetap butuh relay untuk *mengirim* pesan.
Webhook Telegram bisa masuk langsung ke Space (pola HuggingMes), dan balasan pendek
bisa ditaruh di body respons webhook, tapi tugas agent yang lama (puluhan detik)
tidak cocok dengan pola itu. Cloudflare Worker tetap jadi pintu Telegram.

Referensi: HuggingMes (Hermes Agent di HF) memakai pola yang sama — webhook masuk ke
Space, keluar ke Telegram/Google lewat Cloudflare Worker proxy + Worker cron keepalive.
