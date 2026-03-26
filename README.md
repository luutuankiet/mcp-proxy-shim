# @luutuankiet/mcp-proxy-shim

**MCP shim for [mcpproxy-go](https://github.com/smart-mcp-proxy/mcpproxy-go)** — eliminates `args_json` string escaping overhead for LLM clients. Supports **stdio** and **HTTP Streamable** transports.

## The Problem

mcpproxy-go's `/mcp/call` mode uses **generic dispatcher tools** (`call_tool_read`, `call_tool_write`, `call_tool_destructive`) that accept arguments as `args_json: string` — a pre-serialized JSON string. This is a sound design choice (one schema covers any upstream tool), but it creates real pain for LLM consumers:

### Before (what the LLM must produce)

```json
{
  "name": "call_tool_read",
  "arguments": {
    "name": "myserver:read_files",
    "args_json": "{\"files\":[{\"path\":\"src/index.ts\",\"head\":20}]}"
  }
}
```

The LLM must escape every quote, every nested object, every bracket. For complex tool calls (file edits with match_text containing code), this becomes:

```json
"args_json": "{\"files\":[{\"path\":\"src/app.ts\",\"edits\":[{\"match_text\":\"function hello() {\\n  return \\\\\"world\\\\\";\\n}\",\"new_string\":\"function hello() {\\n  return \\\\\"universe\\\\\";\\n}\"}]}]}"
```

This is **~400 tokens of overhead per call**, and LLMs frequently produce malformed payloads (mismatched escaping, missing backslashes).

### After (with the shim)

```json
{
  "name": "call_tool_read",
  "arguments": {
    "name": "myserver:read_files",
    "args": {
      "files": [{"path": "src/index.ts", "head": 20}]
    }
  }
}
```

Native JSON. No escaping. ~50 tokens. Zero malformed payloads.

### Impact at Scale

| Metric | Without shim | With shim | Savings |
|--------|-------------|-----------|---------|
| Tokens per call | ~400 | ~50 | **87%** |
| 30-call session overhead | ~12,000 tokens | ~1,500 tokens | **10,500 tokens saved** |
| Escaping bugs | Frequent | Zero | — |
| Edit operations (worst case) | ~500 tokens | ~200 tokens | **60%** |

## How It Works

```mermaid
sequenceDiagram
    participant Client as MCP Client<br/>Claude Code / Cursor / etc
    participant Shim as mcp-proxy-shim<br/>stdio or HTTP
    participant Proxy as mcpproxy-go<br/>StreamableHTTP

    Note over Client,Proxy: Connection Setup
    Client->>Shim: initialize (stdio or HTTP)
    Shim->>Proxy: initialize (HTTP)
    Proxy-->>Shim: capabilities + session ID
    Shim-->>Client: capabilities

    Note over Client,Proxy: Tool Discovery
    Client->>Shim: tools/list
    Shim->>Proxy: tools/list
    Proxy-->>Shim: tools with args_json: string
    Note over Shim: Transform 3 schemas<br/>args_json:string → args:object<br/>All others: passthrough
    Shim-->>Client: tools with args: object

    Note over Client,Proxy: Tool Call (the magic)
    Client->>Shim: call_tool_read<br/>args: {files: [{path: "..."}]}
    Note over Shim: Serialize<br/>args_json = JSON.stringify(args)
    Shim->>Proxy: call_tool_read<br/>args_json: '{"files":[...]}'
    Proxy-->>Shim: file content
    Shim-->>Client: file content (passthrough)
```

### What Gets Transformed

Only 3 tools are transformed. **Everything else passes through unchanged:**

| Tool | Schema change | All other fields |
|------|--------------|-----------------|
| `call_tool_read` | `args_json: string` → `args: object` | Unchanged |
| `call_tool_write` | `args_json: string` → `args: object` | Unchanged |
| `call_tool_destructive` | `args_json: string` → `args: object` | Unchanged |
| `retrieve_tools` | — | Passthrough |
| `upstream_servers` | — | Passthrough |
| `code_execution` | — | Passthrough |
| `read_cache` | — | Passthrough |
| All others | — | Passthrough |

## Quick Start

### Option A: Stdio (local MCP client)

Add to your `.mcp.json` — no install needed, `npx` fetches on first run:

```json
{
  "mcpServers": {
    "proxy": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@luutuankiet/mcp-proxy-shim"],
      "env": {
        "MCP_URL": "https://your-proxy.example.com/mcp/?apikey=YOUR_KEY"
      }
    }
  }
}
```

Or run directly from the CLI:
```bash
MCP_URL="https://your-proxy/mcp/?apikey=KEY" npx @luutuankiet/mcp-proxy-shim
```

### Option B: HTTP Streamable Server (remote agents)

Run as an HTTP server that remote MCP clients connect to over the network:

```bash
MCP_URL="https://upstream-proxy/mcp/?apikey=KEY" \
  MCP_APIKEY="my-secret" \
  npx @luutuankiet/mcp-proxy-shim serve
```

Then point your remote MCP client at:
```
http://localhost:3000/mcp?apikey=my-secret
```

#### Production deployment with Docker

```yaml
# docker-compose.yml
services:
  mcp-shim:
    image: node:22-slim
    command: npx -y @luutuankiet/mcp-proxy-shim serve
    environment:
      - MCP_URL=http://mcpproxy:9997/mcp/?apikey=admin
      - MCP_PORT=3000
      - MCP_HOST=0.0.0.0
      - MCP_APIKEY=your-secret-key
    ports:
      - "3000:3000"
```

Put a reverse proxy (Caddy/nginx/Traefik) in front for TLS:
```
https://shim.yourdomain.com/mcp?apikey=KEY  →  http://localhost:3000/mcp
```

#### HTTP Server Architecture

```mermaid
sequenceDiagram
    participant Agent as Remote Agent
    participant Shim as mcp-proxy-shim<br/>HTTP :3000
    participant Proxy as mcpproxy-go<br/>upstream

    Note over Agent,Shim: Authentication
    Agent->>Shim: POST /mcp?apikey=KEY
    alt apikey invalid or missing
        Shim-->>Agent: 401 Unauthorized
    else apikey valid
        Note over Shim: Create session transport
        Shim->>Proxy: initialize shared upstream
        Proxy-->>Shim: session ID
        Shim-->>Agent: MCP session + Mcp-Session-Id header
    end

    Note over Agent,Shim: Subsequent requests
    Agent->>Shim: POST /mcp?apikey=KEY<br/>Mcp-Session-Id: abc-123
    Shim->>Proxy: tool call shared session
    Proxy-->>Shim: result
    Shim-->>Agent: result

    Note over Shim: Multiple agents share<br/>one upstream connection
```

Each downstream client gets its own MCP session, but all sessions **share a single upstream connection** to mcpproxy-go. This is efficient — one upstream session, many downstream clients.

**Endpoints:**

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/mcp` | POST | `?apikey=` | MCP JSON-RPC (initialize, tool calls) |
| `/mcp` | GET | `?apikey=` | SSE stream reconnection |
| `/mcp` | DELETE | `?apikey=` | Session termination |
| `/health` | GET | None | Health check (session count, uptime) |

### Option C: Daemon Mode (multi-server MCP gateway)

Run a standalone gateway that connects to **multiple** MCP servers (stdio or HTTP) and exposes all their tools through a single HTTP endpoint. Pure passthrough — no schema transformation.

**Use case:** Cloud agents (claude.ai/code, Codespaces, etc.) that can't spawn MCP servers on the fly.

```
Cloud Agent ──HTTP──▶ daemon (:3456) ──┬── stdio ──▶ github MCP
                                       ├── stdio ──▶ filesystem MCP
                                       └── HTTP  ──▶ remote API (with auth headers)
```

#### Inline config

```bash
MCP_SERVERS='{
  "github": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "ghp_..." }
  },
  "my-api": {
    "type": "streamableHttp",
    "url": "https://api.example.com/mcp",
    "headers": { "Authorization": "Bearer xxx", "X-Org-Id": "org_123" }
  }
}' npx @luutuankiet/mcp-proxy-shim daemon
```

#### Config file

```bash
MCP_CONFIG=./mcp-servers.json npx @luutuankiet/mcp-proxy-shim daemon
```

The config file supports three formats:
- Flat: `{ "server-name": { "type": "stdio", ... } }`
- Wrapped: `{ "servers": { "server-name": { ... } } }`
- `.mcp.json` format: `{ "mcpServers": { "server-name": { ... } } }`

#### How clients use it

All upstream tools are **namespaced** with the server name as prefix:

```
github__get_file_contents    ← from the "github" server
my-api__query                ← from the "my-api" server
```

A built-in `daemon_help` tool provides a full usage guide:

```json
{ "name": "daemon_help", "arguments": {} }
```

Returns connected servers, all tools with namespaced names, and calling examples. You can also filter to a specific server for full schemas:

```json
{ "name": "daemon_help", "arguments": { "server": "github" } }
```

The daemon also returns `instructions` in the MCP `initialize` response, so MCP clients that support server instructions will automatically know how to use it.

#### Server config reference

**Stdio servers** (spawn a local process):

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "ghp_..." },
  "cwd": "/optional/working/directory"
}
```

