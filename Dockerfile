FROM oven/bun:1.3.14-alpine AS client-build

WORKDIR /app

COPY package.json bun.lock tsconfig.json components.json vite.config.ts ./
COPY src ./src

RUN bun install --frozen-lockfile \
  && bun run build:client

FROM oven/bun:1.3.14-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json tsconfig.json ./
COPY src ./src
COPY --from=client-build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/static-share-entrypoint

RUN mkdir -p /data/uploads \
  && chown -R bun:bun /app /data \
  && chmod +x /usr/local/bin/static-share-entrypoint

EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD bun -e "const port = process.env.PORT || '3000'; const response = await fetch('http://127.0.0.1:' + port + '/healthz'); process.exit(response.ok ? 0 : 1)"

ENTRYPOINT ["static-share-entrypoint"]
CMD ["bun", "run", "start"]
