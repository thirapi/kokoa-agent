---
title: tg-bot-cocoa
emoji: 🤖
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
---

# tg-bot-cocoa

AI processor untuk Telegram bot. Menerima request dari Cloudflare Worker, menjalankan agent loop dengan Gemini/Groq, dan mengembalikan hasil.

## Setup secret

Repo & Space ini publik, jadi **semua** secret hanya boleh lewat env.

`RUNNER_SECRET` (acak, min 16 karakter) cukup diset sekali di GitHub Secrets;
workflow deploy menyebarkannya otomatis ke Cloudflare Worker & HF Space:

```bash
gh secret set RUNNER_SECRET --body "$(openssl rand -hex 32)"
```

Opsional tapi disarankan, verifikasi webhook Telegram:

```bash
TG_SECRET=$(openssl rand -hex 32)
echo "$TG_SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url=https://tg-bot.thirapi.workers.dev/ -d secret_token="$TG_SECRET"
```

## Test

```bash
npm test
```

Deploy (`.github/workflows/deploy.yml`) hanya jalan kalau test lulus.
