#!/usr/bin/env node
/**
 * MCP Proxy Shim — Daemon Mode (REST + MCP Gateway)
 *
 * Connects to a single upstream mcpproxy-go via MCP_URL (same as stdio/serve modes)
 * and exposes both REST endpoints for curl-based subagents AND a Streamable HTTP
 * /mcp endpoint for backward compatibility.
 *
 * Architecture:
 *   Subagent ──curl──▶ daemon (:3456) ──HTTP──▶ mcpproxy-go (upstream)
 *   MCP client ──HTTP──▶ daemon (:3456/mcp) ──HTTP──▶ mcpproxy-go (upstream)
 *
 * REST endpoints (clean JSON, no MCP wrappers):
 *   GET  /health           Health check + session info
 *   POST /retrieve_tools   { query, compact?, limit? }
 *   POST /describe_tools   { names: [...] }
 *   POST /call             { method, name, args, reason?, sensitivity? }
 *   POST /exec             { code }
 *   POST /reinit           Force new upstream session
 *
 * MCP endpoint (Streamable HTTP, backward compat):
 *   POST/GET/DELETE /mcp   Standard MCP Streamable HTTP protocol
 *
 * Environment variables:
 *   MCP_URL      (required)  Upstream mcpproxy-go StreamableHTTP endpoint
 *   MCP_PORT     (optional)  Port to listen on (default: 3456)
 *   MCP_HOST     (optional)  Host to bind to (default: 0.0.0.0)
 *   MCP_APIKEY   (optional)  Require ?apikey=KEY on requests
 *   https_proxy  (optional)  HTTPS proxy for upstream connection
 *
 * Usage:
 *   MCP_URL="https://proxy.example.com/mcp/?apikey=KEY" npx @luutuankiet/mcp-proxy-shim daemon
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createShimServer,
  log,
  maskUrl,
  UPSTREAM_URL,
  ensureSession,
  mcpRequest,
  deepUnwrapResult,
  compactRetrieveTools,
  transformToolCallArgs,
  reinitOnExpiry,
  getSessionId,
  resetSessionId,
} from "./core.js";

// ---------------------------------------------------------------------------
// Auto-load .cloud.env from CWD if MCP_URL not in environment
// ---------------------------------------------------------------------------

function autoLoadCloudEnv(): void {
  if (process.env.MCP_URL) return;
  const envPath = join(process.cwd(), ".cloud.env");
  if (!existsSync(envPath)) return;
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
    log("Loaded environment from .cloud.env");
  } catch (err) {
    log("Warning: failed to load .cloud.env:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.MCP_PORT || "3456", 10);
const HOST = process.env.MCP_HOST || "0.0.0.0";
const APIKEY = process.env.MCP_APIKEY || null;

const startTime = Date.now();
let callCount = 0;

// ---------------------------------------------------------------------------
// JSON body parser
// ---------------------------------------------------------------------------

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

// ---------------------------------------------------------------------------
// REST response helpers
// ---------------------------------------------------------------------------

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

/**
 * Unwrap an MCP tools/call response to clean JSON for REST consumers.
 * Parses content[0].text and JSON.parse if possible.
 */
function unwrapForRest(result: unknown): unknown {
  return deepUnwrapResult(result);
}

// ---------------------------------------------------------------------------
// REST endpoint handlers
// ---------------------------------------------------------------------------

async function handleHealth(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const sid = getSessionId();
  jsonResponse(res, 200, {
    ok: !!sid,
    sessionId: sid ? sid.slice(0, 12) + "..." : null,
    uptime: Math.round((Date.now() - startTime) / 1000),
    callCount,
  });
}

