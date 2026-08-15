# opengame — single process serves WebSocket + static client on :2567.
# Zero-build: the client is ES modules + CDN importmaps; nothing to compile.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install deps from the lockfile (reproducible builds).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code: server + client modules + assets + index.html.
COPY index.html ./
COPY assets ./assets
COPY src ./src

# Run as an unprivileged user.
USER node

EXPOSE 2567

# Healthcheck hits the /healthz endpoint (busybox wget ships with alpine).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:2567/healthz | grep -q '"ok":true' || exit 1

CMD ["node", "src/server/index.js"]
