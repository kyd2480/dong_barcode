FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./

ENV PORT=3000
ENV CCTV_STORAGE_DIR=/app/data
EXPOSE 3000
CMD ["npm", "start"]
