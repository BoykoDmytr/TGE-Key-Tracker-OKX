FROM node:20-alpine
WORKDIR /usr/src/app

# беремо package.json саме з crypto-tge-key-tracke
COPY crypto-tge-key-tracker/package.json ./package.json
# якщо маєш lock файл — краще теж копіювати
COPY crypto-tge-key-tracker/package-lock.json* ./

RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# копіюємо код воркера
COPY crypto-tge-key-tracker/src ./src

CMD ["npm", "start"]
