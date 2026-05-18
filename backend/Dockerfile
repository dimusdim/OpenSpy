FROM node:20-bookworm

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3055

CMD ["npx", "ts-node", "src/index.ts"]
