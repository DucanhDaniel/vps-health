FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3100
# Gọi đúng địa chỉ dashboard đang nghe (IP Tailscale / 127.0.0.1 / 0.0.0.0)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- "http://${BIND_HOST:-127.0.0.1}:${PORT:-3100}/healthz" || exit 1
CMD ["node", "server.js"]