async function handleRetrieveTools(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await parseBody(req);
  const query = body.query as string;
  if (!query) {
    return jsonResponse(res, 400, { error: "query is required" });
  }

  try {
    await ensureSession();
    callCount++;

    const resp = await mcpRequest("tools/call", {
      name: "retrieve_tools",
      arguments: body,
    });

    if (!resp || resp.error) {
      return jsonResponse(res, 502, {
        error: "upstream error",
        detail: resp?.error || "no response",
      });
    }

    const compacted = compactRetrieveTools(deepUnwrapResult(resp.result), body);
    const unwrapped = unwrapForRest(compacted);
    return jsonResponse(res, 200, unwrapped);
  } catch (err) {
    return jsonResponse(res, 500, { error: (err as Error).message });
  }
}

async function handleDescribeTools(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await parseBody(req);
  const names = body.names as string[];
  if (!Array.isArray(names) || names.length === 0) {
    return jsonResponse(res, 400, { error: "names array is required" });
  }

  try {
    await ensureSession();
    callCount++;

    const results: unknown[] = [];
    for (const name of names) {
      const resp = await mcpRequest("tools/call", {
        name: "retrieve_tools",
        arguments: { query: name },
      });
      if (resp?.result) {
        const unwrapped = deepUnwrapResult(resp.result);
        const arr = Array.isArray(unwrapped)
          ? unwrapped
          : (unwrapped as Record<string, unknown>)?.tools;
        if (Array.isArray(arr)) {
          const match = arr.find(
            (t: Record<string, unknown>) => t.name === name,
          );
          results.push(match || { name, error: "not found" });
        } else {
          results.push({ name, error: "not found" });
        }
      } else {
        results.push({ name, error: "upstream error" });
      }
    }

    return jsonResponse(res, 200, results);
  } catch (err) {
    return jsonResponse(res, 500, { error: (err as Error).message });
  }
}

async function handleCall(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await parseBody(req);
  const method = body.method as string;
  const name = body.name as string;
  const args = (body.args || {}) as Record<string, unknown>;

  if (!name) {
    return jsonResponse(res, 400, { error: "name is required" });
  }

  const validMethods = [
    "call_tool_read",
    "call_tool_write",
    "call_tool_destructive",
  ];
  if (method && !validMethods.includes(method)) {
    return jsonResponse(res, 400, {
      error: `Invalid method: ${method}. Must be one of: ${validMethods.join(", ")}`,
    });
  }

  try {
    await ensureSession();
    callCount++;

    const toolName = method || "call_tool_read";
    const callArgs: Record<string, unknown> = { name, args };
    if (body.reason) callArgs.intent_reason = body.reason;
    if (body.sensitivity) callArgs.intent_data_sensitivity = body.sensitivity;

    const forwardArgs = transformToolCallArgs(toolName, callArgs);

    const resp = await mcpRequest("tools/call", {
      name: toolName,
      arguments: forwardArgs,
    });

    if (!resp) {
      return jsonResponse(res, 502, { error: "No response from upstream" });
    }

    if (resp.error) {
      if (
        resp.error.message?.includes("session") ||
        resp.error.message?.includes("Session") ||
        resp.error.code === -32001
      ) {
        const ok = await reinitOnExpiry();
        if (ok) {
          const retry = await mcpRequest("tools/call", {
            name: toolName,
            arguments: forwardArgs,
          });
          if (retry && !retry.error) {
            return jsonResponse(res, 200, unwrapForRest(retry.result));
          }
        }
      }
      return jsonResponse(res, 502, {
        error: "upstream error",
        detail: resp.error,
      });
    }

    return jsonResponse(res, 200, unwrapForRest(resp.result));
  } catch (err) {
    return jsonResponse(res, 500, { error: (err as Error).message });
  }
}

async function handleExec(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await parseBody(req);
  const code = body.code as string;

  if (!code) {
    return jsonResponse(res, 400, { error: "code is required" });
  }

  try {
    await ensureSession();
    callCount++;

    const resp = await mcpRequest("tools/call", {
      name: "code_execution",
      arguments: { code },
    });

    if (!resp) {
      return jsonResponse(res, 502, { error: "No response from upstream" });
    }

    if (resp.error) {
      return jsonResponse(res, 502, {
        error: "upstream error",
        detail: resp.error,
      });
    }

    return jsonResponse(res, 200, unwrapForRest(resp.result));
  } catch (err) {
    return jsonResponse(res, 500, { error: (err as Error).message });
  }
}

