# Muse Proxy

A local gateway that bridges [Meta AI](https://www.meta.ai/) to [Void IDE](https://voideditor.com/) via an OpenAI-compatible API endpoint.

## How It Works

Muse Proxy runs a local Express server that implements the OpenAI Chat Completions API (`/v1/chat/completions`, `/v1/models`). Void IDE connects to it as an "OpenAI Compatible Provider", and the gateway translates between Void's OpenAI-style tool calls and Meta AI's JSON tool call format through Playwright browser automation.

```
Void IDE  ──OpenAI API──▶  Muse Proxy  ──Playwright──▶  Meta AI
          ◀──SSE streaming──                              ◀──
```

### Bridge Mode (`musespark startvoid`)

The Void Bridge mode provides a transparent proxy:

- **Void IDE** sends its system prompt (with workspace info, file trees, open files) — the gateway passes it through **unchanged** to Meta AI
- **Meta AI** responds with JSON tool calls — the gateway converts them to OpenAI `tool_calls` SSE format for Void
- **Void IDE** executes the tool and sends the result — the gateway formats it back for Meta AI
- The loop continues until Meta AI signals `{"done":true,"message":"..."}` or an error occurs

### MCP Mode (`musespark start`)

Exposes Meta AI as an MCP (Model Context Protocol) server for other tools and agents.

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
# Start Void Bridge mode (connects to Void IDE)
npx musespark startvoid

# Start MCP server
npx musespark start

# Start as OpenAI-compatible API
npx musespark startgateway
```

Configure Void IDE's OpenAI Compatible Provider:
- **Base URL**: `http://localhost:8788/v1`
- **Model**: `gpt-4o` (or any model name recognized by Void's `specialToolFormat`)
- **API Key**: any key (the gateway manages authentication internally)

## Architecture

| File | Purpose |
|------|---------|
| `src/openai-api.js` | Express server — OpenAI-compatible API endpoint |
| `src/void-protocol-handler.js` | Bridge loop — manages Meta AI ↔ Void IDE communication |
| `src/meta-worker.js` | Playwright automation — sends prompts to Meta AI, extracts responses |
| `src/tool-call-converter.js` | Converts between JSON tool calls and OpenAI format |
| `src/void-tools-schema.js` | Void IDE built-in tool definitions (OpenAI-style) |
| `src/system-prompt.js` | Tool-format appendix (appended to Void's system message) |
| `src/bridge-session-store.js` | Persists bridge sessions across HTTP requests |
| `src/key-store.js` | API key management |
| `src/mcp-server.js` | MCP protocol server |

## License

MIT