**HTTP Streamable servers** (connect to remote MCP):

```json
{
  "type": "streamableHttp",
  "url": "https://api.example.com/mcp",
  "headers": {
    "Authorization": "Bearer your-token",
    "X-Custom-Header": "value"
  }
}
```

The `headers` field supports any custom HTTP headers — useful for authentication, org routing, or API versioning.

#### Daemon environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SERVERS` | — | JSON string with server configs (inline) |
| `MCP_CONFIG` | — | Path to JSON config file (alternative to MCP_SERVERS) |
| `MCP_PORT` | `3456` | Port to listen on |
| `MCP_HOST` | `0.0.0.0` | Host to bind to |
| `MCP_APIKEY` | — (open) | Require `?apikey=KEY` on `/mcp` requests |
| `https_proxy` | — | HTTPS proxy for HTTP upstream connections |

#### Daemon endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC (initialize, tools/list, tools/call) |
| `/mcp` | GET | SSE stream reconnection |
| `/mcp` | DELETE | Session termination |
| `/health` | GET | Per-server status, tool counts, uptime |

#### Production deployment

```yaml
# docker-compose.yml
services:
  mcp-daemon:
    image: node:22-slim
    command: npx -y @luutuankiet/mcp-proxy-shim daemon
    environment:
      - MCP_CONFIG=/config/servers.json
      - MCP_APIKEY=your-secret
    ports:
      - "3456:3456"
    volumes:
      - ./mcp-servers.json:/config/servers.json:ro
```

