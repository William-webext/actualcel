FROM node:20-alpine

WORKDIR /app

# better-sqlite3 (dipendenza di @actual-app/api) è un modulo nativo: su Alpine
# non esiste un binario precompilato, va compilato da sorgente al volo.
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

RUN mkdir -p /data
VOLUME /data

EXPOSE 8730

CMD ["node", "server.js"]