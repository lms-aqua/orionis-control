# syntax=docker/dockerfile:1
# --- build -------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Reinstall production dependencies only.
RUN npm ci --omit=dev --ignore-scripts

# --- runtime -----------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATABASE_URL=/data/orionis-control.db

# Run unprivileged; the image ships no shell tooling beyond the base.
RUN addgroup -S orionis && adduser -S orionis -G orionis \
    && mkdir -p /data && chown -R orionis:orionis /data

# Drop npm from the runtime image.
#
# The container runs `node dist/index.js` and health-checks with `node -e`; npm
# is never invoked. It is, however, the single largest source of vulnerability
# alerts against this image — npm vendors its own copies of undici, tar,
# ip-address and brace-expansion, and those carry CVEs on a schedule of their
# own, none of which this service is exposed to because nothing ever runs them.
# Removing it clears that noise for real rather than suppressing it, and takes
# a package manager out of a production container as a bonus.
#
# Migrations are unaffected: they run at boot, and the CLI is still reachable as
# `node dist/db/migrate-cli.js`.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm /usr/local/bin/npx \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=build --chown=orionis:orionis /app/node_modules ./node_modules
COPY --from=build --chown=orionis:orionis /app/dist ./dist
COPY --chown=orionis:orionis package.json ./

USER orionis
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
