# Image konverter YouTube -> MP3 pribadi (lihat README.md di folder ini).
FROM node:20-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg python3 ca-certificates curl \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.js .
ENV PORT=8787 CACHE_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "server.js"]
