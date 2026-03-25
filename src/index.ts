#!/usr/bin/env node
/**
 * MCP Proxy Shim — Unified Entry Point
 *
 * Subcommands:
 *   (default)  stdio transport — for local MCP clients (Claude Code, Cursor, etc.)
 *   serve      HTTP Streamable transport — for remote agents over HTTP
 *   daemon     Multi-server MCP gateway — connects to N upstreams, exposes via HTTP
 *
 * Usage:
 *   # Stdio mode (default) — single upstream via mcpproxy-go
 *   MCP_URL="https://proxy.example.com/mcp/?apikey=KEY" npx @luutuankiet/mcp-proxy-shim
 *
 *   # HTTP server mode — single upstream via mcpproxy-go
 *   MCP_URL="https://proxy.example.com/mcp/?apikey=KEY" npx @luutuankiet/mcp-proxy-shim serve
 *
 *   # Daemon mode — multi-server gateway (stdio + HTTP upstreams)
 *   MCP_SERVERS='{"github":{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}}' \
 *     npx @luutuankiet/mcp-proxy-shim daemon
 *   MCP_CONFIG=./mcp-servers.json npx @luutuankiet/mcp-proxy-shim daemon
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
  console.log("  daemon     Multi-server MCP gateway — pure passthrough, no transforms");
  console.log("");
  console.log("Environment variables (default/serve modes):");
  console.log("  MCP_URL       (required) upstream mcpproxy-go endpoint");
  console.log("  MCP_PORT      (serve only) port to listen on (default: 3000)");
  console.log("  MCP_HOST      (serve only) host to bind to (default: 0.0.0.0)");
  console.log("  MCP_APIKEY    (serve only) require ?apikey=KEY on /mcp requests");
  console.log("  https_proxy   HTTPS proxy for upstream connection");
  console.log("");
  console.log("Environment variables (daemon mode):");
  console.log("  MCP_SERVERS   JSON string with server configs (inline)");
  console.log("  MCP_CONFIG    Path to JSON config file (alternative to MCP_SERVERS)");
  console.log("  MCP_PORT      Port to listen on (default: 3456)");
  console.log("  MCP_HOST      Host to bind to (default: 0.0.0.0)");
  console.log("  MCP_APIKEY    Require ?apikey=KEY on /mcp requests (optional)");
  console.log("");
  console.log("Daemon config format (JSON):");
  console.log('  { "server-name": { "type": "stdio", "command": "cmd", "args": [...], "env": {...} } }');
  console.log('  { "server-name": { "type": "streamableHttp", "url": "https://...", "headers": {...} } }');
  process.exit(0);
}

if (subcommand === "serve") {
  // Dynamic import — only loads http-server + core when needed
  import("./http-server.js");
} else if (subcommand === "daemon") {
  // Dynamic import — loads daemon mode (no core.ts dependency)
  import("./daemon.js");
} else if (subcommand) {
  console.error(`Unknown subcommand: "${subcommand}"`);
  console.error("Usage: mcp-proxy-shim [serve|daemon]");
  console.error("  (no args)  stdio transport (default)");
  console.error("  serve      HTTP Streamable server");
  console.error("  daemon     Multi-server MCP gateway");
  process.exit(1);
} else {
  // Default: stdio mode
  import("./stdio.js");
}
