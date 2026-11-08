FROM node:20-slim

WORKDIR /app

# git dibutuhkan tool cloneRepo; dipasang saat build, bukan saat container start.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 7860

ENV PORT=7860
# cloudflare-proxy.js di-import langsung (line pertama) di src/agent-server.js.
# Jangan pakai NODE_OPTIONS="--require" untuk file ESM: tidak kompatibel Node 20
# (ERR_REQUIRE_ESM) dan import eksplisit dijalankan sebelum request pertama.
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

CMD ["node", "src/agent-server.js"]
