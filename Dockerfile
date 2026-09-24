FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

EXPOSE 7860

ENV PORT=7860
# cloudflare-proxy.js di-import langsung (line pertama) di src/agent-server.js.
# Jangan pakai NODE_OPTIONS="--require" untuk file ESM: tidak kompatibel Node 20
# (ERR_REQUIRE_ESM) dan import eksplisit dijalankan sebelum request pertama.
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

CMD ["node", "src/agent-server.js"]
