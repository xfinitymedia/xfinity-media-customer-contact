FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY worker.js ./
COPY nas-indexer.js ./
COPY nas-file-access.js ./
COPY supervisor.js ./
CMD ["node","supervisor.js"]

