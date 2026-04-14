#!/usr/bin/env node
/**
 * Daemon E2E Test — Self-contained
 *
 * 1. Spawns a mock MCP upstream (tiny HTTP server speaking Streamable HTTP)
 * 2. Spawns the daemon as child process pointing at mock
 * 3. Runs test cases against the daemon's REST endpoints
 * 4. Reports pass/fail and exits with appropriate code
 *
 * Usage:
 *   npm run build && node test/daemon-e2e.mjs
 *
 * Requires: dist/daemon.js to be built first
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = join(__dirname, "..", "dist", "daemon.js");

const MOCK_PORT = 19876;
const DAEMON_PORT = 19877;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/mcp`;

let mockServer = null;
let daemonProcess = null;
let passed = 0;
let failed = 0;
const mockSessionId = "mock-session-" + Date.now();

// Mock admin API server list
const MOCK_ADMIN_SERVERS = [
  { name: "server-a", health: { summary: "Connected (10 tools)" }, enabled: true, url: "http://localhost:1111/mcp/all/", protocol: "http" },
  { name: "server-b", health: { summary: "Connecting..." }, enabled: true, url: "http://localhost:2222/mcp/all/", protocol: "http" },
  { name: "server-c", health: { summary: "Disabled", admin_state: "disabled" }, enabled: false, url: "", protocol: "stdio" },
];

function handleMockAdminApi(req, res, pathname) {
  res.setHeader("Content-Type", "application/json");

  // GET /api/v1/servers — list
  if (pathname === "/api/v1/servers" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { servers: MOCK_ADMIN_SERVERS, stats: { total_servers: 3 } } }));
    return;
  }

  // POST /api/v1/servers — add
  if (pathname === "/api/v1/servers" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, data: { action: "add", server: body.name, config: body } }));
    });
    return;
  }

  const restartMatch = pathname.match(/^\/api\/v1\/servers\/([^/]+)\/restart$/);
  if (restartMatch && req.method === "POST") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { action: "restart", server: restartMatch[1], success: true } }));
    return;
  }

  if (pathname === "/api/v1/servers/reconnect" && req.method === "POST") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { action: "reconnect", success: true } }));
    return;
  }

  const logsMatch = pathname.match(/^\/api\/v1\/servers\/([^/]+)\/logs$/);
  if (logsMatch && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { server: logsMatch[1], lines: ["mock log line 1", "mock log line 2"] } }));
    return;
  }

  // DELETE /api/v1/servers/{id} — remove
  const deleteMatch = pathname.match(/^\/api\/v1\/servers\/([^/]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { action: "remove", server: deleteMatch[1] } }));
    return;
  }

  // PATCH /api/v1/servers/{id} — patch
  const patchMatch = pathname.match(/^\/api\/v1\/servers\/([^/]+)$/);
  if (patchMatch && req.method === "PATCH") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, data: { action: "patch", server: patchMatch[1], config: body } }));
    });
    return;
  }

  // POST /api/v1/servers/{id}/enable
  const enableMatch = pathname.match(/^\/api\/v1\/servers\/([^/]+)\/enable$/);
  if (enableMatch && req.method === "POST") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { action: "enable", server: enableMatch[1] } }));
    return;
  }

  // POST /api/v1/servers/{id}/disable
  const disableMatch = pathname.match(/^\/api\/v1\/servers\/([^/]+)\/disable$/);
  if (disableMatch && req.method === "POST") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { action: "disable", server: disableMatch[1] } }));
    return;
  }

  // POST /api/v1/servers/{id}/quarantine
  const quarantineMatch = pathname.match(/^\/api\/v1\/servers\/([^/]+)\/quarantine$/);
  if (quarantineMatch && req.method === "POST") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { action: "quarantine", server: quarantineMatch[1] } }));
    return;
  }

  // POST /api/v1/servers/{id}/unquarantine
  const unquarantineMatch = pathname.match(/^\/api\/v1\/servers\/([^/]+)\/unquarantine$/);
  if (unquarantineMatch && req.method === "POST") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { action: "unquarantine", server: unquarantineMatch[1] } }));
    return;
  }

  // POST /api/v1/servers/{id}/tools/approve
  const approveMatch = pathname.match(/^\/api\/v1\/servers\/([^/]+)\/tools\/approve$/);
  if (approveMatch && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, data: { action: "approve_tools", server: approveMatch[1], body } }));
    });
    return;
  }

  // GET /api/v1/servers/{id}/tools
  const toolsMatch = pathname.match(/^\/api\/v1\/servers\/([^/]+)\/tools$/);
  if (toolsMatch && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { tools: [{ name: "tool-a", approved: true }, { name: "tool-b", approved: false }] } }));
    return;
  }

  // GET /api/v1/config
  if (pathname === "/api/v1/config" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { version: "mock-1.0", servers: MOCK_ADMIN_SERVERS } }));
    return;
  }

  // GET /api/v1/index/search
  if (pathname.startsWith("/api/v1/index/search") && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const q = url.searchParams.get("q") || "";
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { query: q, limit, results: [{ name: "matched-tool", score: 0.95 }] } }));
    return;
  }

  // GET /api/v1/status
  if (pathname === "/api/v1/status" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, data: { state: "running", uptime: 12345 } }));
    return;
  }

  // GET /swagger/doc.json
  if (pathname === "/swagger/doc.json" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ openapi: "3.0.0", info: { title: "mcpproxy-go", version: "1.0.0" }, paths: {} }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
}

// ---------------------------------------------------------------------------
// Mock MCP Upstream
// ---------------------------------------------------------------------------

const MOCK_BASE_TOOLS = [
  {
    name: "retrieve_tools",
    description: "Search for tools by keyword",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        compact: { type: "boolean" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "echo_tool",
    description: "Echoes back the arguments it receives",
    inputSchema: {
      type: "object",
      properties: {
        msg: { type: "string", description: "Message to echo" },
      },
      required: ["msg"],
    },
  },
];

// v1.6.1 shim-trim fixtures — 10 byte-identical fs-mcp duplicates across hosts.
// Used to exercise M1 dedup + M2 compact end-to-end through the daemon.
const FLEET_HOSTS = [
  "alpha_at_slash", "bravo_at_slash", "charlie_at_slash", "delta_at_slash", "echo_at_slash",
  "foxtrot_at_slash", "golf_at_slash", "hotel_at_slash", "india_at_slash", "juliet_at_slash",
];
const FLEET_DESCRIPTION_BODY =
  "Read the contents of multiple files simultaneously. " +
  "This is the canonical fs-mcp tool description that ships byte-identical across all fleet hosts.";
const FLEET_INPUTSCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  title: "ReadFilesInput",
  type: "object",
  properties: {
    files: {
      type: "array",
      description: "Files to read.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path. Prefer relative." },
          head: { type: "integer", nullable: true, description: "Read N from start. Cannot mix with start_line." },
          tail: { type: "integer", nullable: true, description: "Read N from end. Cannot mix with start_line." },
          start_line: { type: "integer", nullable: true, description: "1-based start line." },
          end_line: { type: "integer", nullable: true, description: "1-based end line (inclusive)." },
          read_to_next_pattern: { type: "string", nullable: true, description: "Section-aware terminator regex." },
          reads: {
            type: "array",
            nullable: true,
            description: "Multi-read spec list. Mode fields mutually exclusive within an item.",
            items: {
              type: "object",
              properties: {
                head: { type: "integer", nullable: true, description: "Read N from start. Cannot mix with start_line." },
                tail: { type: "integer", nullable: true, description: "Read N from end. Cannot mix with start_line." },
                start_line: { type: "integer", nullable: true, description: "1-based start line." },
                end_line: { type: "integer", nullable: true, description: "1-based end line (inclusive)." },
                read_to_next_pattern: { type: "string", nullable: true, description: "Section-aware terminator regex." },
              },
            },
          },
        },
        required: ["path"],
      },
    },
  },
  required: ["files"],
};
const FLEET_TOOLS = FLEET_HOSTS.map((host) => ({
  server: host,
  name: `${host}__read_files`,
  description: `[${host}] ${FLEET_DESCRIPTION_BODY}`,
  inputSchema: FLEET_INPUTSCHEMA,
  annotations: { destructiveHint: true, openWorldHint: true, readOnlyHint: false },
  call_with: "call_tool_destructive",
  score: 10.5,
  _meta: { "anthropic/maxResultSizeChars": 500000 },
}));

const MOCK_TOOLS = [...MOCK_BASE_TOOLS, ...FLEET_TOOLS];

function mockJsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function handleMockRpc(body) {
  const { method, params, id } = body;

  if (method === "initialize") {
    return mockJsonRpcResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mock-upstream", version: "1.0.0" },
    });
  }

  if (method === "notifications/initialized") {
    return null; // notification — no response
  }

  if (method === "tools/list") {
    return mockJsonRpcResponse(id, { tools: MOCK_TOOLS });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === "retrieve_tools") {
      const query = (args.query || "").toLowerCase();
      const matched = MOCK_TOOLS.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          (t.description || "").toLowerCase().includes(query),
      );
      return mockJsonRpcResponse(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ tools: matched }),
          },
        ],
      });
    }

    if (toolName === "echo_tool" || toolName === "call_tool_read") {
      // For call_tool_read, the real args are in args_json
      let echoArgs = args;
      if (args.args_json) {
        try {
          echoArgs = { name: args.name, ...JSON.parse(args.args_json) };
        } catch {
          echoArgs = { raw: args.args_json };
        }
      }
      return mockJsonRpcResponse(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ echoed: echoArgs, tool: toolName }),
          },
        ],
      });
    }

    if (toolName === "describe_tools") {
      const names = args.names || [];
      const results = names.map((n) => {
        const found = MOCK_TOOLS.find((t) => t.name === n);
        return found || { name: n, error: "not found" };
      });
      return mockJsonRpcResponse(id, {
        content: [{ type: "text", text: JSON.stringify(results) }],
      });
    }

    if (toolName === "code_execution") {
      return mockJsonRpcResponse(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, result: "executed" }),
          },
        ],
      });
    }

    // Unknown tool
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown tool: ${toolName}` },
    });
  }

  // Unknown method
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unknown method: ${method}` },
  });
}

function startMockServer() {
  return new Promise((resolve, reject) => {
    mockServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      // Admin API mock (for proxy_admin tests)
      if (reqUrl.pathname.startsWith("/api/v1/") || reqUrl.pathname.startsWith("/swagger/")) {
        return handleMockAdminApi(req, res, reqUrl.pathname);
      }

      res.setHeader("Mcp-Session-Id", mockSessionId);

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf-8");
          const body = raw ? JSON.parse(raw) : {};
          const response = handleMockRpc(body);

          if (response === null) {
            res.writeHead(202);
            res.end();
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(response);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: err.message },
              id: null,
            }),
          );
        }
      });
    });

    mockServer.listen(MOCK_PORT, "127.0.0.1", () => {
      console.error(`[mock] Listening on port ${MOCK_PORT}`);
      resolve();
    });
    mockServer.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Daemon process
// ---------------------------------------------------------------------------

function startDaemon() {
  return new Promise((resolve, reject) => {
    daemonProcess = spawn("node", [DAEMON_PATH], {
      env: {
        ...process.env,
        MCP_URL: MOCK_URL,
        MCP_PORT: String(DAEMON_PORT),
        MCP_HOST: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    daemonProcess.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[daemon] ${text}`);

      if (text.includes("Daemon listening")) {
        setTimeout(() => resolve(), 300);
      }
    });

    daemonProcess.on("error", reject);
    daemonProcess.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error(`[test] Daemon exited with code ${code}`);
        console.error(`[test] stderr: ${stderr.slice(-500)}`);
      }
    });

    setTimeout(() => {
      reject(new Error(`Daemon failed to start within 15s. stderr: ${stderr.slice(-500)}`));
    }, 15000);
  });
}

// ---------------------------------------------------------------------------
// HTTP client helper
// ---------------------------------------------------------------------------

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1",
      port: DAEMON_PORT,
      path,
      method,
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    };

    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request timeout")));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

function assert(name, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function runTests() {
  console.log("\n--- Daemon E2E Tests ---\n");

  // Test 1: GET /health
  console.log("Test: GET /health");
  {
    const r = await request("GET", "/health");
    assert("status 200", r.status === 200);
    assert("ok is true", r.body.ok === true, `got: ${JSON.stringify(r.body.ok)}`);
    assert("has uptime", typeof r.body.uptime === "number");
    assert("has callCount", typeof r.body.callCount === "number");
    assert("has sessionId", typeof r.body.sessionId === "string");
  }

  // Test 2: POST /retrieve_tools
  console.log("\nTest: POST /retrieve_tools");
  {
    const r = await request("POST", "/retrieve_tools", { query: "echo" });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const body = r.body;
    const tools = body?.tools || (Array.isArray(body) ? body : null);
    assert(
      "returns tools",
      tools && tools.length > 0,
      `body: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }

  // Test 3: POST /retrieve_tools without query
  console.log("\nTest: POST /retrieve_tools (missing query)");
  {
    const r = await request("POST", "/retrieve_tools", {});
    assert("status 400", r.status === 400, `got: ${r.status}`);
    assert("has error", !!r.body?.error);
  }

  // Test 4: POST /describe_tools
  console.log("\nTest: POST /describe_tools");
  {
    const r = await request("POST", "/describe_tools", {
      names: ["echo_tool"],
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const results = Array.isArray(r.body) ? r.body : [r.body];
    assert(
      "has echo_tool result",
      results.length > 0,
      `body: ${JSON.stringify(r.body).slice(0, 200)}`,
    );
  }

  // Test 5: POST /call
  console.log("\nTest: POST /call");
  {
    const r = await request("POST", "/call", {
      method: "call_tool_read",
      name: "echo_tool",
      args: { msg: "hello" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}, body: ${JSON.stringify(r.body).slice(0, 200)}`);
    const body = r.body;
    assert(
      "contains echoed data",
      body && (body.echoed || JSON.stringify(body).includes("hello")),
      `body: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }

  // Test 6: POST /call without name
  console.log("\nTest: POST /call (missing name)");
  {
    const r = await request("POST", "/call", { method: "call_tool_read" });
    assert("status 400", r.status === 400, `got: ${r.status}`);
  }

  // Test 7: POST /exec
  console.log("\nTest: POST /exec");
  {
    const r = await request("POST", "/exec", { code: "1 + 1" });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    assert("has result", r.body !== null && r.body !== undefined, `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  // Test 8: POST /reinit
  console.log("\nTest: POST /reinit");
  {
    const r = await request("POST", "/reinit");
    assert("status 200", r.status === 200, `got: ${r.status}`);
    assert("ok is true", r.body?.ok === true, `body: ${JSON.stringify(r.body)}`);
  }

  // Test 9: GET /health after reinit
  console.log("\nTest: GET /health (after reinit)");
  {
    const r = await request("GET", "/health");
    assert("status 200", r.status === 200);
    assert("still ok", r.body.ok === true, `got: ${JSON.stringify(r.body.ok)}`);
  }

  // proxy_admin tests
  console.log("\nTest: proxy_admin list");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "list" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    assert("has servers array", Array.isArray(r.body?.servers), `body: ${JSON.stringify(r.body).slice(0, 300)}`);
    assert("server count is 3", r.body?.total === 3, `got total: ${r.body?.total}`);
    const names = (r.body?.servers || []).map(s => s.name);
    assert("has server-a", names.includes("server-a"), `names: ${names}`);
  }

  console.log("\nTest: proxy_admin restart");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "restart", server_name: "server-a" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
  }

  console.log("\nTest: proxy_admin restart (missing server_name)");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "restart" },
    });
    assert("status 400", r.status === 400, `got: ${r.status}`);
    assert("has error msg", !!r.body?.error, `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: proxy_admin reconnect");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "reconnect" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
  }

  console.log("\nTest: proxy_admin tail_log");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "tail_log", server_name: "server-a", lines: 10 },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
  }

  console.log("\nTest: proxy_admin unknown operation");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "bogus" },
    });
    assert("status 400", r.status === 400, `got: ${r.status}`);
  }

  // Shim-local tool discovery tests (LOG-007 BUG 2 fix)
  console.log("\nTest: POST /retrieve_tools (shim-local proxy_admin discovery)");
  {
    const r = await request("POST", "/retrieve_tools", { query: "proxy_admin" });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const tools = r.body?.tools || (Array.isArray(r.body) ? r.body : null);
    assert(
      "returns tools array",
      Array.isArray(tools),
      `body: ${JSON.stringify(r.body).slice(0, 200)}`,
    );
    const names = (tools || []).map((t) => t.name);
    assert(
      "contains proxy_admin",
      names.includes("proxy_admin"),
      `names: ${JSON.stringify(names)}`,
    );
    assert(
      "contains describe_tools",
      names.includes("describe_tools"),
      `names: ${JSON.stringify(names)}`,
    );
    const proxyAdmin = (tools || []).find((t) => t.name === "proxy_admin");
    assert(
      "proxy_admin has server=shim-local",
      proxyAdmin?.server === "shim-local",
      `got: ${proxyAdmin?.server}`,
    );
    assert(
      "proxy_admin has call_with=call_tool_destructive",
      proxyAdmin?.call_with === "call_tool_destructive",
      `got: ${proxyAdmin?.call_with}`,
    );
  }

  console.log("\nTest: POST /describe_tools (shim-local resolution)");
  {
    const r = await request("POST", "/describe_tools", {
      names: ["proxy_admin", "describe_tools"],
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const results = Array.isArray(r.body) ? r.body : [r.body];
    assert("returns 2 results", results.length === 2, `got: ${results.length}`);
    const pa = results.find((t) => t?.name === "proxy_admin");
    const dt = results.find((t) => t?.name === "describe_tools");
    assert("proxy_admin resolved", !!pa && !pa.error, `got: ${JSON.stringify(pa).slice(0, 200)}`);
    assert("describe_tools resolved", !!dt && !dt.error, `got: ${JSON.stringify(dt).slice(0, 200)}`);
    assert(
      "proxy_admin has inputSchema with operation",
      !!pa?.inputSchema?.properties?.operation,
      `schema: ${JSON.stringify(pa?.inputSchema).slice(0, 200)}`,
    );
    assert(
      "describe_tools has inputSchema with names",
      !!dt?.inputSchema?.properties?.names,
      `schema: ${JSON.stringify(dt?.inputSchema).slice(0, 200)}`,
    );
  }

  // --- v1.6.0: New operation tests ---

  console.log("\nTest: proxy_admin add");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "add", config: { name: "new-server", url: "http://localhost:9999/mcp", protocol: "http" } },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const addData = r.body?.data || r.body;
    assert("has action add", addData?.action === "add", `body: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert("has server name", addData?.server === "new-server", `got: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: proxy_admin add (missing config)");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "add" },
    });
    assert("status 400", r.status === 400, `got: ${r.status}`);
  }

  console.log("\nTest: proxy_admin remove");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "remove", server_name: "server-a" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const rmData = r.body?.data || r.body;
    assert("has action remove", rmData?.action === "remove", `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: proxy_admin remove (missing server_name)");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "remove" },
    });
    assert("status 400", r.status === 400, `got: ${r.status}`);
  }

  console.log("\nTest: proxy_admin patch");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "patch", server_name: "server-a", config: { protocol: "streamable-http" } },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const patchData = r.body?.data || r.body;
    assert("has action patch", patchData?.action === "patch", `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: proxy_admin patch (missing config)");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "patch", server_name: "server-a" },
    });
    assert("status 400", r.status === 400, `got: ${r.status}`);
  }

  console.log("\nTest: proxy_admin enable");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "enable", server_name: "server-c" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const enData = r.body?.data || r.body;
    assert("has action enable", enData?.action === "enable", `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: proxy_admin disable");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "disable", server_name: "server-a" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const disData = r.body?.data || r.body;
    assert("has action disable", disData?.action === "disable", `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: proxy_admin quarantine");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "quarantine", server_name: "server-a" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const qData = r.body?.data || r.body;
    assert("has action quarantine", qData?.action === "quarantine", `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: proxy_admin unquarantine");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "unquarantine", server_name: "server-a" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const uqData = r.body?.data || r.body;
    assert("has action unquarantine", uqData?.action === "unquarantine", `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: proxy_admin approve_tools (with tools array)");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "approve_tools", server_name: "server-a", tools: ["tool-a", "tool-b"] },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const appData = r.body?.data || r.body;
    assert("has action approve_tools", appData?.action === "approve_tools", `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: proxy_admin approve_tools (with approve_all)");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "approve_tools", server_name: "server-a", approve_all: true },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
  }

  console.log("\nTest: proxy_admin approve_tools (missing tools and approve_all)");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "approve_tools", server_name: "server-a" },
    });
    assert("status 400", r.status === 400, `got: ${r.status}`);
  }

  console.log("\nTest: proxy_admin inspect_config");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "inspect_config" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    assert("has config data", r.body?.version === "mock-1.0" || r.body?.data?.version === "mock-1.0", `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: proxy_admin inspect_server");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "inspect_server", server_name: "server-a" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    assert("has server info", !!r.body?.server, `body: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert("has tools info", !!r.body?.tools, `body: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert("server name matches", r.body?.server?.name === "server-a", `got: ${r.body?.server?.name}`);
  }

  console.log("\nTest: proxy_admin inspect_server (missing server_name)");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "inspect_server" },
    });
    assert("status 400", r.status === 400, `got: ${r.status}`);
  }

  console.log("\nTest: proxy_admin search_tools");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "search_tools", query: "read files", limit: 5 },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    assert("has results", !!r.body?.results || !!r.body?.data?.results, `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: proxy_admin search_tools (missing query)");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "search_tools" },
    });
    assert("status 400", r.status === 400, `got: ${r.status}`);
  }

  console.log("\nTest: proxy_admin status");
  {
    const r = await request("POST", "/call", {
      name: "proxy_admin",
      args: { operation: "status" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    assert("has state", !!r.body?.state || !!r.body?.data?.state, `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  // --- v1.6.0: First-class REST endpoint tests ---

  console.log("\nTest: POST /proxy_admin (first-class endpoint)");
  {
    const r = await request("POST", "/proxy_admin", {
      operation: "list",
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    assert("has servers array", Array.isArray(r.body?.servers), `body: ${JSON.stringify(r.body).slice(0, 300)}`);
  }

  console.log("\nTest: POST /proxy_admin (missing operation)");
  {
    const r = await request("POST", "/proxy_admin", {});
    assert("status 400", r.status === 400, `got: ${r.status}`);
    assert("has error", !!r.body?.error, `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: POST /proxy_admin add via REST");
  {
    const r = await request("POST", "/proxy_admin", {
      operation: "add",
      config: { name: "rest-server", url: "http://localhost:8888/mcp", protocol: "sse" },
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const restAddData = r.body?.data || r.body;
    assert("has action add", restAddData?.action === "add", `body: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  console.log("\nTest: GET /proxy_admin/schema");
  {
    const r = await request("GET", "/proxy_admin/schema");
    assert("status 200", r.status === 200, `got: ${r.status}`);
    assert("has properties", !!r.body?.properties, `body: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert("has operation enum", Array.isArray(r.body?.properties?.operation?.enum), `body: ${JSON.stringify(r.body?.properties?.operation).slice(0, 200)}`);
    const ops = r.body?.properties?.operation?.enum || [];
    assert("has 16 operations", ops.length === 16, `got: ${ops.length} — ${ops}`);
    assert("includes add", ops.includes("add"), `ops: ${ops}`);
    assert("includes search_tools", ops.includes("search_tools"), `ops: ${ops}`);
  }

  // Unknown endpoint test
  console.log("\nTest: GET /unknown");
  {
    const r = await request("GET", "/nonexistent");
    assert("status 404", r.status === 404, `got: ${r.status}`);
  }

  // ----------------------------------------------------------------------
  // v1.6.1 shim-trim middleware tests (M1 dedup + M2 compact)
  // ----------------------------------------------------------------------

  console.log("\nTest: POST /retrieve_tools (M1 dedup folds host duplicates)");
  {
    const r = await request("POST", "/retrieve_tools", { query: "read_files" });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const tools = r.body?.tools || (Array.isArray(r.body) ? r.body : []);
    const fleetEntries = tools.filter((t) => (t?.name || "").endsWith("__read_files"));
    assert(
      "10 host duplicates fold into 1 canonical entry",
      fleetEntries.length === 1,
      `got ${fleetEntries.length}: ${fleetEntries.map((t) => t.name).join(", ")}`,
    );
    const canonical = fleetEntries[0];
    assert(
      "canonical entry has servers[] of length 10",
      Array.isArray(canonical?.servers) && canonical.servers.length === 10,
      `got: ${JSON.stringify(canonical?.servers)}`,
    );
    assert(
      "servers[] contains alpha_at_slash + juliet_at_slash",
      canonical?.servers?.includes("alpha_at_slash") && canonical?.servers?.includes("juliet_at_slash"),
      `got: ${JSON.stringify(canonical?.servers)}`,
    );
    assert(
      "singleton 'server' field removed on collapse",
      canonical?.server === undefined,
      `got: ${canonical?.server}`,
    );
    assert(
      "description prefix '[host] ' stripped on collapse",
      typeof canonical?.description === "string" && !canonical.description.startsWith("["),
      `got: ${(canonical?.description || "").slice(0, 80)}`,
    );
  }

  console.log("\nTest: POST /describe_tools (M2 strips $schema/_meta/score/title/additionalProperties)");
  {
    const r = await request("POST", "/describe_tools", {
      names: ["alpha_at_slash__read_files"],
    });
    assert("status 200", r.status === 200, `got: ${r.status}`);
    const results = Array.isArray(r.body) ? r.body : [r.body];
    assert("returned 1 result", results.length === 1, `got: ${results.length}`);
    const tool = results[0];
    assert("resolved tool (no error)", tool && !tool.error, `got: ${JSON.stringify(tool).slice(0, 200)}`);

    const blob = JSON.stringify(tool);
    for (const key of ["$schema", "additionalProperties", "_meta", "score", "title"]) {
      assert(
        `compact stripped key: ${key}`,
        !blob.includes(`"${key}"`),
        `key '${key}' still present in: ${blob.slice(0, 200)}`,
      );
    }
  }

  console.log("\nTest: POST /describe_tools (M2 flattens read_files reads[] structural dup)");
  {
    const r = await request("POST", "/describe_tools", {
      names: ["alpha_at_slash__read_files"],
    });
    assert("status 200", r.status === 200);
    const tool = (Array.isArray(r.body) ? r.body : [r.body])[0];
    const innerHead =
      tool?.inputSchema?.properties?.files?.items?.properties?.reads?.items?.properties?.head;
    assert(
      "reads[].head description rewritten to parent pointer",
      typeof innerHead?.description === "string" && innerHead.description.startsWith("See parent file item."),
      `got: ${JSON.stringify(innerHead)}`,
    );
    const parentHeadDesc =
      tool?.inputSchema?.properties?.files?.items?.properties?.head?.description;
    assert(
      "parent files[].head description preserved verbatim",
      typeof parentHeadDesc === "string" && parentHeadDesc.includes("Read N from start"),
      `got: ${parentHeadDesc}`,
    );
  }

  // ----------------------------------------------------------------------
  // v1.6.1 kill-switch test — spawn a second daemon with M1+M2 disabled,
  // confirm pre-middleware behavior (no dedup, no schema strip).
  // ----------------------------------------------------------------------

  console.log("\nTest: SHIM_DISABLE_DEDUP / SHIM_DISABLE_COMPACT env kill-switches");
  {
    const altDaemon = await startSecondaryDaemon(DAEMON_PORT + 1, {
      SHIM_DISABLE_DEDUP: "1",
      SHIM_DISABLE_COMPACT: "1",
    });
    try {
      const altR = await requestPort(DAEMON_PORT + 1, "POST", "/retrieve_tools", { query: "read_files" });
      assert("status 200 (alt daemon)", altR.status === 200, `got: ${altR.status}`);
      const altTools = altR.body?.tools || (Array.isArray(altR.body) ? altR.body : []);
      const altFleet = altTools.filter((t) => (t?.name || "").endsWith("__read_files"));
      assert(
        "dedup OFF → all 10 host entries returned individually",
        altFleet.length === 10,
        `got ${altFleet.length}`,
      );
      assert(
        "dedup OFF → entries keep 'server' singleton, no 'servers' array",
        altFleet.every((t) => typeof t.server === "string" && !Array.isArray(t.servers)),
        `sample: ${JSON.stringify(altFleet[0]).slice(0, 200)}`,
      );

      const altDescribe = await requestPort(DAEMON_PORT + 1, "POST", "/describe_tools", {
        names: ["alpha_at_slash__read_files"],
      });
      const altTool = (Array.isArray(altDescribe.body) ? altDescribe.body : [altDescribe.body])[0];
      const altBlob = JSON.stringify(altTool);
      assert(
        "compact OFF → $schema preserved",
        altBlob.includes('"$schema"'),
        `blob: ${altBlob.slice(0, 200)}`,
      );
      assert(
        "compact OFF → _meta preserved",
        altBlob.includes('"_meta"'),
        `blob: ${altBlob.slice(0, 200)}`,
      );
    } finally {
      altDaemon.kill("SIGTERM");
    }
  }

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
}

// Spawn a second daemon for env-flag testing. Caller is responsible for kill().
function startSecondaryDaemon(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [DAEMON_PATH], {
      env: {
        ...process.env,
        MCP_URL: MOCK_URL,
        MCP_PORT: String(port),
        MCP_HOST: "127.0.0.1",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (text.includes("Daemon listening")) {
        setTimeout(() => resolve(child), 200);
      }
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error(`Secondary daemon failed within 10s: ${stderr.slice(-300)}`)), 10000);
  });
}

function requestPort(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request timeout")));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function cleanup() {
  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (!daemonProcess.killed) {
      daemonProcess.kill("SIGKILL");
    }
  }
  if (mockServer) {
    mockServer.close();
  }
}

async function main() {
  try {
    console.error("[test] Starting mock upstream...");
    await startMockServer();

    console.error("[test] Starting daemon...");
    await startDaemon();

    console.error("[test] Running tests...");
    await runTests();
  } catch (err) {
    console.error(`[test] Fatal: ${err.message}`);
    failed++;
  } finally {
    await cleanup();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
