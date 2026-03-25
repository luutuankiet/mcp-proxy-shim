#!/usr/bin/env node
/**
 * MCP Proxy Shim — Daemon Mode
 *
 * Multi-server MCP gateway: connects to N upstream MCP servers (stdio or HTTP)
 * and exposes all their tools through a single HTTP Streamable endpoint.
 *
 * Pure passthrough — no schema transformation. Designed for cloud agents that
 * can't spawn MCP servers on the fly.
 *
 * Architecture:
 *   Cloud Agent ──HTTP──▶ daemon (:3456) ──┬── stdio ──▶ spawned process
 *                                          ├── HTTP  ──▶ remote MCP server
 *                                          └── stdio ──▶ another process
 *
 * Configuration via MCP_SERVERS env var (JSON) or MCP_CONFIG file path:
 *
 *   {
 *     "github": {
 *       "type": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-github"],
 *       "env": { "GITHUB_TOKEN": "ghp_..." }
 *     },
 *     "my-api": {
 *       "type": "streamableHttp",
 *       "url": "https://api.example.com/mcp",
 *       "headers": { "Authorization": "Bearer xxx", "X-Custom": "value" }
 *     }
 *   }
 *
 * Environment variables:
 *   MCP_SERVERS    JSON string with server configs (inline)
 *   MCP_CONFIG     Path to JSON config file (alternative to MCP_SERVERS)
 *   MCP_PORT       Port to listen on (default: 3456)
 *   MCP_HOST       Host to bind to (default: 0.0.0.0)
 *   MCP_APIKEY     Require ?apikey=KEY on /mcp requests (optional)
 *
 * Usage:
 *   MCP_SERVERS='{"github":{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}}' \
 *     npx @luutuankiet/mcp-proxy-shim daemon
 *
 *   MCP_CONFIG=./mcp-servers.json npx @luutuankiet/mcp-proxy-shim daemon
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

// Proxy support — same pattern as core.ts
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const { ProxyAgent } = _require("undici") as { ProxyAgent: new (url: string) => object };

const PROXY_URL = process.env.https_proxy || process.env.HTTPS_PROXY || "";
const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface HttpServerConfig {
  type: "streamableHttp" | "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

type ServerConfig = StdioServerConfig | HttpServerConfig;

interface UpstreamServer {
  name: string;
  config: ServerConfig;
  client: Client;
  tools: ToolDef[];
  connected: boolean;
}

interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.MCP_PORT || "3456", 10);
const HOST = process.env.MCP_HOST || "0.0.0.0";
const APIKEY = process.env.MCP_APIKEY || null;

function log(...args: unknown[]) {
  console.error("[mcp-daemon]", ...args);
}

function loadConfig(): Record<string, ServerConfig> {
  // Try inline JSON first
  if (process.env.MCP_SERVERS) {
    try {
      return JSON.parse(process.env.MCP_SERVERS);
    } catch (err) {
      log("Fatal: MCP_SERVERS is not valid JSON:", (err as Error).message);
      process.exit(1);
    }
  }

  // Try config file
  if (process.env.MCP_CONFIG) {
    try {
      const raw = readFileSync(process.env.MCP_CONFIG, "utf-8");
      const parsed = JSON.parse(raw);
      // Support both { servers: {...} } and flat { name: config } format
      // Also support .mcp.json format: { mcpServers: {...} }
      return parsed.mcpServers || parsed.servers || parsed;
    } catch (err) {
      log("Fatal: Cannot read MCP_CONFIG:", (err as Error).message);
      process.exit(1);
    }
  }

  log("Fatal: No server configuration provided.");
  log("Set MCP_SERVERS (JSON) or MCP_CONFIG (file path).");
  log("");
  log("Example:");
  log(`  MCP_SERVERS='{"my-server":{"type":"stdio","command":"npx","args":["-y","some-mcp-server"]}}' \\`);
  log("    npx @luutuankiet/mcp-proxy-shim daemon");
  process.exit(1);
  return {} as never;
}

// ---------------------------------------------------------------------------
// Upstream connection management
// ---------------------------------------------------------------------------

const upstreams: Map<string, UpstreamServer> = new Map();

/** Namespace a tool name with server prefix to avoid collisions */
function namespaceTool(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`;
}

/** Extract server name and original tool name from namespaced name */
function parseNamespacedTool(namespacedName: string): { serverName: string; toolName: string } | null {
  for (const [name] of upstreams) {
    const prefix = `${name}__`;
    if (namespacedName.startsWith(prefix)) {
      return { serverName: name, toolName: namespacedName.slice(prefix.length) };
    }
  }
  return null;
}

async function connectStdio(name: string, config: StdioServerConfig): Promise<UpstreamServer> {
  log(`[${name}] Connecting via stdio: ${config.command} ${(config.args || []).join(" ")}`);

  const client = new Client(
    { name: `mcp-daemon/${name}`, version: "1.0.0" },
    { capabilities: {} },
  );

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
    cwd: config.cwd,
  });

  await client.connect(transport);
  log(`[${name}] Connected (pid: ${transport.pid ?? "unknown"})`);

  // Fetch tools
  const toolsResult = await client.listTools();
  const tools = (toolsResult.tools || []) as ToolDef[];
  log(`[${name}] ${tools.length} tools available`);

  return { name, config, client, tools, connected: true };
}

async function connectHttp(name: string, config: HttpServerConfig): Promise<UpstreamServer> {
  const maskedUrl = config.url.replace(/apikey=[^&\s]+/gi, "apikey=***");
  log(`[${name}] Connecting via HTTP: ${maskedUrl}`);
  if (config.headers) {
    const headerNames = Object.keys(config.headers);
    log(`[${name}] Custom headers: ${headerNames.join(", ")}`);
  }

  const client = new Client(
    { name: `mcp-daemon/${name}`, version: "1.0.0" },
    { capabilities: {} },
  );

  const url = new URL(config.url);

  // Build requestInit with custom headers and proxy support
  const requestInit: RequestInit & { dispatcher?: object } = {};
  if (config.headers && Object.keys(config.headers).length > 0) {
    requestInit.headers = config.headers;
  }
  if (proxyDispatcher) {
    requestInit.dispatcher = proxyDispatcher;
    log(`[${name}] Using HTTPS proxy`);
  }

  const opts: { requestInit?: RequestInit } = {};
  if (Object.keys(requestInit).length > 0) {
    opts.requestInit = requestInit as RequestInit;
  }

  const transport = new StreamableHTTPClientTransport(url, opts);
  await client.connect(transport);
  log(`[${name}] Connected`);

  // Fetch tools
  const toolsResult = await client.listTools();
  const tools = (toolsResult.tools || []) as ToolDef[];
  log(`[${name}] ${tools.length} tools available`);

  return { name, config, client, tools, connected: true };
}

async function connectServer(name: string, config: ServerConfig): Promise<UpstreamServer | null> {
  try {
    if (config.type === "stdio") {
      return await connectStdio(name, config);
    } else if (config.type === "streamableHttp" || config.type === "http" || config.type === "sse") {
      return await connectHttp(name, config as HttpServerConfig);
    } else {
      log(`[${name}] Unknown server type: ${(config as { type: string }).type}`);
      return null;
    }
  } catch (err) {
    log(`[${name}] Connection failed:`, (err as Error).message);
    return null;
  }
}

/** Refresh tools from a specific upstream */
async function refreshTools(server: UpstreamServer): Promise<void> {
  try {
    const result = await server.client.listTools();
    server.tools = (result.tools || []) as ToolDef[];
    log(`[${server.name}] Refreshed: ${server.tools.length} tools`);
  } catch (err) {
    log(`[${server.name}] Tool refresh failed:`, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Aggregated tool list
// ---------------------------------------------------------------------------

function getAggregatedTools(): ToolDef[] {
  const allTools: ToolDef[] = [];
  for (const [, server] of upstreams) {
    if (!server.connected) continue;
    for (const tool of server.tools) {
      allTools.push({
        ...tool,
        name: namespaceTool(server.name, tool.name),
        description: `[${server.name}] ${tool.description || ""}`.trim(),
      });
    }
  }
  return allTools;
}

// ---------------------------------------------------------------------------
// Downstream MCP server (exposed to cloud agents)
// ---------------------------------------------------------------------------

const downstreamTransports = new Map<string, StreamableHTTPServerTransport>();

async function createDownstreamSession(): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      log(`Session initialized: ${sessionId.slice(0, 12)}...`);
      downstreamTransports.set(sessionId, transport);
    },
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && downstreamTransports.has(sid)) {
      log(`Session closed: ${sid.slice(0, 12)}...`);
      downstreamTransports.delete(sid);
    }
  };

  // Create MCP server for this session
  const server = new Server(
    { name: "mcp-daemon", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Handle tools/list — aggregate from all upstreams
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Refresh tools from all connected upstreams
    await Promise.allSettled(
      [...upstreams.values()]
        .filter((s) => s.connected)
        .map((s) => refreshTools(s)),
    );

    return { tools: getAggregatedTools() };
  });

  // Handle tools/call — route to correct upstream
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const parsed = parseNamespacedTool(name);
    if (!parsed) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: `Unknown tool: ${name}. Tool names are prefixed with server name (e.g., "myserver__toolname").` }) }],
        isError: true,
      };
    }

    const server = upstreams.get(parsed.serverName);
    if (!server || !server.connected) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: `Server "${parsed.serverName}" is not connected` }) }],
        isError: true,
      };
    }

    try {
      const result = await server.client.callTool({
        name: parsed.toolName,
        arguments: args || {},
      });

      // Passthrough the result as-is
      if (result.content && Array.isArray(result.content)) {
        return {
          content: result.content as Array<{ type: "text"; text: string }>,
          isError: result.isError === true ? true : undefined,
        };
      }

      // Wrap non-standard results
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const msg = (err as Error).message;
      log(`[${parsed.serverName}] Tool call error (${parsed.toolName}):`, msg);
      return {
        content: [{ type: "text" as const, text: `Error calling ${parsed.serverName}/${parsed.toolName}: ${msg}` }],
        isError: true,
      };
    }
  });

  await server.connect(transport);
  return transport;
}

// ---------------------------------------------------------------------------
// HTTP Server
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
  // CORS
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

      if (sessionId && downstreamTransports.has(sessionId)) {
        const transport = downstreamTransports.get(sessionId)!;
        await transport.handleRequest(req, res, body);
      } else if (!sessionId && isInitializeRequest(body)) {
        const transport = await createDownstreamSession();
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
      if (!sessionId || !downstreamTransports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      const transport = downstreamTransports.get(sessionId)!;
      await transport.handleRequest(req, res);
    } else if (req.method === "DELETE") {
      if (!sessionId || !downstreamTransports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      const transport = downstreamTransports.get(sessionId)!;
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("Starting MCP Daemon...");

  const configs = loadConfig();
  const serverNames = Object.keys(configs);

  if (serverNames.length === 0) {
    log("Fatal: No servers defined in configuration.");
    process.exit(1);
  }

  log(`Configured servers: ${serverNames.join(", ")}`);

  // Connect to all upstream servers in parallel
  const results = await Promise.allSettled(
    serverNames.map(async (name) => {
      const server = await connectServer(name, configs[name]);
      if (server) {
        upstreams.set(name, server);
      }
      return server;
    }),
  );

  const connected = [...upstreams.values()].filter((s) => s.connected);
  const totalTools = connected.reduce((sum, s) => sum + s.tools.length, 0);

  if (connected.length === 0) {
    log("Fatal: No upstream servers connected successfully.");
    process.exit(1);
  }

  log(`Connected: ${connected.length}/${serverNames.length} servers, ${totalTools} total tools`);

  // Print tool summary
  for (const server of connected) {
    log(`  [${server.name}] ${server.tools.length} tools: ${server.tools.slice(0, 5).map((t) => t.name).join(", ")}${server.tools.length > 5 ? "..." : ""}`);
  }

  // Start HTTP server
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      // Apikey gate
      if (APIKEY && url.searchParams.get("apikey") !== APIKEY) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: invalid or missing apikey" },
          id: null,
        }));
        return;
      }
      handleMcpRequest(req, res).catch((err) => {
        log("Unhandled error:", (err as Error).message);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      });
    } else if (url.pathname === "/health" || url.pathname === "/healthz") {
      const serverStatus: Record<string, { connected: boolean; tools: number; type: string }> = {};
      for (const [name, server] of upstreams) {
        serverStatus[name] = {
          connected: server.connected,
          tools: server.tools.length,
          type: server.config.type,
        };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        sessions: downstreamTransports.size,
        uptime: process.uptime(),
        servers: serverStatus,
        totalTools,
      }));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found — MCP endpoint is at /mcp");
    }
  });

  httpServer.listen(PORT, HOST, () => {
    log(`Daemon listening on http://${HOST}:${PORT}/mcp`);
    log(`Health check: http://${HOST}:${PORT}/health`);
    log(`Auth: ${APIKEY ? "apikey required (?apikey=...)" : "OPEN (no MCP_APIKEY set)"}`);
    log("Waiting for MCP client connections...");
  });

  // Graceful shutdown
  const shutdown = async () => {
    log("Shutting down daemon...");

    // Close downstream sessions
    for (const [sid, transport] of downstreamTransports) {
      try {
        await transport.close();
      } catch (err) {
        log(`Error closing session ${sid.slice(0, 12)}:`, (err as Error).message);
      }
    }
    downstreamTransports.clear();

    // Disconnect upstream servers
    for (const [name, server] of upstreams) {
      try {
        log(`Disconnecting [${name}]...`);
        await server.client.close();
      } catch (err) {
        log(`Error disconnecting [${name}]:`, (err as Error).message);
      }
    }
    upstreams.clear();

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
