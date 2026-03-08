FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends \
    openssl \
    ffmpeg \
    xvfb \
    x11vnc \
    chromium \
    ca-certificates \
    fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY openapi ./openapi
COPY src ./src
RUN npm run build

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push && node dist/server.js"]
