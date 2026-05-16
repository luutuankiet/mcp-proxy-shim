/**
 * MCP Proxy Shim — Stdio Transport
 *
 * Imported by index.ts when no subcommand is given (default mode).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createShimServer, log, startIdleWatchdog } from "./core.js";

/**
 * v1.6.5 — Parent-orphan watchdog.
 *
 * mcpproxy-go orphans the old shim child on upstream reconnect by abandoning
 * the stdio pipes without closing them. stdin never sees EOF. Empirically
 * confirmed via lsof: mcpproxy still holds the write end. Stdin/EPIPE based
 * detection is therefore dead-code in the actual failure mode.
 *
 * Defense-in-depth: an idle-inbound watchdog. mcpproxy hammers a live shim
 * with ~3 tools/list/sec, so absence-of-traffic is a binary orphan signal.
 *
 * Tunable: MCP_SHIM_IDLE_TIMEOUT_SEC (default 600 = 10 min, 0 disables).
 * Stdio-only — http/daemon/passthru modes have human-driven sessions where
 * minutes-long idleness is normal.
 */
const IDLE_TIMEOUT_SEC = parseInt(
  process.env.MCP_SHIM_IDLE_TIMEOUT_SEC ?? "600",
  10,
);

async function main() {
  const server = await createShimServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("Stdio transport connected — shim is live");

  // Arm AFTER connect so the reference point is "live as of now",
  // not "spawned but not yet handshaken".
  startIdleWatchdog(IDLE_TIMEOUT_SEC);
}

main().catch((err) => {
  log("Fatal:", err);
  process.exit(1);
});
