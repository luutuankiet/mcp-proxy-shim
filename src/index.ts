#!/usr/bin/env node

// ---------------------------------------------------------------------------
// TLS: Default to insecure mode for sandbox/corporate proxy compatibility.
// Egress proxies (Anthropic sandbox, corporate MITM) present their own certs
// that Node.js rejects. Setting this globally before any imports ensures all
// fetch() calls, undici ProxyAgent, and MCP SDK transports work through
// TLS-intercepting proxies without manual NODE_TLS_REJECT_UNAUTHORIZED=0.
// ---------------------------------------------------------------------------
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

/**
 * MCP Proxy Shim — Unified Entry Point
 *
 * Subcommands:
 *   (default)  stdio transport — for local MCP clients (Claude Code, Cursor, etc.)
 *   serve      HTTP Streamable transport — for remote agents over HTTP
 *   daemon     REST + MCP gateway — single upstream via mcpproxy-go, exposes REST + /mcp
 *   passthru   Generic MCP→REST bridge — connect to any MCP server for dev/testing
 *
 * Usage:
 *   # Stdio mode (default) — single upstream via mcpproxy-go
 *   MCP_URL="https://proxy.example.com/mcp/?apikey=KEY" npx @luutuankiet/mcp-proxy-shim
 *
 *   # HTTP server mode — single upstream via mcpproxy-go
 *   MCP_URL="https://proxy.example.com/mcp/?apikey=KEY" npx @luutuankiet/mcp-proxy-shim serve
 *
 *   # Daemon mode — REST + MCP gateway for curl-based subagents
 *   MCP_URL="https://proxy.example.com/mcp/?apikey=KEY" npx @luutuankiet/mcp-proxy-shim daemon
 *
 * .mcp.json entry (stdio):
 *   { "mcpServers": { "proxy": { "type": "stdio", "command": "npx", "args": ["-y", "@luutuankiet/mcp-proxy-shim"], "env": { "MCP_URL": "..." } } } }
 */

const subcommand = process.argv[2];

// Handle --help before any imports (avoids MCP_URL validation in core.ts)
if (subcommand === "--help" || subcommand === "-h") {
  console.log("mcp-proxy-shim — MCP proxy with schema transforms");
  console.log("");
  console.log("Usage: mcp-proxy-shim [serve|daemon]");
  console.log("");
  console.log("Subcommands:");
  console.log("  (default)  stdio transport for local MCP clients (requires MCP_URL)");
  console.log("  serve      HTTP Streamable server for remote agents (requires MCP_URL)");
  console.log("  daemon     REST + MCP gateway for curl-based subagents (requires MCP_URL)");
  console.log("");
  console.log("Environment variables (default/serve modes):");
  console.log("  MCP_URL       (required) upstream mcpproxy-go endpoint");
  console.log("  MCP_PORT      (serve only) port to listen on (default: 3000)");
  console.log("  MCP_HOST      (serve only) host to bind to (default: 0.0.0.0)");
  console.log("  MCP_APIKEY    (serve only) require ?apikey=KEY on /mcp requests");
  console.log("  https_proxy   HTTPS proxy for upstream connection");
  console.log("");
  console.log("Environment variables (daemon mode):");
  console.log("  MCP_URL       (required) upstream mcpproxy-go endpoint");
  console.log("  MCP_PORT      Port to listen on (default: 3456)");
  console.log("  MCP_HOST      Host to bind to (default: 0.0.0.0)");
  console.log("  MCP_APIKEY    Require ?apikey=KEY on /mcp requests (optional)");
  console.log("");
  console.log("Daemon REST endpoints:");
  console.log("  GET  /health          Health check + session info");
  console.log("  POST /retrieve_tools  { query, compact?, limit? }");
  console.log("  POST /describe_tools  { names: [...] }");
  console.log("  POST /call            { method, name, args }");
  console.log("  POST /exec            { code }");
  console.log("  POST /reinit          Force new upstream session");
  console.log("  POST /mcp             Streamable HTTP (backward compat)");
  console.log("");
  console.log("Passthru mode (generic MCP→REST bridge):");
  console.log("  passthru -- <command> [args]   Spawn a stdio MCP server");
  console.log("  passthru --url <URL>           Connect to HTTP Streamable server");
  console.log("  passthru --url <URL> --transport sse   Connect to SSE server");
  console.log("  passthru --config <file>       Load server config from JSON");
  console.log("");
  console.log("Passthru options:");
  console.log("  --env KEY=VAL     Extra env vars for stdio (repeatable)");
  console.log("  --header K: V     Extra headers for HTTP/SSE (repeatable)");
  console.log("  --cwd <dir>       Working directory for stdio server");
  console.log("");
  console.log("Passthru REST endpoints:");
  console.log("  GET  /health          Server status + transport info");
  console.log("  GET  /tools           Dehydrated tool list (?q=keyword to search)");
  console.log("  GET  /tools/:name     Full tool schema with inputSchema");
  console.log("  POST /call/:name      Invoke tool. Body: {args: {...}}");
  console.log("  POST /restart         Restart upstream connection");
  process.exit(0);
}

if (subcommand === "serve") {
  // Dynamic import — only loads http-server + core when needed
  import("./http-server.js");
} else if (subcommand === "daemon") {
  // Dynamic import — loads daemon mode (no core.ts dependency)
  import("./daemon.js");
} else if (subcommand === "passthru") {
  // Dynamic import — generic MCP→REST bridge (no core.ts dependency)
  import("./passthru.js");
} else if (subcommand) {
  console.error(`Unknown subcommand: "${subcommand}"`);
  console.error("Usage: mcp-proxy-shim [serve|daemon|passthru]");
  console.error("  (no args)  stdio transport (default)");
  console.error("  serve      HTTP Streamable server");
  console.error("  daemon     REST + MCP gateway (mcpproxy-go)");
  console.error("  passthru   Generic MCP→REST bridge");
  process.exit(1);
} else {
  // Default: stdio mode
  import("./stdio.js");
}
