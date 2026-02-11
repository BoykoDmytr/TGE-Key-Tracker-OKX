FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package.json package-lock.json* yarn.lock* ./
RUN npm install --omit=dev

COPY tsconfig.json .
COPY src ./src

RUN npm run build

EXPOSE 8080
CMD ["npm", "start"]