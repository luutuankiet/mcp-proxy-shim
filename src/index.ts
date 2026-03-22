#!/usr/bin/env node
/**
 * MCP Proxy Shim — Stdio Entry Point
 *
 * Runs the schema-transforming MCP proxy over stdio transport.
 * For HTTP Streamable transport, use `mcp-proxy-shim-http` instead.
 *
 * Usage:
 *   MCP_URL="https://proxy.example.com/mcp/?apikey=KEY" npx @luutuankiet/mcp-proxy-shim
 *
 * .mcp.json entry:
 *   { "mcpServers": { "proxy": { "type": "stdio", "command": "npx", "args": ["-y", "@luutuankiet/mcp-proxy-shim"], "env": { "MCP_URL": "..." } } } }
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createShimServer, log } from "./core.js";

async function main() {
  const server = await createShimServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("Stdio transport connected — shim is live");
}

main().catch((err) => {
  log("Fatal:", err);
  process.exit(1);
});
