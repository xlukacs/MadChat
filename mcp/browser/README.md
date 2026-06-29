# MadChat Browser MCP

This MCP server exposes browser automation as one normal agent-facing tool:

- `browser_task`

The wrapper intentionally hides internal Playwright steps from chat so a browsing subtask appears as one tool call instead of a stream of navigate/click/type commands.

## Setup

```bash
cd mcp/browser
npm install
npm run install:browsers
```

Copy `.env.example` to `.env` for local development and set allowed origins.

## LibreChat config

```yaml
mcpServers:
  browser:
    type: streamable-http
    url: http://localhost:8007/mcp
    timeout: 600000
    chatMenu: true
```

The bundled Compose service runs this server in a Playwright container and publishes the MCP
endpoint on `localhost:8007/mcp`. When the LibreChat backend runs on the host, the browser
container calls it through `LIBRECHAT_API_BASE_URL=http://host.docker.internal:3080` so
credential/session lookups reach the same backend process that serves the UI.

## Security

- Set `BROWSER_ALLOWED_ORIGINS`; leaving it empty allows all origins.
- Do not place passwords in prompts.
- Agent settings store website credentials encrypted in LibreChat. Plaintext passwords are not returned by normal agent APIs.
- The MCP wrapper fetches decrypted agent credentials through an internal LibreChat endpoint protected by `BROWSER_INTERNAL_TOKEN`.

## Behavior

`browser_task` can:

- open a start URL,
- optionally perform a configured username/password login from the current agent's saved credentials,
- select saved credentials by `credentialId` or `credentialOrigin` without exposing passwords to the model,
- execute multiple Playwright-backed browser steps inside the same tool call,
- click, fill, press keys, wait, capture screenshots, and extract text,
- publish status and screenshots to LibreChat so the user can peek at the live browser session,
- return one consolidated result with the final URL, screenshot path, status, and extracted text.

Supported step actions are `goto`, `click`, `fill`, `press`, `wait`, `wait_for_selector`, `wait_for_load`, `extract_text`, and `screenshot`.
