FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:server && npm prune --omit=dev --ignore-scripts

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
  CMD node --input-type=module -e "import http from 'node:http';import {relayUrl} from './dist/url.js';const url=relayUrl(process.env.AGENTWIRE_PUBLIC_URL);http.get({hostname:'127.0.0.1',port:8765,path:new URL('healthz',url).pathname,headers:{Host:url.host}},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"
CMD ["node", "dist/main.js"]