async function handleReinit(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    resetSessionId();
    await ensureSession();
    return jsonResponse(res, 200, {
      ok: true,
      sessionId: (getSessionId() || "").slice(0, 12) + "...",
    });
  } catch (err) {
    return jsonResponse(res, 500, {
      ok: false,
      error: (err as Error).message,
    });
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP /mcp endpoint (backward compat)
// ---------------------------------------------------------------------------

const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

async function createMcpSessionTransport(): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      log(`MCP session initialized: ${sessionId.slice(0, 12)}...`);
      mcpTransports.set(sessionId, transport);
    },
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && mcpTransports.has(sid)) {
      log(`MCP session closed: ${sid.slice(0, 12)}...`);
      mcpTransports.delete(sid);
    }
  };

  const server = await createShimServer({ lazyInit: true });
  await server.connect(transport);
  return transport;
}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Mcp-Session-Id, Last-Event-ID",
  );
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

      if (sessionId && mcpTransports.has(sessionId)) {
        const transport = mcpTransports.get(sessionId)!;
        await transport.handleRequest(req, res, body);
      } else if (!sessionId && isInitializeRequest(body)) {
        const transport = await createMcpSessionTransport();
        await transport.handleRequest(req, res, body);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: No valid session ID provided",
            },
            id: null,
          }),
        );
      }
    } else if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId || !mcpTransports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      const transport = mcpTransports.get(sessionId)!;
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
    }
  } catch (error) {
    log("MCP handler error:", (error as Error).message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP Server + routing
// ---------------------------------------------------------------------------

async function main() {
  log("Starting daemon (REST + MCP gateway)...");
  log(`Upstream: ${maskUrl(UPSTREAM_URL)}`);

  try {
    await ensureSession();
    log("Upstream session established");
  } catch (err) {
    log("Warning: initial upstream connection failed:", (err as Error).message);
    log("Will retry on first request");
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    const pathname = url.pathname;

    if (APIKEY && url.searchParams.get("apikey") !== APIKEY) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: invalid or missing apikey" }));
      return;
    }

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Last-Event-ID");
      res.writeHead(204);
      res.end();
      return;
    }

    const handler = async () => {
      if (pathname === "/health" || pathname === "/healthz") {
        return handleHealth(req, res);
      }
      if (pathname === "/retrieve_tools" && req.method === "POST") {
        return handleRetrieveTools(req, res);
      }
      if (pathname === "/describe_tools" && req.method === "POST") {
        return handleDescribeTools(req, res);
      }
      if (pathname === "/call" && req.method === "POST") {
        return handleCall(req, res);
      }
      if (pathname === "/exec" && req.method === "POST") {
        return handleExec(req, res);
      }
      if (pathname === "/reinit" && req.method === "POST") {
        return handleReinit(req, res);
      }
      if (pathname === "/mcp" || pathname === "/mcp/") {
        return handleMcpRequest(req, res);
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    };

    handler().catch((err) => {
      log("Unhandled error:", (err as Error).message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
  });

  httpServer.listen(PORT, HOST, () => {
    log(`Daemon listening on http://${HOST}:${PORT}`);
    log("REST endpoints: /health, /retrieve_tools, /describe_tools, /call, /exec, /reinit");
    log("MCP endpoint: /mcp");
    log(`Auth: ${APIKEY ? "apikey required (?apikey=...)" : "OPEN (no MCP_APIKEY set)"}`);
  });

  const shutdown = async () => {
    log("Shutting down daemon...");
    for (const [sid, transport] of mcpTransports) {
      try {
        await transport.close();
      } catch (err) {
        log(`Error closing MCP session ${sid.slice(0, 12)}:`, (err as Error).message);
      }
    }
    mcpTransports.clear();
    httpServer.close(() => {
      log("Daemon stopped");
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
