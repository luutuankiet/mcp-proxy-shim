#!/usr/bin/env node
/**
 * MCP Shim Test Harness — Vanilla HTTP→Stdio Bridge
 *
 * Spawns the mcp-proxy-shim as a child process (stdio transport),
 * exposes a simple HTTP REST API so you can drive it from curl/Bash
 * in Claude Code sessions that can't add MCP servers on the fly.
 *
 * NO extra serialization — args pass through exactly as the shim
 * receives them from a real MCP client, so you can reproduce the
 * exact bugs reported in issue #1.
 *
 * Endpoints:
 *   POST /jsonrpc           Raw JSON-RPC passthrough (send any method)
 *   POST /initialize        Initialize the shim session
 *   POST /tools/list        List available tools
 *   POST /retrieve_tools    { query: "..." }
 *   POST /describe_tools    { names: ["tool1", "tool2"] }
 *   POST /call              { name: "tool_name", arguments: {...} }
 *   GET  /health            { ok, pid, uptime }
 *   POST /shutdown          Graceful shutdown
 *
 * Usage:
 *   MCP_URL="https://your-proxy/mcp/?apikey=KEY" node test/harness.mjs
 *   MCP_URL="..." HARNESS_PORT=4000 node test/harness.mjs
 *
 * Then from another terminal / Claude Code Bash tool:
 *   curl -s http://localhost:3456/tools/list | jq .
 *   curl -s http://localhost:3456/retrieve_tools -d '{"query":"github"}' | jq .
 *   curl -s http://localhost:3456/describe_tools -d '{"names":["github__get_file_contents"]}' | jq .
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = join(__dirname, "..", "dist", "index.js");

const PORT = parseInt(process.env.HARNESS_PORT || "3456");
const MCP_URL = process.env.MCP_URL;

if (!MCP_URL) {
  console.error("[harness] Fatal: MCP_URL environment variable is required.");
  console.error("[harness] Example: MCP_URL='https://your-proxy/mcp/?apikey=KEY' node test/harness.mjs");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Spawn shim child process
// ---------------------------------------------------------------------------

let reqId = 0;
const pending = new Map(); // id → { resolve, reject, timer }
let shimBuffer = "";
let shimProcess = null;
let shimReady = false;

function spawnShim() {
  const child = spawn("node", [SHIM_PATH], {
    env: {
      ...process.env,
      MCP_URL,
      // Ensure no proxy interference — caller should unset these if needed
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    shimBuffer += chunk.toString();
    const lines = shimBuffer.split("\n");
    shimBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve, timer } = pending.get(msg.id);
          clearTimeout(timer);
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // Not JSON — ignore (could be partial line)
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[shim] ${chunk}`);
  });

  child.on("exit", (code) => {
    console.error(`[harness] Shim process exited with code ${code}`);
    shimReady = false;
    // Reject all pending requests
    for (const [id, { reject, timer }] of pending) {
      clearTimeout(timer);
      reject(new Error("Shim process exited"));
      pending.delete(id);
    }
  });

  shimProcess = child;
  return child;
}

function sendToShim(method, params, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    if (!shimProcess || shimProcess.killed) {
      reject(new Error("Shim process not running"));
      return;
    }
    const id = ++reqId;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${method} id=${id}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    shimProcess.stdin.write(msg);
  });
}

function notifyShim(method, params) {
  if (!shimProcess || shimProcess.killed) return;
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  shimProcess.stdin.write(msg);
}

// ---------------------------------------------------------------------------
// Initialize shim MCP session
// ---------------------------------------------------------------------------

async function initializeShim() {
  console.error("[harness] Initializing shim MCP session...");
  const resp = await sendToShim("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-harness", version: "1.0" },
  });
  notifyShim("notifications/initialized", {});
  shimReady = true;
  console.error("[harness] Shim session ready");
  return resp;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
    });
    req.on("error", reject);
  });
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function parseContent(result) {
  if (result?.content?.[0]?.text) {
    try { return JSON.parse(result.content[0].text); }
    catch { return result.content[0].text; }
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const startTime = Date.now();

const server = http.createServer(async (req, res) => {
  const path = req.url?.split("?")[0] || "/";

  try {
    // --- GET endpoints ---
    if (req.method === "GET") {
      if (path === "/health") {
        return jsonResponse(res, 200, {
          ok: shimReady,
          pid: shimProcess?.pid || null,
          uptime: Math.round((Date.now() - startTime) / 1000),
          pendingRequests: pending.size,
        });
      }
      return jsonResponse(res, 404, { error: `Unknown GET endpoint: ${path}` });
    }

    if (req.method !== "POST") {
      return jsonResponse(res, 405, { error: "Method not allowed" });
    }

    const body = await readBody(req);

    // --- POST /jsonrpc — raw JSON-RPC passthrough ---
    if (path === "/jsonrpc") {
      const { method, params } = body;
      if (!method) return jsonResponse(res, 400, { error: "method is required" });
      const resp = await sendToShim(method, params || {});
      return jsonResponse(res, 200, resp);
    }

    // --- POST /initialize ---
    if (path === "/initialize") {
      const resp = await initializeShim();
      return jsonResponse(res, 200, resp);
    }

    // Remaining endpoints require an active session
    if (!shimReady) {
      return jsonResponse(res, 503, {
        error: "Shim not initialized. POST /initialize first.",
      });
    }

    // --- POST /tools/list ---
    if (path === "/tools/list") {
      const resp = await sendToShim("tools/list", {});
      return jsonResponse(res, 200, resp.result || resp);
    }

    // --- POST /retrieve_tools ---
    if (path === "/retrieve_tools") {
      const resp = await sendToShim("tools/call", {
        name: "retrieve_tools",
        arguments: body,
      });
      return jsonResponse(res, 200, {
        raw: resp.result,
        parsed: parseContent(resp.result),
      });
    }

    // --- POST /describe_tools ---
    if (path === "/describe_tools") {
      const resp = await sendToShim("tools/call", {
        name: "describe_tools",
        arguments: body,
      });
      return jsonResponse(res, 200, {
        raw: resp.result,
        parsed: parseContent(resp.result),
      });
    }

    // --- POST /call — generic tool call ---
    // Body: { name: "tool_name", arguments: { ... } }
    // This sends EXACTLY what a real MCP client would send — no extra serialization.
    if (path === "/call") {
      const { name, arguments: callArgs } = body;
      if (!name) return jsonResponse(res, 400, { error: "name is required" });
      const resp = await sendToShim("tools/call", {
        name,
        arguments: callArgs || {},
      });
      return jsonResponse(res, 200, {
        raw: resp.result,
        parsed: parseContent(resp.result),
      });
    }

    // --- POST /shutdown ---
    if (path === "/shutdown") {
      jsonResponse(res, 200, { ok: true, message: "Shutting down" });
      setTimeout(() => {
        shimProcess?.kill("SIGTERM");
        server.close();
        process.exit(0);
      }, 100);
      return;
    }

    return jsonResponse(res, 404, { error: `Unknown endpoint: ${path}` });
  } catch (err) {
    console.error(`[harness] Error on ${path}:`, err.message);
    return jsonResponse(res, 500, { error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

console.error(`[harness] Spawning shim with MCP_URL=${MCP_URL.replace(/apikey=[^&\s]+/gi, "apikey=***")}`);
spawnShim();

// Auto-initialize on startup
initializeShim()
  .then(() => {
    server.listen(PORT, "127.0.0.1", () => {
      console.error(`[harness] Listening on http://127.0.0.1:${PORT}`);
      console.error(`[harness] Endpoints: /initialize, /tools/list, /retrieve_tools, /describe_tools, /call, /health, /shutdown`);
      console.error(`[harness] Example: curl -s http://localhost:${PORT}/retrieve_tools -d '{"query":"github"}'`);
    });
  })
  .catch((err) => {
    console.error(`[harness] Failed to initialize: ${err.message}`);
    console.error("[harness] Starting server anyway — POST /initialize to retry");
    shimReady = false;
    server.listen(PORT, "127.0.0.1", () => {
      console.error(`[harness] Listening on http://127.0.0.1:${PORT} (shim NOT ready — POST /initialize to retry)`);
    });
  });

// Graceful shutdown
process.on("SIGINT", () => {
  console.error("\n[harness] Shutting down...");
  shimProcess?.kill("SIGTERM");
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shimProcess?.kill("SIGTERM");
  server.close();
  process.exit(0);
});
