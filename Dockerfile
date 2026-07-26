FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./

RUN mkdir -p /data/thumbnails

ENV NODE_ENV=production
ENV PORT=3080

EXPOSE 3080

CMD ["node", "server.js"]
