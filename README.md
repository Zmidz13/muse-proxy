# Muse Proxy

A local gateway that bridges [Meta AI](https://www.meta.ai/) to [Void IDE](https://voideditor.com/) via an OpenAI-compatible API endpoint.

## How It Works

Muse Proxy runs a local Express server that implements the OpenAI Chat Completions API (`/v1/chat/completions`, `/v1/models`). Void IDE (or any OpenAI-compatible client) connects to it, and the gateway translates between OpenAI-style tool calls and Meta AI's JSON format through Playwright browser automation.

```
Void IDE  ──OpenAI API──▶  Muse Proxy  ──Playwright──▶  Meta AI
          ◀──SSE streaming──                              ◀──
```

### Void Bridge Mode (`musespark startvoid`)

The primary mode for Void IDE integration. Acts as a **transparent proxy**:

- **Void IDE** sends its system prompt (with workspace info, file trees, open files) — the gateway passes it through **unchanged** to Meta AI
- **Meta AI** responds with JSON tool calls — the gateway converts them to OpenAI `tool_calls` SSE format for Void
- **Void IDE** executes the tool and sends the result — the gateway formats it back for Meta AI
- The loop continues until Meta AI signals `{"done":true,"message":"..."}` or an error occurs

### Agentic Gateway Mode (`musespark start`)

Runs the gateway with an internal agent loop. The gateway itself orchestrates multi-turn tool execution rather than relying on Void IDE's agent loop. Recommended for Void IDE.

### Bridge Mode (`musespark start2` / `musespark bridge`)

Pass-through mode that bridges Void IDE or OpenClaude directly to Meta AI with minimal translation.

### MCP Server Mode (`musespark start:mcp`)

Exposes Meta AI as an MCP (Model Context Protocol) server for other tools and agents.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Chromium](https://www.chromium.org/) (installed via Playwright)
- A [Meta AI](https://www.meta.ai/) account (authenticated via `musespark authsetup`)

## Setup

```bash
# Install dependencies
npm install

# Install Chromium for Playwright
npx playwright install chromium

# Authenticate with Meta AI (opens browser for login)
npx musespark authsetup
```

## CLI Commands

### Server Commands

| Command | Description |
|---------|-------------|
| `musespark start` | Start the agentic OpenAI-compatible gateway (recommended for Void IDE) |
| `musespark start1` | Alias for `start` |
| `musespark startvoid` | Start Void-native tool bridge — Void IDE executes the tools, gateway translates |
| `musespark start2` | Start bridge/pass-through gateway |
| `musespark bridge` | Alias for `start2` |

All server commands accept an optional `--port` flag (default: `8787`).

```bash
# Start on default port
musespark startvoid

# Start on a specific port
musespark startvoid --port 9000
```

### API Key Management

| Command | Description |
|---------|-------------|
| `musespark apicreate [--name "my-key"]` | Generate a new API key for the gateway |
| `musespark apilist` | List all registered API keys |
| `musespark apidelete <id-or-prefix>` | Delete an API key by its ID or prefix |

```bash
# Create an API key
musespark apicreate --name "void-ide"

# List keys
musespark apilist

# Delete a key
musespark apidelete abc123
```

### Authentication

| Command | Description |
|---------|-------------|
| `musespark authsetup` | Open a browser window to authenticate with Meta AI |

### Other

| Command | Description |
|---------|-------------|
| `musespark --version` | Show version |
| `musespark help` | Show help |

## Configuring Void IDE

In Void IDE, add an **OpenAI Compatible Provider** with these settings:

| Setting | Value |
|---------|-------|
| **Base URL** | `http://localhost:8788/v1` |
| **Model** | `gpt-4o` (any name recognized by Void's `specialToolFormat`) |
| **API Key** | Any key created via `musespark apicreate` |

> **Note:** The model name must be recognized by Void IDE's internal capabilities map. Using `gpt-4o` ensures `specialToolFormat: 'openai-style'` is set, which enables proper tool call parsing.

## Architecture

```
src/
├── openai-api.js              # Express server — OpenAI-compatible API endpoint
├── void-protocol-handler.js   # Bridge loop — manages Meta AI ↔ Void IDE communication
├── meta-worker.js             # Playwright automation — sends prompts, extracts responses
├── tool-call-converter.js     # Converts between JSON tool calls and OpenAI format
├── void-tools-schema.js       # Void IDE built-in tool definitions (OpenAI-style)
├── system-prompt.js           # Tool-format appendix (appended to Void's system message)
├── bridge-session-store.js    # Persists bridge sessions across HTTP requests
├── bridge-gateway.js          # Pass-through bridge gateway (start2/bridge mode)
├── bridge-browser-manager.js  # Browser lifecycle management for bridge mode
├── bridge-message-parser.js   # Parses Meta AI responses in bridge mode
├── bridge-utils.js            # Shared utilities for bridge mode
├── action-runner.js           # Tool execution engine for agentic mode
├── key-store.js               # API key management
├── auth-setup.js              # Meta AI authentication setup
├── cli.js                     # CLI entry point
├── mcp-server.js              # MCP protocol server
└── log-utils.js               # Logging utilities
```

## Known Issues

This project is in active development and has some rough edges:

- **Meta AI session management** — browser sessions can become stale over time; restarting the gateway may be necessary
- **Streaming reliability** — SSE streaming works for most tool call cycles, but edge cases with long responses or network hiccups may cause the bridge to desync
- **Windows paths** — Meta AI sometimes struggles with backslash-escaped Windows paths in JSON tool call parameters; the converter handles most cases but some edge paths may fail
- **Model name requirement** — Void IDE must be configured with a recognized model name (e.g., `gpt-4o`) to enable `openai-style` tool parsing; unrecognized model names fall back to XML parsing which is not supported
- **Rate limiting** — Meta AI may rate-limit or throttle automated interactions; the gateway retries automatically but extended sessions may hit limits

Contributions and bug reports are welcome — see [Contributing](#contributing) below.

## Contributing

This project is open source and contributions are very welcome. Whether it's fixing bugs, improving documentation, adding features, or refactoring — feel free to open an issue or submit a pull request.

Some areas that could use help:

- Better error handling and recovery for browser session failures
- More robust streaming for long-running tool call sequences
- Cross-platform path handling improvements
- Test coverage expansion
- Documentation and examples for non-Void clients

## License

MIT