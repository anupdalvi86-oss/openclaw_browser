FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

COPY package.json ./
RUN npm install
RUN npx playwright install chromium

COPY server.js ./

ENV PORT=8080

CMD ["npm", "start"]
