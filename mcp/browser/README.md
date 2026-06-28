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
    type: stdio
    command: node
    args:
      - /app/mcp/browser/server.mjs
    timeout: 600000
    chatMenu: true
    env:
      BROWSER_ALLOWED_ORIGINS: "${BROWSER_ALLOWED_ORIGINS}"
      BROWSER_INTERNAL_TOKEN: "${BROWSER_INTERNAL_TOKEN}"
      BROWSER_HEADLESS: "${BROWSER_HEADLESS}"
      BROWSER_STORAGE_DIR: "${BROWSER_STORAGE_DIR}"
      LIBRECHAT_API_BASE_URL: "${LIBRECHAT_API_BASE_URL}"
      BROWSER_USER_ID: "{{LIBRECHAT_USER_ID}}"
```

## Security

- Set `BROWSER_ALLOWED_ORIGINS`; leaving it empty allows all origins.
- Do not place passwords in prompts.
- Agent settings store website credentials encrypted in LibreChat. Plaintext passwords are not returned by normal agent APIs.
- The MCP wrapper fetches decrypted agent credentials through an internal LibreChat endpoint protected by `BROWSER_INTERNAL_TOKEN`.

## Behavior

`browser_task` can:

- open a start URL,
- optionally perform a configured username/password login from the current agent's saved credentials,
- execute multiple Playwright-backed browser steps inside the same tool call,
- click, fill, press keys, wait, capture screenshots, and extract text,
- publish status and screenshots to LibreChat so the user can peek at the live browser session,
- return one consolidated result with the final URL, screenshot path, status, and extracted text.

Supported step actions are `goto`, `click`, `fill`, `press`, `wait`, `wait_for_selector`, `wait_for_load`, `extract_text`, and `screenshot`.
