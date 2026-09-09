FROM node:22-alpine AS builder

RUN npm install -g pnpm@10

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN pnpm run build

# Podar a solo dependencias de producción en el mismo stage
RUN pnpm prune --prod

# ── Runtime image (sin acceso a red) ─────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Copiar node_modules ya podados y el build compilado — sin descargar nada
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Non-root user for security
RUN addgroup -S proxy && adduser -S proxy -G proxy
USER proxy

EXPOSE 8080

CMD ["node", "dist/index.js"]
