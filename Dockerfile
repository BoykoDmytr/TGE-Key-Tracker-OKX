# --- build stage ---
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
# ставимо ВСЕ (включно з dev), бо нам треба tsc і типи
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
# у рантаймі dev не треба
RUN npm ci --omit=dev

# беремо зібраний dist з білд-стейджа
COPY --from=builder /app/dist ./dist

EXPOSE 8080
CMD ["npm", "start"]
