# yt-mp3-server — konverter YouTube → MP3 pribadi

Untuk belajar & dipakai sendiri (non-komersial). Menghormati hak cipta tetap tanggung jawabmu:
jangan dibuka untuk umum, jangan disebar ulang filenya.

## Cara kerja

```
user: "kirim mp3 lagu X"
  └─ bot memanggil tool youtubeMp3("X")
       1. cari video di YouTube (Innertube, tanpa key)
       2. buat URL bertanda tangan:  <MP3_CONVERTER_URL>/mp3?v=<id>&exp=<unix>&sig=<hmac>
       3. GET /prepare?...&wait=12  → server mulai yt-dlp + ffmpeg di background
  └─ bot memanggil sendAudio(mp3Url)
       Telegram mengunduh /mp3 dari server ini → file .mp3 muncul di chat
```

Kenapa tidak di Worker/Spaces? Worker & Vercel tidak punya `ffmpeg`/`yt-dlp`, dan YouTube
sering memblokir IP datacenter. Jalankan di mesin dengan IP rumahan.

## Menjalankan (permanen, Docker)

```bash
# 1. secret disimpan di luar repo
mkdir -p ~/.config/yt-mp3 && chmod 700 ~/.config/yt-mp3
(umask 077; echo "MP3_CONVERTER_SECRET=$(openssl rand -hex 24)" > ~/.config/yt-mp3/env)

# 2. konverter: hanya listen di 127.0.0.1, dari luar hanya lewat tunnel
docker build -t yt-mp3 scripts/yt-mp3-server
docker run -d --name yt-mp3 --restart unless-stopped -p 127.0.0.1:8787:8787 \
  --env-file ~/.config/yt-mp3/env -v yt-mp3-cache:/data yt-mp3

# 3. tunnel ke domainmu (sekali saja; butuh `cloudflared tunnel login` ke akun pemilik domain)
bash scripts/yt-mp3-server/setup-tunnel.sh mp3.domainmu.id
```

Tanpa Docker: `MP3_CONVERTER_SECRET=... node scripts/yt-mp3-server/server.js` (butuh `ffmpeg` + `yt-dlp`).

Untuk coba cepat tanpa domain: `cloudflared tunnel --config /dev/null --url http://localhost:8787`.
`--config /dev/null` penting kalau kamu punya `~/.cloudflared/config.yml`: ingress di sana
(mis. catch-all `http_status:404`) menimpa `--url`, hasilnya semua request 404.

## Pasang di bot

Simpan di GitHub Secrets; workflow deploy menyalinnya ke Worker setiap deploy, dan Worker
meneruskannya ke Vercel/Spaces per job.

```bash
gh secret set MP3_CONVERTER_URL --body "https://mp3.domainmu.id"
sed -n 's/^MP3_CONVERTER_SECRET=//p' ~/.config/yt-mp3/env | gh secret set MP3_CONVERTER_SECRET
# lalu push ke main (deploy.yml jalan saat push)
```

## Uji manual

```bash
curl localhost:8787/health
# buat URL bertanda tangan dari Node:
node -e '
const c=require("crypto");const v="dQw4w9WgXcQ",exp=Math.floor(Date.now()/1000)+3600;
const sig=c.createHmac("sha256",process.env.MP3_CONVERTER_SECRET).update(v+"."+exp).digest("base64url");
console.log(`http://localhost:8787/mp3?v=${v}&exp=${exp}&sig=${sig}`)'
curl -o test.mp3 "<url di atas>" && file test.mp3
```

## Env

| Nama | Default | Arti |
|---|---|---|
| `MP3_CONVERTER_SECRET` | – (wajib, ≥16 karakter) | kunci HMAC, sama dengan di Worker |
| `PORT` | 8787 | port HTTP |
| `CACHE_DIR` | `./mp3-cache` | tempat file mp3 |
| `MP3_BITRATE` | 128K | kualitas mp3 |
| `MAX_DURATION_SEC` | 1200 | Telegram membatasi file via URL 20 MB |
| `CACHE_HOURS` | 24 | umur cache |
| `MAX_JOBS` | 2 | konversi paralel |

Kalau muncul error "Sign in to confirm you're not a bot": update yt-dlp (`yt-dlp -U`) atau
jalankan dari jaringan rumahan, bukan VPS.
