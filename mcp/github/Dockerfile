FROM node:20-alpine

WORKDIR /app

RUN npm i -g supergateway

# We'll run the GitHub MCP server as a sibling container and connect to it via stdio is not possible,
# so we will instead run the GitHub MCP server in THIS container.
# That requires the github-mcp-server binary to exist here.
#
# We'll install it by downloading a release artifact or building from source.
# The official repo provides installation guides; simplest reliable approach is build from source.
RUN apk add --no-cache git go

RUN git clone https://github.com/github/github-mcp-server.git /src && \
    cd /src && \
    go build -o /usr/local/bin/github-mcp-server ./cmd/github-mcp-server

EXPOSE 8006

CMD ["sh", "-lc", "supergateway --stdio 'github-mcp-server stdio' --port 8006"]
