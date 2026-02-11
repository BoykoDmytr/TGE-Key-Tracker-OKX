# -------- build stage --------
FROM node:20-alpine AS build
WORKDIR /app

# deps
COPY package.json package-lock.json ./
RUN npm ci

# source
COPY tsconfig.json ./
COPY src ./src

# build -> dist
RUN npm run build


# -------- runtime stage --------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# only prod deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# compiled output
COPY --from=build /app/dist ./dist

# (optional) if you need any runtime assets/config files, copy them too:
# COPY --from=build /app/somefile ./somefile

EXPOSE 3000
CMD ["node", "dist/server.js"]
