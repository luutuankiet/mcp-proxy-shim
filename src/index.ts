#!/usr/bin/env node
/**
 * MCP Proxy Shim — Unified Entry Point
 *
 * Subcommands:
 *   (default)  stdio transport — for local MCP clients (Claude Code, Cursor, etc.)
 *   serve      HTTP Streamable transport — for remote agents over HTTP
 *
 * Usage:
 *   # Stdio mode (default)
 *   MCP_URL="https://proxy.example.com/mcp/?apikey=KEY" npx @luutuankiet/mcp-proxy-shim
 *
 *   # HTTP server mode
 *   MCP_URL="https://proxy.example.com/mcp/?apikey=KEY" npx @luutuankiet/mcp-proxy-shim serve
 *   MCP_URL="..." MCP_PORT=8080 npx @luutuankiet/mcp-proxy-shim serve
 *
 * .mcp.json entry (stdio):
 *   { "mcpServers": { "proxy": { "type": "stdio", "command": "npx", "args": ["-y", "@luutuankiet/mcp-proxy-shim"], "env": { "MCP_URL": "..." } } } }
 */

const subcommand = process.argv[2];

// Handle --help before any imports (avoids MCP_URL validation in core.ts)
if (subcommand === "--help" || subcommand === "-h") {
  console.log("mcp-proxy-shim — MCP proxy with schema transforms");
  console.log("");
  console.log("Usage: mcp-proxy-shim [serve]");
  console.log("");
  console.log("Subcommands:");
  console.log("  (default)  stdio transport for local MCP clients");
  console.log("  serve      HTTP Streamable server for remote agents");
  console.log("");
  console.log("Environment variables:");
  console.log("  MCP_URL       (required) upstream mcpproxy-go endpoint");
  console.log("  MCP_PORT      (serve only) port to listen on (default: 3000)");
  console.log("  MCP_HOST      (serve only) host to bind to (default: 0.0.0.0)");
  console.log("  https_proxy   HTTPS proxy for upstream connection");
  process.exit(0);
}

if (subcommand === "serve") {
  // Dynamic import — only loads http-server + core when needed
  import("./http-server.js");
} else if (subcommand) {
  console.error(`Unknown subcommand: "${subcommand}"`);
  console.error("Usage: mcp-proxy-shim [serve]");
  console.error("  (no args)  stdio transport (default)");
  console.error("  serve      HTTP Streamable server");
  process.exit(1);
} else {
  // Default: stdio mode
  import("./stdio.js");
}
