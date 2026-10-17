FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/data \
    MAGICK_MEMORY_LIMIT=256MiB MAGICK_THREAD_LIMIT=1
# 사진첩 변환용 (아이폰 HEIC 읽기, WebP/JPEG 쓰기)
RUN apk add --no-cache imagemagick imagemagick-heic imagemagick-webp imagemagick-jpeg
COPY server ./server
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
