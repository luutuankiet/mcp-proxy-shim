#!/usr/bin/env node
/**
 * Issue #7: Multiline/pretty-printed args get double-encoded as string
 *
 * Tests the fix in two layers:
 *   Layer 1 (unit): transformToolCallArgs handles string-wrapped and
 *                   double-encoded args correctly
 *   Layer 2 (E2E):  Full shim round-trip against a real upstream server
 *
 * Unit tests run without MCP_URL. E2E tests require:
 *   MCP_URL="https://your-proxy/mcp/?apikey=KEY" node test/issue-7-multiline-args.mjs
 *
 * For targeted E2E against a specific server (e.g., fs-mcp on thinkpad):
 *   E2E_TOOL_NAME="thinkpad:edit_files" E2E_TOOL_ARGS='{"files":[...]}' \
 *     MCP_URL="..." node test/issue-7-multiline-args.mjs
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = join(__dirname, "..", "dist", "core.js");
const SHIM_PATH = join(__dirname, "..", "dist", "index.js");

// Set a dummy MCP_URL so core.js doesn't exit on import (unit tests don't connect)
if (!process.env.MCP_URL) {
  process.env.MCP_URL = "http://localhost:0/dummy";
}

let passed = 0;
let failed = 0;

function assert(condition, label, detail) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    if (detail) console.log(`     ${detail}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Layer 1: Unit tests — direct function calls, no upstream needed
// ---------------------------------------------------------------------------

async function unitTests() {
  console.log("\n=== LAYER 1: Unit Tests (transformToolCallArgs) ===\n");

  // Dynamic import the compiled module
  const { transformToolCallArgs } = await import(CORE_PATH);

  // --- Test 1: Normal object args (happy path) ---
  console.log("Test 1: Normal object args (happy path)");
  {
    const result = transformToolCallArgs("call_tool_destructive", {
      name: "server:edit_files",
      args: { files: [{ path: "test.txt", edits: [{ match_text: "", new_string: "hello" }] }] },
    });
    assert(typeof result.args_json === "string", "args_json is a string");
    assert(!("args" in result), "args field removed");
    const parsed = JSON.parse(result.args_json);
    assert(Array.isArray(parsed.files), "args_json contains files array");
  }

  // --- Test 2: Single-line string args (pre-serialized) ---
  console.log("\nTest 2: Single-line string args (pre-serialized)");
  {
    const argsStr = '{"files":[{"path":"test.txt","edits":[{"match_text":"","new_string":"hello"}]}]}';
    const result = transformToolCallArgs("call_tool_read", {
      name: "server:edit_files",
      args: argsStr,
    });
    assert(typeof result.args_json === "string", "args_json is a string");
    const parsed = JSON.parse(result.args_json);
    assert(Array.isArray(parsed.files), "args_json parses to object with files");
  }

  // --- Test 3: ISSUE 7 — Multiline string args (the bug) ---
  console.log("\nTest 3: Multiline/pretty-printed string args (Issue #7 core case)");
  {
    // This is what Claude's tool calling infrastructure sends when the LLM
    // pretty-prints the args parameter — a string containing valid JSON
    const multilineArgs = '{\n  "files": [\n    {\n      "path": "src/example.txt",\n      "edits": [\n        {\n          "match_text": "",\n          "new_string": "hello world"\n        }\n      ]\n    }\n  ]\n}';
    const result = transformToolCallArgs("call_tool_destructive", {
      name: "server:edit_files",
      args: multilineArgs,
    });
    assert(typeof result.args_json === "string", "args_json is a string");
    const parsed = JSON.parse(result.args_json);
    assert(Array.isArray(parsed.files), "args_json parses to object with files");
    assert(parsed.files[0].path === "src/example.txt", "path preserved correctly");
    assert(!result.args_json.includes("\n"), "args_json is single-line (canonical)");
  }

  // --- Test 4: ISSUE 7 — Double-encoded string args (worst case) ---
  console.log("\nTest 4: Double-encoded string args (string-within-string)");
  {
    // This is the worst case: the encoding layer wraps the JSON object in
    // string delimiters AND escapes inner quotes, producing a JSON string
    // whose value is itself a JSON object string.
    const innerJson = '{"owner":"luutuankiet","repo":"mcp-proxy-shim"}';
    const doubleEncoded = JSON.stringify(innerJson); // '"{\\"owner\\":\\"luutuankiet\\",...}"'
    const result = transformToolCallArgs("call_tool_write", {
      name: "server:get_file_contents",
      args: doubleEncoded,
    });
    assert(typeof result.args_json === "string", "args_json is a string");
    const parsed = JSON.parse(result.args_json);
    assert(parsed.owner === "luutuankiet", "owner field recovered from double-encoding");
    assert(parsed.repo === "mcp-proxy-shim", "repo field recovered from double-encoding");
  }

  // --- Test 5: ISSUE 7 — Double-encoded multiline string args ---
  console.log("\nTest 5: Double-encoded multiline string args (combined worst case)");
  {
    const prettyJson = JSON.stringify(
      { files: [{ path: "test.txt", edits: [{ match_text: "", new_string: "hello" }] }] },
      null,
      2
    );
    // Double-encode: wrap pretty-printed JSON in another layer of string encoding
    const doubleEncoded = JSON.stringify(prettyJson);
    const result = transformToolCallArgs("call_tool_destructive", {
      name: "server:edit_files",
      args: doubleEncoded,
    });
    assert(typeof result.args_json === "string", "args_json is a string");
    const parsed = JSON.parse(result.args_json);
    assert(Array.isArray(parsed.files), "files array recovered from double-encoded multiline");
    assert(!result.args_json.includes("\n"), "args_json is single-line (canonical)");
  }

  // --- Test 6: Non-call_tool tools pass through unchanged ---
  console.log("\nTest 6: Non-call_tool tools pass through unchanged");
  {
    const args = { query: "test" };
    const result = transformToolCallArgs("retrieve_tools", args);
    assert(result === args, "args passed through unchanged");
  }

  // --- Test 7: Null/undefined args → empty object ---
  console.log("\nTest 7: Null/undefined args → empty object");
  {
    const result = transformToolCallArgs("call_tool_read", {
      name: "server:tool",
      args: null,
    });
    assert(result.args_json === "{}", "null args becomes empty object");
  }

  // --- Test 8: Invalid args still throw ---
  console.log("\nTest 8: Invalid args still throw ArgsValidationError");
  {
    let threw = false;
    try {
      transformToolCallArgs("call_tool_read", {
        name: "server:tool",
        args: "not valid json at all",
      });
    } catch (err) {
      threw = true;
      assert(err.name === "ArgsValidationError", "Threw ArgsValidationError");
    }
    assert(threw, "Invalid string args throws error");
  }

  // --- Test 9: String-encoded non-object still throws ---
  console.log("\nTest 9: String-encoded array still throws");
  {
    let threw = false;
    try {
      transformToolCallArgs("call_tool_read", {
        name: "server:tool",
        args: JSON.stringify(JSON.stringify([1, 2, 3])), // double-encoded array
      });
    } catch (err) {
      threw = true;
    }
    assert(threw, "Double-encoded array still rejected");
  }
}

// ---------------------------------------------------------------------------
// Layer 2: E2E tests — full shim round-trip via stdio
// ---------------------------------------------------------------------------

function createShimProcess() {
  const child = spawn("node", [SHIM_PATH], {
    env: { ...process.env, MCP_URL: process.env.MCP_URL },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let reqId = 0;
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
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
      } catch { /* skip */ }
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[shim] ${chunk}`);
  });

  function send(method, params, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      const msg = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout on ${method} id=${id}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(msg);
    });
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  return { send, notify, kill: () => child.kill("SIGTERM"), process: child };
}

function parseContent(result) {
  if (result?.content?.[0]?.text) {
    try { return JSON.parse(result.content[0].text); }
    catch { return result.content[0].text; }
  }
  return result;
}

async function e2eTests() {
  console.log("\n=== LAYER 2: E2E Tests (full shim round-trip) ===\n");

  if (!process.env.MCP_URL) {
    console.log("  ⏭️  Skipped — MCP_URL not set. Set MCP_URL to run E2E tests.\n");
    return;
  }

  const shim = createShimProcess();

  try {
    // Initialize
    console.log("Initializing shim...");
    await shim.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "issue-7-test", version: "1.0" },
    });
    shim.notify("notifications/initialized", {});
    await new Promise((r) => setTimeout(r, 1000));

    // Discover a tool to test against
    const toolName = process.env.E2E_TOOL_NAME;
    const toolArgsRaw = process.env.E2E_TOOL_ARGS;

    if (toolName && toolArgsRaw) {
      // Targeted E2E: user specified the tool and args
      console.log(`\nTargeted E2E: ${toolName}`);

      const toolArgs = JSON.parse(toolArgsRaw);

      // Test A: Normal object args
      console.log("\nTest E2E-A: Object args (should work)");
      {
        const resp = await shim.send("tools/call", {
          name: "call_tool_destructive",
          arguments: { name: toolName, args: toolArgs },
        });
        const result = parseContent(resp.result);
        const hasError = typeof result === "string" && result.includes("Invalid args_json");
        assert(!hasError, "Object args succeeded", hasError ? result.slice(0, 200) : undefined);
      }

      // Test B: String args (Issue #7 — multiline)
      console.log("\nTest E2E-B: Pretty-printed string args (Issue #7)");
      {
        const prettyArgs = JSON.stringify(toolArgs, null, 2);
        const resp = await shim.send("tools/call", {
          name: "call_tool_destructive",
          arguments: { name: toolName, args: prettyArgs },
        });
        const result = parseContent(resp.result);
        const hasError = typeof result === "string" && result.includes("Invalid args_json");
        assert(!hasError, "Pretty-printed string args succeeded", hasError ? result.slice(0, 200) : undefined);
      }

      // Test C: Double-encoded string args (worst case)
      console.log("\nTest E2E-C: Double-encoded string args");
      {
        const doubleEncoded = JSON.stringify(JSON.stringify(toolArgs));
        const resp = await shim.send("tools/call", {
          name: "call_tool_destructive",
          arguments: { name: toolName, args: doubleEncoded },
        });
        const result = parseContent(resp.result);
        const hasError = typeof result === "string" && result.includes("Invalid args_json");
        assert(!hasError, "Double-encoded string args succeeded", hasError ? result.slice(0, 200) : undefined);
      }
    } else {
      // Generic E2E: use retrieve_tools to find something read-only
      console.log("No E2E_TOOL_NAME set — running generic read-only E2E test");

      // Test with a simple tool call using multiline string args
      console.log("\nTest E2E-Generic: call_tool_read with pretty-printed string args");
      {
        const prettyArgs = JSON.stringify({}, null, 2); // "{}" pretty-printed is still "{}"
        const resp = await shim.send("tools/call", {
          name: "call_tool_read",
          arguments: {
            name: "retrieve_tools",
            args: prettyArgs, // string arg
          },
        });
        // We just check it doesn't fail with args_json errors
        const result = resp.result;
        const text = result?.content?.[0]?.text || "";
        const hasArgsError = text.includes("Invalid args_json");
        assert(!hasArgsError, "Pretty-printed string args didn't cause args_json error");
      }
    }
  } finally {
    shim.kill();
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Issue #7: Multiline Args Double-Encoding Fix ===");
  console.log("https://github.com/luutuankiet/mcp-proxy-shim/issues/7\n");

  await unitTests();
  await e2eTests();

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
