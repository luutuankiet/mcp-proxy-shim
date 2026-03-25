# Test Harness — HTTP-to-Stdio Bridge for MCP Shim Testing

## Problem

Claude Code cloud sessions cannot add MCP servers on the fly.
The shim speaks MCP JSON-RPC over stdio, which means you can't
interact with it directly from Bash. This harness bridges that gap.

## Architecture

```
curl (Bash tool)
      |  HTTP POST
      v
  test/harness.mjs        (Node HTTP server on localhost:3456)
      |  JSON-RPC over stdin/stdout
      v
  dist/index.js            (the mcp-proxy-shim, stdio mode)
      |  HTTP to upstream
      v
  mcpproxy-go              (remote MCP proxy)
```

The harness does NO extra serialization — it forwards args exactly as
a real MCP client would send them. This is critical for reproducing
issue #1's serialization bugs.

## Quick Start

### 1. Build the shim

```bash
npm install && npm run build
```

### 2. Start the harness as a background daemon

```bash
# MCP_URL must include the full URL with apikey
https_proxy= HTTPS_PROXY= MCP_URL="$MCP_URL" node test/harness.mjs &
```

Wait for `[harness] Listening on http://127.0.0.1:3456` on stderr.

### 3. Use from Bash tool

```bash
# Health check
curl -s http://localhost:3456/health | jq .

# List all tools (through the shim's schema transformation)
curl -s -X POST http://localhost:3456/tools/list | jq '.tools | length'

# Search for tools (uses shim's retrieve_tools + compaction)
curl -s http://localhost:3456/retrieve_tools \
  -d '{"query": "github get file contents"}' | jq .parsed

# Describe specific tools (tests the shim's describe_tools name resolution)
curl -s http://localhost:3456/describe_tools \
  -d '{"names": ["github__get_file_contents"]}' | jq .parsed

# Call a tool (args pass through shim's transformToolCallArgs)
curl -s http://localhost:3456/call -d '{
  "name": "call_tool_destructive",
  "arguments": {
    "name": "utils:github__get_me",
    "args": {}
  }
}' | jq .parsed

# Shutdown when done
curl -s -X POST http://localhost:3456/shutdown
```

## Reproducing Issue #1

### Bug 1: describe_tools name resolution

```bash
# Step 1: retrieve_tools finds the tool
curl -s http://localhost:3456/retrieve_tools \
  -d '{"query": "read files edit files"}' | jq '.parsed.tools[].name'

# Step 2: describe_tools fails with "not found" for some names
# Copy names from step 1 into this call:
curl -s http://localhost:3456/describe_tools \
  -d '{"names": ["NAME_FROM_STEP_1"]}' | jq '.parsed'
# Look for: {"name": "...", "error": "not found"}
```

The bug is in `src/core.ts` describe_tools handler — it splits the tool
name by `__` and only searches with the LAST segment, which is too generic.

### Bug 2: args_json double-serialization

```bash
# Test with pre-serialized string args (simulates what some MCP clients send)
curl -s http://localhost:3456/call -d '{
  "name": "call_tool_read",
  "arguments": {
    "name": "utils:github__get_me",
    "args": "{}"
  }
}' | jq .parsed
# If you see "Invalid args_json format" — bug reproduced
```

The bug is in `src/core.ts:transformToolCallArgs` — it always calls
`JSON.stringify(args)` even when args is already a string, producing
double-serialized `"\"{}\"".

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `MCP_URL` | (required) | Upstream mcpproxy-go URL with apikey |
| `HARNESS_PORT` | 3456 | HTTP port for the harness |
| `https_proxy` | | Unset this if your environment has a proxy that blocks direct HTTPS |

## Endpoints Reference

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Status, PID, uptime |
| POST | `/initialize` | — | (Re)initialize shim session |
| POST | `/tools/list` | — | List all tools with transformed schemas |
| POST | `/retrieve_tools` | `{query}` | BM25 search for tools |
| POST | `/describe_tools` | `{names: [...]}` | Full schema hydration |
| POST | `/call` | `{name, arguments}` | Call any tool through the shim |
| POST | `/jsonrpc` | `{method, params}` | Raw JSON-RPC passthrough |
| POST | `/shutdown` | — | Graceful shutdown |
