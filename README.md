# Muse Proxy

A raw OpenAI-compatible API gateway and dashboard powered by [Meta AI](https://www.meta.ai/) through Playwright browser automation. It allows tools like Cursor, Cline, Windsurf, Void, or Qwen Code to communicate directly with Meta AI as a raw completions backend.

---

## How It Works

Muse Proxy spins up a local Express server that implements the OpenAI Chat Completions API (`/v1/chat/completions`, `/v1/models`). The gateway acts as a pass-through pipe, converting client requests into browser-automated turns on Meta AI's chat page and returning the streamed responses back to the client.

```
Client (Cursor/Cline)  ──OpenAI API──▶  Muse Proxy  ──Playwright──▶  Meta AI
                       ◀──SSE streaming──                              ◀──
```

---

## Features

* **Raw OpenAI-Compatible Endpoint**: Integrates seamlessly with any client configured for standard OpenAI custom models.
* **Apple-Style Dashboard**: A premium UI served at `http://localhost:8787` featuring live server metrics, session monitoring, API key creation/management, and quick-start instructions.
* **Always File Prompt Mode**: Resolves web text-input character limits by dynamically converting large prompts (system instructions + history) into `.md` files uploaded directly to the Meta AI browser session.
* **SSE Keep-Alives & Abort Signals**: Actively keeps client timeout timers reset using heartbeats, and instantly stops page automation if the client disconnects or aborts the request.
* **Dynamic Session Matching**: segregates concurrent subagents, memory dream tasks, and multiple client windows into isolated browser tabs.

---

## Prerequisites

* **Node.js**: v18 or later
* **Chromium**: Installed automatically via Playwright
* **Meta AI Account**: Logged in via the auth setup tool

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Open the login browser to authenticate with Meta AI
node src/cli.js authsetup
```

---

## CLI Commands

The gateway can be controlled via the command line or by executing the compiled binary `musespark.exe`.

### Server Control

* **`musespark start`**: Starts the API gateway and dashboard. Opens a desktop application window by default.
  * `--port <number>`: Specify a custom port (default: `8787`).
  * `--headless`: Run the server in background/CLI-only mode without opening the dashboard window.

```bash
# Start in headless mode on a custom port
node src/cli.js start --port 8787 --headless
```

### API Key Management

* **`musespark apicreate [--name "key"]`**: Generate a new API key.
* **`musespark apilist`**: List all registered API keys.
* **`musespark apidelete <id-or-prefix>`**: Delete an API key by its ID or prefix.

```bash
# Create a new API key for Cline
node src/cli.js apicreate --name "cline-key"
```

### Authentication

* **`musespark authsetup`**: Launch a browser window to log in to Meta AI.

---

## Architecture

```
src/
├── bridge-gateway.js          # Express server: OpenAI-compatible API + Dashboard API
├── dashboard.html             # Glassmorphism HTML dashboard interface
├── meta-worker.js             # Playwright automation wrapper for Meta AI page
├── agent-runner.js            # Autonomous ReAct loop for proxy-side tool execution
├── bridge-browser-manager.js  # Chromium browser instance manager
├── bridge-session-store.js    # Session persistence (bridge-sessions.json)
├── key-store.js               # API key persistence (keys.json)
├── auth-setup.js              # One-time login automation
├── cli.js                     # CLI parser and command router
├── mcp-server.js              # Exposes Meta AI via Model Context Protocol
└── log-utils.js               # Global JSON & Markdown session logger
```

---

## Configurations

The gateway reads configurations from environment variables or setting overrides:

* `MUSE_HOME`: Path to data directory (defaults to `~/.musespark`).
* `MUSE_MAX_PROMPT_CHARS`: Context length limit (default: `60000`).
* `MUSE_FILE_PROMPT_THRESHOLD`: Size in chars to trigger automatic file uploads (default: `25000`).
* `MUSE_RESPONSE_TIMEOUT_MS`: Timeout for Meta AI replies (default: `60000`).