FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.14.0-bookworm-slim
ENV NODE_ENV=production PORT=8765 HOST=0.0.0.0 AGENTWIRE_DB=/data/agentwire.db
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:8765/healthz',{headers:{Host:new URL(process.env.AGENTWIRE_PUBLIC_URL).host}},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"
CMD ["node", "dist/main.js"]
