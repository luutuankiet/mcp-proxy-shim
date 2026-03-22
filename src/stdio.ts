/**
 * MCP Proxy Shim — Stdio Transport
 *
 * Imported by index.ts when no subcommand is given (default mode).
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