---

## Why Not `/mcp/all`?

mcpproxy-go exposes two routing modes:

```mermaid
flowchart LR
    subgraph direct["/mcp/all - direct mode"]
        A1[Client] --> B1[myserver__read_files<br/>native schema]
        A1 --> C1[myserver__edit_files<br/>native schema]
        A1 --> D1[github__get_user<br/>native schema]
    end

    subgraph call["/mcp/call - retrieve_tools mode"]
        A2[Client] --> B2[retrieve_tools<br/>BM25 search]
        A2 --> C2[call_tool_read<br/>generic dispatcher]
        A2 --> D2[upstream_servers<br/>add/remove/patch]
    end
```

**`/mcp/all`** gives each tool its native schema (no `args_json`), but **freezes the tool list at connect time**. Add a server? You must reconnect.

**`/mcp/call`** supports **dynamic server management** — add a YNAB server, a BigQuery connector, or a GitHub integration, and `retrieve_tools` discovers the new tools instantly. No reconnect.

We tested this live: added a YNAB financial tool mid-session → 43 new tools appeared immediately via `retrieve_tools`. The shim preserves this dynamic behavior while eliminating escaping overhead.

## Real-World Example: Dynamic Tool Discovery

```bash
# 1. User adds YNAB server to mcpproxy-go (via UI or API)

# 2. Client discovers new tools (no reconnect!)
# retrieve_tools("ynab accounts balance")
# => [ynab__getAccounts, ynab__getTransactions, ynab__getPlans, ...]

# 3. Client calls with native args (shim handles serialization)
# call_tool_read {
#     name: "utils:ynab__getAccounts",
#     args: { plan_id: "abc-123" }  // native object, not escaped string
#   }
# => [{ name: "Checking", balance: 1500000, ... }]
```

## Configuration

| Environment variable | Default | Transport | Description |
|---------------------|---------|-----------|-------------|
| `MCP_URL` | **(required)** | Both | mcpproxy-go StreamableHTTP endpoint |
| `MCP_PORT` | `3000` | HTTP only | Port to listen on |
| `MCP_HOST` | `0.0.0.0` | HTTP only | Host to bind to |
| `MCP_APIKEY` | — (open) | HTTP only | API key for downstream clients. When set, requests must include `?apikey=KEY`. Unset = no auth. |
| `https_proxy` / `HTTPS_PROXY` | — | Both | HTTPS proxy (auto-detected via undici ProxyAgent) |

## Architecture Details

### Transport Modes

