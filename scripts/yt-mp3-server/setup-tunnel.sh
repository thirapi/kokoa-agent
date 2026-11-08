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

if ! cloudflared tunnel info "$NAME" >/dev/null 2>&1; then
  cloudflared tunnel create "$NAME"
fi
ID=$(cloudflared tunnel list -o json | python3 -c "import json,sys; print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'))")

cat > "$CFG" <<EOF
tunnel: $ID
credentials-file: /etc/cloudflared/$ID.json
ingress:
  - hostname: $HOST
    service: http://localhost:8787
  - service: http_status:404
EOF

# CNAME <hostname> -> <id>.cfargotunnel.com. --overwrite-dns kalau record sudah ada.
cloudflared tunnel route dns --overwrite-dns "$NAME" "$HOST"

docker rm -f "cloudflared-$NAME" >/dev/null 2>&1 || true
docker run -d --name "cloudflared-$NAME" --restart unless-stopped --network host \
  --user "$(id -u):$(id -g)" -v "$DIR:/etc/cloudflared:ro" \
  cloudflare/cloudflared:latest tunnel --no-autoupdate --config "/etc/cloudflared/$NAME.yml" run

echo "Selesai. Cek: curl https://$HOST/health  (DNS baru bisa butuh 1-2 menit)"
