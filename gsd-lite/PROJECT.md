# Project

*Initialized: 2026-03-25*

## What This Is

MCP proxy shim for [mcpproxy-go](https://github.com/smart-mcp-proxy/mcpproxy-go) — eliminates `args_json` string escaping overhead for LLM clients. Three modes: **stdio** (local), **HTTP serve** (remote), and **daemon** (multi-server MCP gateway for cloud agents).

## Core Value

LLMs pass native JSON objects instead of hand-escaping `args_json` strings — zero malformed payloads, 87% token savings per tool call.

## Success Criteria

Project succeeds when:
- [x] `call_tool_read/write/destructive` accept `args: object` and auto-serialize to `args_json: string`
- [x] `describe_tools` resolves tool schemas reliably via live BM25 queries
- [x] `daemon` mode connects to N upstream MCP servers (stdio + HTTP) and aggregates tools
- [ ] Daemon mode adopted as fallback for cloud agent sessions (claude.ai/code, Codespaces)
- [ ] Published to npm with stable API (`npx @luutuankiet/mcp-proxy-shim daemon`)

## Context

mcpproxy-go's `/mcp/call` mode uses generic dispatcher tools that accept `args_json: string`. This is sound design (one schema covers any upstream tool) but causes ~400 tokens of escaping overhead per LLM call and frequent malformed payloads. The shim sits between MCP clients and mcpproxy-go, transforming schemas at the edge.

The daemon mode is a separate capability: a standalone MCP gateway that connects directly to upstream MCP servers (bypassing mcpproxy-go) for environments where agents can't spawn MCP servers on the fly.

## Constraints

- Must not break existing `args_json: string` callers (backward compat)
- Upstream mcpproxy-go is not under our control — shim is client-side only
- stdio transport: stdout is the MCP channel, all logging must go to stderr
- Node.js >=20, TypeScript, `@modelcontextprotocol/sdk` ^1.12
- Corporate proxy environments: must handle `https_proxy` via undici ProxyAgent
