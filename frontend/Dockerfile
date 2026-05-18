FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
COPY patches ./patches
RUN npm ci

COPY . .

EXPOSE 3737

CMD ["npm", "run", "dev"]
