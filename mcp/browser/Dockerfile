FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

RUN npm i -g supergateway

COPY server.mjs ./

EXPOSE 8007

CMD ["sh", "-lc", "supergateway --stdio 'node /app/server.mjs' --outputTransport streamableHttp --stateful --sessionTimeout 1800000 --port 8007 --streamableHttpPath /mcp --logLevel none"]
