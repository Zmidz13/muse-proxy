# MuseProxy

> **v0.2** — Raw OpenAI-compatible API gateway with browser automation backend.

Use any AI provider as a free backend for tools that support a custom OpenAI endpoint — Cursor, Cline, Windsurf, Void, Claude Code, Qwen Code, or any API client.

```
Client (Cursor / Cline / Claude Code)
        │  OpenAI API  ▼
    MuseProxy (localhost:8787)
        │  Playwright  ▼
      AI Provider (browser)
        │  response    ▲
```

---

## Features

- **OpenAI-compatible API** — drop-in replacement for any tool with a custom base URL setting
- **Dashboard UI** — live metrics, session monitor, API key manager at `http://localhost:8787`
- **Auto file-prompt mode** — prompts over 25 000 chars are automatically converted to `.md` and uploaded, bypassing text-input limits
- **SSE streaming + keep-alives** — heartbeat prevents client timeouts on long responses
- **Session isolation** — concurrent agents and subagents get their own browser tabs
- **MCP server** — expose the backend via Model Context Protocol (`museproxy start:mcp`)
- **No prompt wrapping** — client system instructions reach Meta AI unmodified

---

## Install

### Global (recommended)

```bash
npm install -g museproxy
```

Playwright Chromium is installed automatically on first `npm install`.

### From source

```bash
git clone https://github.com/Zmidz13/muse-proxy
cd muse-proxy
npm install
```

---

## Quick Start

```bash
# 1. Log in to Meta AI (one-time)
museproxy authsetup

# 2. Start the gateway
museproxy start
```

The dashboard opens at **http://localhost:8787**.  
Set your OpenAI base URL to `http://localhost:8787/v1` in your tool.

---

## CLI Reference

### Server

| Command | Description |
|---|---|
| `museproxy start` | Start gateway + open dashboard window |
| `museproxy start --headless` | Start in background (no window) |
| `museproxy start --port 9000` | Custom port (default: `8787`) |

### Auth

| Command | Description |
|---|---|
| `museproxy authsetup` | Open browser to log in (one-time setup) |

### API Keys

| Command | Description |
|---|---|
| `museproxy apicreate --name "my-key"` | Create a new API key |
| `museproxy apilist` | List all API keys |
| `museproxy apidelete <id-or-prefix>` | Delete an API key |

---

## Tool Configuration

Point any OpenAI-compatible tool at MuseProxy:

| Setting | Value |
|---|---|
| **Base URL** | `http://localhost:8787/v1` |
| **API Key** | any key created with `museproxy apicreate` |
| **Model** | `museproxy` (or `gpt-4o`, `gpt-4` — any model name is accepted) |

### Cursor / Windsurf / Cline

Settings → Models → Add custom model → paste the base URL above.

### Claude Code

```bash
ANTHROPIC_BASE_URL=http://localhost:8787/v1 claude
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MUSE_HOME` | `~/.musespark` | Data directory (sessions, keys) |
| `MUSE_FILE_PROMPT_THRESHOLD` | `25000` | Chars above which prompts are uploaded as `.md` |
| `MUSE_RESPONSE_TIMEOUT_MS` | `60000` | Timeout waiting for backend reply (ms) |
| `MUSE_READINESS_TIMEOUT_MS` | `15000` | Browser readiness probe timeout (ms) |
| `MUSE_DEBUG` | `0` | Set to `1` for verbose Playwright logs |

---

## Architecture

```
src/
├── cli.js                  CLI parser and command router
├── bridge-gateway.js       Express server — OpenAI API + Dashboard API
├── meta-worker.js          Playwright automation (browser backend)
├── agent-runner.js         ReAct agent loop for proxy-side tool execution
├── bridge-session-store.js Session persistence (~/.musespark/bridge-sessions.json)
├── key-store.js            API key store (~/.musespark/keys.json)
├── auth-setup.js           One-time login flow
├── mcp-server.js           Model Context Protocol server
├── log-utils.js            JSON + Markdown session logger
└── dashboard.html          Dashboard UI
```

---

## Known Issues

- The AI backend may occasionally respond conversationally instead of executing tool calls on follow-up turns — the proxy injects a forcing reminder automatically, but complex multi-step agents may still need a manual nudge.
- Headless mode requires a saved login session from `museproxy authsetup`. If the session expires, run authsetup again.
- Response extraction relies on DOM selectors that may break if the backend UI updates.

---

## Contributing

Pull requests welcome. Please keep changes scoped — one fix or feature per PR.

```bash
npm test   # runs gateway hardening tests
```

---

## License

MIT
