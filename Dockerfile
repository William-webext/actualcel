FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

RUN mkdir -p /data
VOLUME /data

EXPOSE 8730

CMD ["node", "server.js"]
