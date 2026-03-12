FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

ENV PORT=8080

CMD ["npm", "start"]
