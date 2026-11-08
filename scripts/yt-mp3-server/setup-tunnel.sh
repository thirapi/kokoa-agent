#!/usr/bin/env bash
# Pasang Cloudflare named tunnel khusus konverter: https://<hostname> -> localhost:8787.
# Pakai: bash scripts/yt-mp3-server/setup-tunnel.sh mp3.domainmu.id
#
# - Tunnel terpisah ("yt-mp3") + config sendiri (~/.cloudflared/yt-mp3.yml), jadi
#   ~/.cloudflared/config.yml milikmu (tunnel lain) tidak disentuh.
# - cloudflared dijalankan sebagai container Docker dengan --restart unless-stopped.
# - Domain harus sudah ada di akun Cloudflare yang sama dengan `cloudflared tunnel login`.
set -euo pipefail

HOST="${1:?pakai: $0 <hostname>, mis. mp3.domainmu.id}"
NAME="${TUNNEL_NAME:-yt-mp3}"
DIR="$HOME/.cloudflared"
CFG="$DIR/$NAME.yml"

# Catatan: `cloudflared tunnel info <nama>` exit 0 walau tunnel tidak ada, jadi cek via daftar JSON.
tunnel_id() {
  cloudflared tunnel list -o json 2>/dev/null \
    | python3 -c "import json,sys; print(next((t['id'] for t in json.load(sys.stdin) if t['name']==sys.argv[1]), ''))" "$NAME"
}
ID=$(tunnel_id)
if [ -z "$ID" ]; then
  cloudflared tunnel create "$NAME"
  ID=$(tunnel_id)
fi
[ -n "$ID" ] || { echo "Gagal membuat tunnel $NAME" >&2; exit 1; }
[ -f "$DIR/$ID.json" ] || { echo "Kredensial $DIR/$ID.json tidak ada (tunnel dibuat di mesin lain?)" >&2; exit 1; }

cat > "$CFG" <<EOF
tunnel: $ID
credentials-file: /etc/cloudflared/$ID.json
ingress:
  - hostname: $HOST
    service: http://localhost:8787
  - service: http_status:404
EOF

# CNAME <hostname> -> <id>.cfargotunnel.com. --overwrite-dns kalau record sudah ada.
# --config wajib: tanpa itu cloudflared membaca ~/.cloudflared/config.yml dan memakai
# tunnel di sana (bukan $NAME).
# Login cloudflared (cert.pem) terikat ke SATU zona. Kalau $HOST ada di zona lain,
# cloudflared diam-diam membuat "<host>.<zona-login>" — itu dideteksi di sini.
OUT=$(cloudflared tunnel --config "$CFG" route dns --overwrite-dns "$NAME" "$HOST" 2>&1) || { echo "$OUT" >&2; exit 1; }
echo "$OUT" | grep -v WRN
if ! echo "$OUT" | grep -qE "CNAME $HOST( |$)|already configured to route to your tunnel"; then
  cat >&2 <<MSG

DNS untuk $HOST TIDAK dibuat di zona yang benar (lihat baris CNAME di atas; hapus record
salah itu di dashboard). Login cloudflared-mu terikat ke zona lain. Pilih salah satu:
  a) Domain di akun Cloudflare yang SAMA: dashboard > zona domainmu > DNS > Add record:
     CNAME  $(echo "$HOST" | cut -d. -f1)  ->  $ID.cfargotunnel.com  (Proxied)
  b) Domain di akun LAIN: buat tunnel dari dashboard Zero Trust akun itu
     (Networks > Tunnels > Create, public hostname $HOST -> http://localhost:8787), lalu
     docker run -d --name cloudflared-yt-mp3 --restart unless-stopped --network host \
       cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <TOKEN>
MSG
  exit 1
fi

docker rm -f "cloudflared-$NAME" >/dev/null 2>&1 || true
docker run -d --name "cloudflared-$NAME" --restart unless-stopped --network host \
  --user "$(id -u):$(id -g)" -v "$DIR:/etc/cloudflared:ro" \
  cloudflare/cloudflared:latest tunnel --no-autoupdate --config "/etc/cloudflared/$NAME.yml" run

echo "Selesai. Cek: curl https://$HOST/health  (DNS baru bisa butuh 1-2 menit)"
