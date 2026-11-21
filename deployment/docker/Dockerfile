# EMN Outreach OS — API + worker image (one image, two commands).
# Optional alternative to the systemd/PM2 install; the VPS install does not need Docker.
# Build from the project root:  docker build -f deployment/docker/Dockerfile -t emn-app .
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json prisma.config.ts tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund
COPY shared ./shared
COPY integrations ./integrations
COPY backend ./backend
COPY worker ./worker
COPY scripts ./scripts
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/* \
 && groupadd --system emn && useradd --system --gid emn --home /app emn
COPY --from=build /app/package.json /app/package-lock.json /app/prisma.config.ts /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/shared ./shared
COPY --from=build /app/backend ./backend
RUN mkdir -p /var/lib/emn/storage && chown -R emn:emn /var/lib/emn
USER emn
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/backend/src/main.js"]
