#!/usr/bin/env node
/**
 * MCP Proxy Shim — Passthru Mode
 *
 * Connects to any single MCP server (stdio, HTTP Streamable, SSE) and exposes
 * its tools as clean REST endpoints. Designed for MCP server development
 * and testing — lets LLM agents consume any MCP server via simple curl.
 *
 * Architecture:
 *   Agent ──curl──▶ passthru (:3456) ──MCP──▶ any MCP server
 *                 ◀─ clean JSON ◀──────────◀─ MCP response
 *
 * REST endpoints:
 *   GET  /health           Server status + transport info + tool count
 *   GET  /tools            Dehydrated tool list (name, description snippet, param summary)
 *   GET  /tools/:name      Full tool schema with complete inputSchema
 *   POST /call/:name       Invoke a tool with native JSON args → unwrapped result
 *   POST /restart          Kill + respawn upstream, re-list tools
 *
 * Usage:
 *   # Stdio — passthru spawns and manages the server process
 *   npx @luutuankiet/mcp-proxy-shim passthru -- npx tsx src/index.ts
 *
 *   # Stdio with extra env vars
 *   npx @luutuankiet/mcp-proxy-shim passthru --env API_KEY=xxx -- python server.py
 *
 *   # HTTP Streamable — connect to running server
 *   npx @luutuankiet/mcp-proxy-shim passthru --url http://localhost:3000/mcp
 *
 *   # HTTP with auth headers
 *   npx @luutuankiet/mcp-proxy-shim passthru --url http://localhost:3000/mcp --header "Authorization: Bearer xxx"
 *
 *   # SSE (legacy transport)
 *   npx @luutuankiet/mcp-proxy-shim passthru --url http://localhost:3000/sse --transport sse
 *
 *   # From config file
 *   npx @luutuankiet/mcp-proxy-shim passthru --config server.json
 *
 * Environment variables:
 *   MCP_PORT     Port for REST server (default: 3456)
 *   MCP_HOST     Host to bind to (default: 0.0.0.0)
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// ── Types ──────────────────────────────────────────────────────────

interface StdioConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface HttpConfig {
  type: "streamableHttp" | "sse";
  url: string;
  headers?: Record<string, string>;
}

type ServerConfig = StdioConfig | HttpConfig;

interface ToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface DehydratedTool {
  name: string;
  description: string;
  params: string;
}


// ── Raw fetch for HTTP tool calls (workaround for SDK #396) ────────
// The SDK's StreamableHTTPClientTransport has broken session multiplexing
// that causes 2nd+ callTool to hang. For HTTP/SSE upstreams, we use the
// SDK only for initialize + tools/list, then raw fetch for tools/call.
// Stdio transport is unaffected — uses SDK client directly.

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const { ProxyAgent } = _require("undici") as { ProxyAgent: new (url: string) => object };

const PROXY_URL = process.env.https_proxy || process.env.HTTPS_PROXY || "";
const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

let httpSessionId: string | null = null;
let httpReqId = 0;

async function rawMcpRequest(
  url: string,
  method: string,
  params: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    method,
    params,
    id: ++httpReqId,
  };

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(headers || {}),
  };
  if (httpSessionId) {
    reqHeaders["Mcp-Session-Id"] = httpSessionId;
  }

  const fetchOpts: RequestInit & { dispatcher?: object } = {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  };
  if (proxyDispatcher) {
    fetchOpts.dispatcher = proxyDispatcher;
  }

  const resp = await fetch(url, fetchOpts as RequestInit);

  const sid = resp.headers.get("mcp-session-id");
  if (sid) httpSessionId = sid;

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    // Stream-parse SSE events — the stream may never close (SDK #396),
    // so we read events incrementally and resolve on first JSON-RPC response.
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (terminated by double newline)
        const events = buffer.split("\n\n");
        buffer = events.pop() || ""; // Keep incomplete event in buffer

        for (const event of events) {
          for (const line of event.split("\n")) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              try {
                const parsed = JSON.parse(data);
                // Got a JSON-RPC response — cancel stream and return
                reader.cancel().catch(() => {});
                return parsed;
              } catch {
                // Not JSON, continue
              }
            }
          }
        }
      }
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    }
    throw new Error("SSE stream ended without JSON-RPC response");
  }

  return (await resp.json()) as Record<string, unknown>;
}

// ── Logging ────────────────────────────────────────────────────────

function log(...args: unknown[]) {
  console.error("[passthru]", ...args);
}

// ── Response unwrapping (salvaged from core.ts) ────────────────────
// Duplicated here intentionally to avoid importing core.ts which
// requires MCP_URL at module load time. Zero regression risk.

function isMcpContentWrapper(
  obj: unknown,
): obj is { content: Array<{ type: string; text: string }> } {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.content) || o.content.length === 0) return false;
  const first = o.content[0] as Record<string, unknown>;
  return first?.type === "text" && typeof first?.text === "string";
}

function deepParseText(text: string, maxDepth = 5): unknown {
  let value: unknown = text;
  let depth = 0;
  while (typeof value === "string" && depth < maxDepth) {
    try {
      const parsed = JSON.parse(value);
      if (isMcpContentWrapper(parsed)) {
        if (parsed.content.length === 1) {
          value = parsed.content[0].text;
          depth++;
          continue;
        }
        return parsed.content.map(
          (c: { type: string; text: string }) =>
            c.type === "text" ? deepParseText(c.text, maxDepth - depth - 1) : c,
        );
      }
      return parsed;
    } catch {
      break;
    }
  }
  return value;
}

function deepUnwrapResult(result: unknown): unknown {
  if (!isMcpContentWrapper(result)) return result;
  if (result.content.length === 1) {
    return deepParseText(result.content[0].text);
  }
  return result.content.map(
    (c: { type: string; text: string }) =>
      c.type === "text" ? deepParseText(c.text) : c,
  );
}

// ── CLI Parsing ────────────────────────────────────────────────────

function parseArgs(): ServerConfig {
  const args = process.argv.slice(3); // skip node, script, "passthru"

  // Check for --config file
  const configIdx = args.indexOf("--config");
  if (configIdx !== -1 && args[configIdx + 1]) {
    const configPath = args[configIdx + 1];
    try {
      const raw = readFileSync(configPath, "utf-8");
      return JSON.parse(raw) as ServerConfig;
    } catch (err) {
      log("Failed to read config:", (err as Error).message);
      process.exit(1);
    }
  }

  // Check for --url (HTTP/SSE mode)
  const urlIdx = args.indexOf("--url");
  if (urlIdx !== -1 && args[urlIdx + 1]) {
    const url = args[urlIdx + 1];

    // Parse --transport (default: streamableHttp)
    const transportIdx = args.indexOf("--transport");
    const transport = transportIdx !== -1 && args[transportIdx + 1] === "sse"
      ? "sse" as const
      : "streamableHttp" as const;

    // Parse --header flags (repeatable)
    const headers: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--header" && args[i + 1]) {
        const colonIdx = args[i + 1].indexOf(":");
        if (colonIdx > 0) {
          const key = args[i + 1].slice(0, colonIdx).trim();
          const val = args[i + 1].slice(colonIdx + 1).trim();
          headers[key] = val;
        }
      }
    }

    return {
      type: transport,
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  // Check for -- (stdio mode: everything after -- is the command)
  const dashDashIdx = args.indexOf("--");
  if (dashDashIdx !== -1) {
    const cmdArgs = args.slice(dashDashIdx + 1);
    if (cmdArgs.length === 0) {
      log("Error: no command specified after --");
      process.exit(1);
    }

    // Parse --env flags (before the --)
    const env: Record<string, string> = {};
    for (let i = 0; i < dashDashIdx; i++) {
      if (args[i] === "--env" && args[i + 1]) {
        const eqIdx = args[i + 1].indexOf("=");
        if (eqIdx > 0) {
          env[args[i + 1].slice(0, eqIdx)] = args[i + 1].slice(eqIdx + 1);
        }
      }
    }

    // Parse --cwd
    const cwdIdx = args.indexOf("--cwd");
    const cwd = cwdIdx !== -1 && cwdIdx < dashDashIdx ? args[cwdIdx + 1] : undefined;

    return {
      type: "stdio",
      command: cmdArgs[0],
      args: cmdArgs.slice(1),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }

  log("Error: specify either --url <URL>, --config <file>, or -- <command>");
  log("");
  log("Examples:");
  log("  passthru -- npx tsx src/index.ts");
  log("  passthru --url http://localhost:3000/mcp");
  log("  passthru --config server.json");
  process.exit(1);
}

// ── Transport Factory ──────────────────────────────────────────────

type AnyTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

function createTransport(config: ServerConfig): AnyTransport {
  if (config.type === "stdio") {
    log(`Stdio: ${config.command} ${(config.args || []).join(" ")}`);
    return new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: { ...process.env as Record<string, string>, ...(config.env || {}) },
      stderr: "pipe",
      ...(config.cwd ? { cwd: config.cwd } : {}),
    });
  }

  if (config.type === "sse") {
    log(`SSE: ${config.url}`);
    return new SSEClientTransport(
      new URL(config.url),
      config.headers
        ? { requestInit: { headers: config.headers } }
        : undefined,
    );
  }

  // Default: streamableHttp
  log(`HTTP Streamable: ${config.url}`);
  return new StreamableHTTPClientTransport(
    new URL(config.url),
    config.headers
      ? { requestInit: { headers: config.headers } }
      : undefined,
  );
}

// ── MCP Client Management ──────────────────────────────────────────

let client: Client | null = null;
let transport: AnyTransport | null = null;
let toolIndex: Map<string, ToolSchema> = new Map();
let serverConfig: ServerConfig;
let connectTime: number = 0;
let useRawFetch = false;
let httpUrl: string | null = null;
let httpHeaders: Record<string, string> = {};

async function connectServer(config: ServerConfig): Promise<void> {
  transport = createTransport(config);

  // Pipe stderr for stdio servers (helpful for debugging)
  if (transport instanceof StdioClientTransport && transport.stderr) {
    transport.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[upstream] ${chunk}`);
    });
  }

  client = new Client(
    { name: "mcp-passthru", version: "1.0.0" },
    { capabilities: {} },
  );

  // For HTTP/SSE transports, track URL for raw fetch workaround (SDK #396)
  if (config.type !== "stdio") {
    useRawFetch = true;
    httpUrl = (config as HttpConfig).url;
    httpHeaders = (config as HttpConfig).headers || {};
  } else {
    useRawFetch = false;
    httpUrl = null;
    httpHeaders = {};
  }

  log("Connecting to upstream MCP server...");
  await client.connect(transport);
  connectTime = Date.now();

  // Capture session ID from transport for raw fetch
  if (useRawFetch && transport instanceof StreamableHTTPClientTransport) {
    httpSessionId = (transport as any).sessionId || null;
  }

  log("Connected. Listing tools...");

  await refreshTools();
}

async function refreshTools(): Promise<void> {
  if (!client) throw new Error("Not connected");

  const { tools } = await client.listTools();
  toolIndex = new Map();
  for (const tool of tools) {
    toolIndex.set(tool.name, tool as ToolSchema);
  }
  log(`Indexed ${toolIndex.size} tools`);
}

async function disconnectServer(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } catch (err) {
      log("Close error:", (err as Error).message);
    }
    client = null;
  }
  if (transport) {
    try {
      await transport.close();
    } catch (err) {
      log("Transport close error:", (err as Error).message);
    }
    transport = null;
  }
  toolIndex.clear();
}

// ── Tool Dehydration ───────────────────────────────────────────────

function dehydrateTool(tool: ToolSchema): DehydratedTool {
  const desc = tool.description || "";
  const truncDesc = desc.length > 120 ? desc.slice(0, 120) + "..." : desc;

  // Build compact param summary: "name: type*" where * = required
  let params = "";
  if (tool.inputSchema?.properties) {
    const required = new Set(tool.inputSchema.required || []);
    const parts: string[] = [];
    for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
      const s = schema as Record<string, unknown>;
      let typeStr = (s.type as string) || "any";
      if (typeStr === "array" && s.items) {
        const itemType = (s.items as Record<string, unknown>).type || "any";
        typeStr = `${itemType}[]`;
      }
      parts.push(`${name}: ${typeStr}${required.has(name) ? "*" : ""}`);
    }
    params = parts.join(" | ");
  }

  return { name: tool.name, description: truncDesc, params };
}

function searchTools(query?: string): DehydratedTool[] {
  const tools = Array.from(toolIndex.values());
  if (!query) return tools.map(dehydrateTool);

  const q = query.toLowerCase();
  return tools
    .filter((t) => {
      const nameMatch = t.name.toLowerCase().includes(q);
      const descMatch = (t.description || "").toLowerCase().includes(q);
      return nameMatch || descMatch;
    })
    .map(dehydrateTool);
}

// ── HTTP Helpers ───────────────────────────────────────────────────

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

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  req?: http.IncomingMessage,
): void {
  // Format control via query param: ?pretty (default) or ?compact
  // Agents that want minimal tokens use ?compact, humans get pretty by default
  let indent: number | undefined = 2;
  if (req) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.searchParams.has("compact")) indent = undefined;
    if (url.searchParams.get("pretty") === "false") indent = undefined;
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body, null, indent));
}

function extractToolName(pathname: string, prefix: string): string {
  return decodeURIComponent(pathname.slice(prefix.length));
}

// ── Route Handlers ─────────────────────────────────────────────────

const startTime = Date.now();
let callCount = 0;

async function handleHealth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const transportType = serverConfig.type;
  let target = serverConfig.type === "stdio"
    ? `${serverConfig.command} ${(serverConfig.args || []).join(" ")}`
    : (serverConfig as HttpConfig).url;
  // Mask credentials in URL (e.g., ?apikey=xxx → ?apikey=***)
  target = target.replace(/apikey=[^&\s]+/gi, "apikey=***")
    .replace(/token=[^&\s]+/gi, "token=***")
    .replace(/\/\/([^:]+):[^@]+@/g, "//$1:***@");

  jsonResponse(res, 200, {
    ok: !!client,
    transport: transportType,
    target,
    tools_count: toolIndex.size,
    uptime: Math.round((Date.now() - startTime) / 1000),
    connected_for: client ? Math.round((Date.now() - connectTime) / 1000) : null,
    callCount,
  }, req);
}

async function handleListTools(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const query = url.searchParams.get("q") || undefined;

  const tools = searchTools(query);
  jsonResponse(res, 200, {
    tools,
    count: tools.length,
    total: toolIndex.size,
    ...(query ? { query } : {}),
    hint: "GET /tools/{name} for full inputSchema. Add ?compact to any endpoint for single-line JSON.",
  }, req);
}

async function handleGetTool(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  toolName: string,
): Promise<void> {
  const tool = toolIndex.get(toolName);
  if (!tool) {
    return jsonResponse(res, 404, {
      error: `Tool not found: ${toolName}`,
      available: Array.from(toolIndex.keys()),
    }, _req);
  }
  jsonResponse(res, 200, tool, _req);
}

async function handleCallTool(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  toolName: string,
): Promise<void> {
  if (!client) {
    return jsonResponse(res, 503, { error: "Not connected to upstream server" });
  }

  const tool = toolIndex.get(toolName);
  if (!tool) {
    return jsonResponse(res, 404, {
      error: `Tool not found: ${toolName}`,
      available: Array.from(toolIndex.keys()),
    });
  }

  const body = await parseBody(req);
  const args = (body.args || body) as Record<string, unknown>;

  // If body has a top-level "args" key, use that; otherwise treat entire body as args
  const toolArgs = body.args ? body.args as Record<string, unknown> : args;

  try {
    callCount++;
    let result: unknown;

    if (useRawFetch && httpUrl) {
      // Raw fetch workaround for SDK #396 (StreamableHTTPClientTransport
      // hangs on 2nd+ callTool due to broken session multiplexing)
      const resp = await rawMcpRequest(httpUrl, "tools/call", {
        name: toolName,
        arguments: toolArgs,
      }, httpHeaders);
      if (!resp) {
        return jsonResponse(res, 502, { error: "No response from upstream" });
      }
      if ((resp as any).error) {
        return jsonResponse(res, 502, {
          error: "upstream error",
          detail: (resp as any).error,
        });
      }
      result = (resp as any).result ?? resp;
    } else {
      // Stdio transport — SDK client works fine
      result = await client!.callTool({
        name: toolName,
        arguments: toolArgs,
      });
    }

    const unwrapped = deepUnwrapResult(result);

    // Check if the upstream reported an error
    const isError = (result as Record<string, unknown>)?.isError === true;

    jsonResponse(res, isError ? 422 : 200, unwrapped, req);
  } catch (err) {
    jsonResponse(res, 500, {
      error: "Tool call failed",
      detail: (err as Error).message,
    });
  }
}

async function handleRestart(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    log("Restarting upstream connection...");
    await disconnectServer();
    await connectServer(serverConfig);
    jsonResponse(res, 200, {
      ok: true,
      tools_count: toolIndex.size,
      tools: Array.from(toolIndex.keys()),
    });
  } catch (err) {
    jsonResponse(res, 500, {
      ok: false,
      error: (err as Error).message,
    });
  }
}

// ── Main ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MCP_PORT || "3456", 10);
const HOST = process.env.MCP_HOST || "0.0.0.0";

export async function main() {
  serverConfig = parseArgs();

  log("Starting passthru mode...");
  log(`Transport: ${serverConfig.type}`);

  try {
    await connectServer(serverConfig);
  } catch (err) {
    log("Failed to connect:", (err as Error).message);
    log("Server will start anyway — use POST /restart to retry");
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204);
      res.end();
      return;
    }

    const handler = async () => {
      // GET /health
      if ((pathname === "/health" || pathname === "/healthz") && req.method === "GET") {
        return handleHealth(req, res);
      }

      // GET /tools
      if (pathname === "/tools" && req.method === "GET") {
        return handleListTools(req, res);
      }

      // GET /tools/:name
      if (pathname.startsWith("/tools/") && req.method === "GET") {
        const toolName = extractToolName(pathname, "/tools/");
        return handleGetTool(req, res, toolName);
      }

      // POST /call/:name
      if (pathname.startsWith("/call/") && req.method === "POST") {
        const toolName = extractToolName(pathname, "/call/");
        return handleCallTool(req, res, toolName);
      }

      // POST /restart
      if (pathname === "/restart" && req.method === "POST") {
        return handleRestart(req, res);
      }

      jsonResponse(res, 404, {
        error: "Not Found",
        endpoints: {
          "GET  /health": "Server status",
          "GET  /tools": "List tools (dehydrated). ?q=keyword to search",
          "GET  /tools/:name": "Full tool schema",
          "POST /call/:name": "Invoke tool. Body: {args: {...}}",
          "POST /restart": "Restart upstream connection",
        },
        format: "Add ?compact to any endpoint for single-line JSON (saves tokens). Default: pretty-printed.",
      });
    };

    handler().catch((err) => {
      log("Unhandled error:", (err as Error).message);
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: "Internal Server Error" });
      }
    });
  });

  httpServer.listen(PORT, HOST, () => {
    log(`Passthru listening on http://${HOST}:${PORT}`);
    log("Endpoints: /health, /tools, /tools/:name, /call/:name, /restart");
    if (toolIndex.size > 0) {
      log(`Tools available: ${Array.from(toolIndex.keys()).join(", ")}`);
    }
  });

  const shutdown = async () => {
    log("Shutting down...");
    await disconnectServer();
    httpServer.close(() => {
      log("Stopped");
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
