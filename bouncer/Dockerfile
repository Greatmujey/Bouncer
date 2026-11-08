# Experimental TESTNET backend only; no keys, journal or wallet setup is
# created during build or startup. Attach a persistent Railway volume and
# explicitly configure recovery-only mode before exposing it through Vercel.
FROM node:22-bookworm-slim
ENV NODE_ENV=production BOUNCER_NATIVE_MISSION_INGRESS=railway-proxy BOUNCER_NATIVE_MISSION_BIND=0.0.0.0
WORKDIR /app
# Kernel advisory locking lets an unclean restart enter recovery-only without
# silently replacing the retained journal. It is still a single-host fence.
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY agent ./agent
COPY shared ./shared
COPY services ./services
COPY packages ./packages
COPY scripts ./scripts
COPY web ./web
COPY web-src ./web-src
COPY walletconnect ./walletconnect
CMD ["node", "scripts/start-railway-native.mjs"]
