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

// ---------------------------------------------------------------------------
// Mock MCP Upstream
// ---------------------------------------------------------------------------

const MOCK_TOOLS = [
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

  // Test 10: Unknown endpoint
  console.log("\nTest: GET /unknown");
  {
    const r = await request("GET", "/nonexistent");
    assert("status 404", r.status === 404, `got: ${r.status}`);
  }

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
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
