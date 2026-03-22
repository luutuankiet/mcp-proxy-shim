#!/usr/bin/env node
/**
 * MCP Proxy Shim — HTTP Streamable Server Entry Point
 *
 * Runs the schema-transforming MCP proxy as an HTTP Streamable server.
 * Remote agents connect via HTTP POST/GET/DELETE to /mcp.
 *
 * Architecture:
 *   Remote Agent  ──HTTP──▶  this server (:3000/mcp)  ──HTTP──▶  mcpproxy-go (upstream)
 *
 * Each downstream client session gets its own MCP Server + Transport pair,
 * but they all share a SINGLE upstream mcpproxy-go connection (module-level
 * state in core.ts). This is efficient: one upstream session, many downstream.
 *
 * Environment variables:
 *   MCP_URL      (required)  Upstream mcpproxy-go StreamableHTTP endpoint
 *   MCP_PORT     (optional)  Port to listen on (default: 3000)
 *   MCP_HOST     (optional)  Host to bind to (default: 0.0.0.0)
 *   https_proxy  (optional)  HTTPS proxy for upstream connection
 *
 * Usage:
 *   MCP_URL="https://mcpproxy.kenluu.org/mcp/?apikey=KEY" npx @luutuankiet/mcp-proxy-shim-http
 *
 * Then point your MCP client at:
 *   http://localhost:3000/mcp
 *
 * For production, put a reverse proxy (Caddy/nginx) in front for TLS:
 *   https://shim.yourdomain.com/mcp  ──▶  http://localhost:3000/mcp
 */

import { randomUUID } from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createShimServer, log, maskUrl, UPSTREAM_URL } from "./core.js";

const PORT = parseInt(process.env.MCP_PORT || "3000", 10);
const HOST = process.env.MCP_HOST || "0.0.0.0";

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------
// Each downstream client gets its own MCP Server + Transport pair.
// All of them share the SAME upstream mcpproxy-go session (module-level in core.ts).

const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Create a new downstream session: fresh Server + Transport pair.
 * The upstream connection is shared via core.ts module state.
 */
async function createSessionTransport(): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      log(`HTTP session initialized: ${sessionId.slice(0, 12)}...`);
      transports.set(sessionId, transport);
    },
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && transports.has(sid)) {
      log(`HTTP session closed: ${sid.slice(0, 12)}...`);
      transports.delete(sid);
    }
  };

  // Each session gets its own shim server with lazy upstream init.
  // core.ts ensures the upstream session is shared (module-level singleton).
  const server = await createShimServer({ lazyInit: true });
  await server.connect(transport);

  return transport;
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // CORS headers for browser-based clients
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    if (req.method === "POST") {
      const body = await parseBody(req);

      if (sessionId && transports.has(sessionId)) {
        // Existing session
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res, body);
      } else if (!sessionId && isInitializeRequest(body)) {
        // New client — create session
        const transport = await createSessionTransport();
        await transport.handleRequest(req, res, body);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        }));
      }
    } else if (req.method === "GET") {
      // SSE stream reconnection
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      const lastEventId = req.headers["last-event-id"];
      if (lastEventId) {
        log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
      }
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
    } else if (req.method === "DELETE") {
      // Session termination
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      log(`Session termination request: ${sessionId.slice(0, 12)}...`);
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
    }
  } catch (error) {
    log("HTTP handler error:", (error as Error).message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

async function main() {
  log(`Starting HTTP Streamable server on ${HOST}:${PORT}`);
  log(`Upstream: ${maskUrl(UPSTREAM_URL)}`);

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      handleMcpRequest(req, res).catch((err) => {
        log("Unhandled error in MCP handler:", (err as Error).message);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      });
    } else if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        sessions: transports.size,
        uptime: process.uptime(),
      }));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found — MCP endpoint is at /mcp");
    }
  });

  httpServer.listen(PORT, HOST, () => {
    log(`HTTP Streamable server listening on http://${HOST}:${PORT}/mcp`);
    log(`Health check: http://${HOST}:${PORT}/health`);
    log("Waiting for MCP client connections...");
  });

  // Graceful shutdown
  const shutdown = async () => {
    log("Shutting down HTTP server...");
    for (const [sid, transport] of transports) {
      try {
        log(`Closing session ${sid.slice(0, 12)}...`);
        await transport.close();
      } catch (err) {
        log(`Error closing session ${sid.slice(0, 12)}:`, (err as Error).message);
      }
    }
    transports.clear();
    httpServer.close(() => {
      log("HTTP server stopped");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log("Fatal:", err);
  process.exit(1);
});
