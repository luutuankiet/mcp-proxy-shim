# Architecture

*Mapped: 2026-03-26*

## Project Structure Overview

| Directory/File | Purpose |
|----------------|---------|
| `src/index.ts` | Entry point — routes to stdio, serve, or daemon based on subcommand |
| `src/core.ts` | Shared core for stdio/serve modes: upstream session mgmt, schema transforms, describe_tools, response unwrapping |
| `src/stdio.ts` | Stdio transport — connects core to stdin/stdout |
| `src/http-server.ts` | HTTP Streamable server — multi-session, shared upstream |
| `src/daemon.ts` | Daemon mode — multi-server gateway, pure passthrough, no core.ts dependency |
| `test/harness.mjs` | HTTP→stdio bridge for testing (spawns shim, exposes REST API) |
| `test/repro-issues.mjs` | Reproduction script for Issue #1 |
| `gsd-lite/` | Project management artifacts |

## Tech Stack

- **Runtime:** Node.js >=20 (ESM)
- **Language:** TypeScript 5.7
- **MCP SDK:** `@modelcontextprotocol/sdk` ^1.12.1 (Server, Client, transports)
- **HTTP Client:** `undici` ^7.24 (ProxyAgent for HTTPS proxy support)
- **Transport:** stdio (default), HTTP Streamable (serve), HTTP Streamable (daemon)

## Data Flow

### Stdio / Serve modes (core.ts)

```
MCP Client → [stdio|HTTP] → core.ts shim → [HTTP] → mcpproxy-go upstream
                               │
                               ├── tools/list: fetch upstream, transform args_json→args schema
                               ├── tools/call (call_tool_*): serialize args→args_json, forward
                               ├── tools/call (describe_tools): live BM25 queries, name resolution
                               └── tools/call (retrieve_tools): passthrough + compact
```

Key transforms in core.ts:
- **Schema**: `args_json: string` → `args: object` (3 tools only)
- **Args**: `args: {obj}` → `args_json: JSON.stringify(obj)` (with strict validation)
- **Response**: Deep unwrap nested MCP content wrappers

### Daemon mode (daemon.ts)

```
Cloud Agent → [HTTP :3456] → daemon.ts → ┬── [stdio] → spawned MCP server A
                                         ├── [stdio] → spawned MCP server B
                                         └── [HTTP]  → remote MCP server C (+ custom headers)
```

Key behaviors:
- **Pure passthrough** — no schema transforms
- **Tool namespacing**: `serverName__toolName`
- **daemon_help** tool: built-in usage guide
- **Server instructions**: included in MCP initialize response

## Entry Points

| File | Start here to understand... |
|------|----------------------------|
| `src/core.ts:transformToolCallArgs()` | How args→args_json serialization works (Issue #2 fix) |
| `src/core.ts:createShimServer()` → `describe_tools` handler | How tool schema resolution works (Issue #1 fix) |
| `src/core.ts:transformToolSchema()` | What schema changes clients see |
| `src/daemon.ts:connectServer()` | How daemon connects to upstreams (stdio vs HTTP) |
| `src/daemon.ts:createDownstreamSession()` | How daemon aggregates and routes tool calls |

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| No caching in describe_tools | Owner requirement: always query live BM25 from proxy |
| Re-serialize args via JSON.stringify(JSON.parse(input)) | Prevents Go unmarshal failures from non-canonical LLM escaping |
| Reject invalid args with error (not silent fallback) | Never silently drop data — client gets clear error + instructions |
| Daemon is independent of core.ts | No mcpproxy-go dependency, pure MCP SDK client, different use case |
| Tool namespacing in daemon | Avoid collisions across servers, clear provenance |