| Feature | Stdio | HTTP Streamable (`serve`) | Daemon (`daemon`) |
|---------|-------|--------------------------|-------------------|
| Use case | Local MCP client (Claude Code, Cursor) | Remote agents, single upstream | Cloud agents, multi-server gateway |
| Connection | stdin/stdout | HTTP on `/mcp` | HTTP on `/mcp` |
| Upstreams | Single (mcpproxy-go) | Single (mcpproxy-go) | Multiple (stdio + HTTP) |
| Schema transforms | `args_json` → `args` | `args_json` → `args` | None (pure passthrough) |
| Auth | N/A (local process) | Optional `?apikey=` | Optional `?apikey=` |
| Multi-client | Single | Multiple sessions | Multiple sessions |
| Custom headers | N/A | N/A | Per-upstream `headers` config |

### Session Management

- Initializes upstream MCP session on startup via `initialize` + `notifications/initialized`
- Auto-reinitializes on session expiry (e.g., upstream restart, 405 responses)
- Retries transient failures with exponential backoff (1s, 2s, max 2 retries)
- Refreshes tool list on every `tools/list` request (upstream servers may have changed)
- HTTP mode: each downstream client gets its own `Mcp-Session-Id`, all sharing one upstream session

### Backward Compatibility

If a caller sends `args_json` directly (old style), the shim **passes it through unchanged**. You can migrate gradually — no breaking changes.

```json
{ "args": { "files": [...] } }         // new: native object (shim serializes)
{ "args_json": "{\"files\":[...]}" }    // old: pre-serialized (shim passes through)
```

### HTTPS Proxy Support

Node.js's built-in `fetch` does **not** honor `https_proxy` environment variables. The shim uses [undici](https://github.com/nodejs/undici)'s `ProxyAgent` to automatically route through HTTPS proxies when detected. This makes it work in cloud sandboxes (e.g., claude.ai/code) where HTTPS is routed through envoy sidecars.

### SSE Support

StreamableHTTP responses may arrive as either `application/json` or `text/event-stream` (SSE). The shim detects the content type and handles both transparently.

### SDK Bugs Worked Around

| Bug | Impact | Workaround in shim |
|-----|--------|------------|
| [typescript-sdk #893](https://github.com/modelcontextprotocol/typescript-sdk/issues/893) | `McpServer.registerTool()` breaks dynamic tool registration after client connects | Uses low-level `Server` class with `setRequestHandler()` |
| [typescript-sdk #396](https://github.com/modelcontextprotocol/typescript-sdk/issues/396) | `StreamableHTTPClientTransport` 2nd `callTool` times out due to broken session multiplexing | Uses plain `fetch` for upstream connection (no SDK client) |
| [claude-code #13646](https://github.com/anthropics/claude-code/issues/13646) | Client ignores `notifications/tools/list_changed` | Refreshes tools on each `tools/list` request instead of relying on notifications |

## Development

```bash
git clone https://github.com/luutuankiet/mcp-proxy-shim
cd mcp-proxy-shim
npm install
npm run build
npm start             # stdio mode (connects upstream, waits for stdio)
npm run start:http    # HTTP serve mode
node dist/index.js daemon  # daemon mode (set MCP_SERVERS or MCP_CONFIG)
```

### Testing

```bash
# Stdio mode — send MCP JSON-RPC over stdin:
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}' \
  | MCP_URL="https://your-proxy/mcp/?apikey=KEY" node dist/index.js

# HTTP mode — start server, then test with curl:
MCP_URL="https://your-proxy/mcp/?apikey=KEY" MCP_APIKEY="test" node dist/index.js serve

# In another terminal:
curl http://localhost:3000/health
curl -X POST http://localhost:3000/mcp?apikey=test \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'
```

Logs go to stderr (stdout is the stdio transport):
```
[mcp-shim] Upstream: https://your-proxy.example.com/mcp/?apikey=KEY
[mcp-shim] Initializing upstream session...
[mcp-shim] Session ID: mcp-session-...
[mcp-shim] Fetched 10 upstream tools
[mcp-shim] Ready: 10 tools (3 with schema transform)
[mcp-shim] Stdio transport connected — shim is live
```

## Contributing

The ideal long-term fix is native `args: object` support in mcpproxy-go's `/mcp/call` mode. This shim is a client-side workaround until that lands. If you're a mcpproxy-go maintainer interested in this, see:

- **Why args_json is a string:** `internal/server/mcp.go` — generic dispatchers need a static schema that accepts any upstream tool's arguments
- **Possible server-side fix:** Accept both `args_json: string` and `args: object` in the same schema, with `args` taking precedence when present

## License

MIT
