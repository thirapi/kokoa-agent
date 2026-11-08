# Arsitektur Kokoa Agent

## 1. Tiga runtime, satu pintu masuk

| Runtime | Peran | Batas |
|---|---|---|
| **Cloudflare Worker** (`src/index.js`) | Pintu masuk webhook Telegram, D1/KV, lock per chat, cron (reminder + polling Spaces), proxy AI/Telegram untuk Spaces, **dan agent loop untuk pesan umum** | ~23 detik per loop |
| **Vercel** (`api/agent.js`) | Agent loop untuk tugas repo/kode & tugas panjang. Egress bebas (Telegram, AI, GitHub, Worker — diukur 5/5). Aktif bila Worker punya `VERCEL_AGENT_URL` | 300 detik per function (loop 270 detik) |
| **HF Spaces** (`src/agent-server.js`) | Agent loop untuk tugas repo/kode: shell (`runCommand`), clone repo, baca file lokal | 240 detik per loop, Space bisa tidur/restart |
| **GitHub Actions** (`.github/workflows/kokoa-dev.yml`) | Tugas berat: implementasi fitur + commit + PR, analisis repo besar | 30 menit per run |

## 2. Routing pesan (`src/agent/route.js`)

```
Telegram ──► Worker (webhook: verifikasi secret, allowlist, dedupe, rate limit, lock)
               │
               ├─ pesan umum (ngobrol, cari info, reminder) ──► agent loop di Worker
               │        └─ timeout & belum ada tool yang mengubah state ──► ulang di Spaces
               │
               └─ tugas repo/kode (atau lanjutan dari topik repo) ──► Vercel (api/agent.js)
                        │    └─ hasil ──► POST Worker /api/agent-result ──► Telegram + D1
                        ├─ Vercel gagal ──► HF Spaces (cadangan)
                        ├─ keduanya gagal ──► fallback agent loop di Worker
                        └─ butuh commit/PR/kerja berat ──► triggerDeveloperWorkflow ──► GitHub Actions
```

- Worker dulu: jalur Spaces menambah hop (Worker → HF → proxy → Worker → Telegram) dan rentan TLS reset NAT HF.
- Aksi tidak pernah diulang otomatis setelah ada tool tulis (issue/file/reminder) supaya tidak dobel.

## 3. Hasil dari Spaces kembali ke user

Hasil ukur (`docs/research/hf-egress-probe.md`): dari HF, host AI & GitHub lancar langsung,
`api.telegram.org` diblokir, dan `*.workers.dev` hanya lolos ~1 koneksi per jendela waktu.

1. Spaces memanggil Gemini/Groq/OpenRouter/GitHub **langsung** (Worker `/api/ai-proxy` hanya cadangan).
2. Spaces membuat **satu** panggilan ke Worker: `POST /api/telegram-proxy/sendMessage` untuk jawaban akhir.
3. Worker mem-polling `GET /api/result/:chatId` (30 detik pertama), lalu cron tiap menit: simpan riwayat,
   kirim jawaban kalau langkah 2 gagal, atau kerjakan ulang di Worker kalau Spaces gagal karena jaringan.

## 4. Keamanan

- **Semua** endpoint internal (`/api/*` di Worker selain `/api/health`, dan `/api/*` di Spaces) wajib `Authorization: Bearer $RUNNER_SECRET`. Tanpa `RUNNER_SECRET` (min 16 karakter) semuanya ditolak (fail-closed).
- Webhook Telegram diverifikasi dengan header `X-Telegram-Bot-Api-Secret-Token` bila `TELEGRAM_WEBHOOK_SECRET` diset, plus allowlist `ALLOWED_USER_ID`.
- Perintah shell buatan model (`runCommand` di Spaces & runner GHA) dijalankan dengan env tanpa variabel `*_TOKEN/*_KEY(S)/*_SECRET/*_PAT`.

## 5. Biaya (semua free tier)

- **Cloudflare Workers**: 100.000 request/hari; cron 1×/menit ≈ 1.440 invocation/hari.
- **HF Spaces**: CPU Basic gratis; tidur setelah idle lama.
- **GitHub Actions**: repo publik → menit runner standar gratis tanpa batas (batas 2.000 menit/bulan hanya untuk repo privat).
- **Gemini / Groq / OpenRouter**: free tier, rotasi key & failover otomatis.
