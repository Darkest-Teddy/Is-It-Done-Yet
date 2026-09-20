# Two stages so the runtime image carries production dependencies only. The dev dependency that
# matters here is mongodb-memory-server, which downloads a mongod binary on install -- shipping
# that inside an API image would roughly double it for something production must never run.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The `node` user ships with the image. Running as root inside a container buys nothing and
# means a process escape starts with root on the namespace.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
USER node

EXPOSE 3000

# Uses the app's own /api/health, which pings Mongo -- so an unreachable database reports as
# unhealthy rather than as a process that is up and serving 500s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
