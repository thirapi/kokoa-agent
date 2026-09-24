FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

EXPOSE 7860

ENV PORT=7860
ENV NODE_OPTIONS="--dns-result-order=ipv4first --require ./src/utils/cloudflare-proxy.js"

CMD ["node", "src/agent-server.js"]
