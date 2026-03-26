#!/usr/bin/env node
/**
 * Reproduction script for GitHub Issue #1:
 * 1. describe_tools name resolution fails for tools that retrieve_tools finds
 * 2. Intermittent args_json serialization errors
 *
 * Spawns the shim as a child process via stdio, sends JSON-RPC messages,
 * and checks results.
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = join(__dirname, "..", "dist", "index.js");

const MCP_URL = process.env.MCP_URL;
if (!MCP_URL) {
  console.error("Fatal: MCP_URL environment variable is required.");
  console.error("Example: MCP_URL='https://your-proxy/mcp/?apikey=KEY' node test/repro-issues.mjs");
  process.exit(1);
}

let reqId = 0;

function createShimProcess() {
  const child = spawn("node", [SHIM_PATH], {
    env: { ...process.env, MCP_URL },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    // JSON-RPC messages are newline-delimited
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        // not JSON, skip
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[shim-stderr] ${chunk}`);
  });

  async function send(method, params) {
    const id = ++reqId;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, 30_000);
      pending.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      child.stdin.write(msg);
    });
  }

  async function notify(method, params) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    child.stdin.write(msg);
  }

  function kill() {
    child.kill("SIGTERM");
  }

  return { send, notify, kill, process: child };
}

function parseContent(result) {
  if (result?.content?.[0]?.text) {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text;
    }
  }
  return result;
}

async function main() {
  console.log("=== Issue #1 & #2 Reproduction Script ===\n");
  console.log(`MCP_URL: ${MCP_URL.replace(/apikey=[^&\s]+/gi, "apikey=***")}\n`);

  const shim = createShimProcess();

  // Wait for shim to initialize
  console.log("Initializing shim connection...");
  const initResp = await shim.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "repro-test", version: "1.0" },
  });
  console.log("Init response:", initResp.result ? "OK" : "FAILED");
  await shim.notify("notifications/initialized", {});

  // Give it a moment
  await new Promise((r) => setTimeout(r, 1000));

  // =========================================================================
  // ISSUE 1: describe_tools name resolution
  // =========================================================================
  console.log("\n--- ISSUE 1: describe_tools name resolution ---\n");

  // Step 1: retrieve_tools to discover tools
  console.log("Step 1: Calling retrieve_tools to discover tools...");
  const retrieveResp = await shim.send("tools/call", {
    name: "retrieve_tools",
    arguments: { query: "github get file contents read repository" },
  });
  const retrieveResult = parseContent(retrieveResp.result);
  const tools = Array.isArray(retrieveResult)
    ? retrieveResult
    : retrieveResult?.tools || [];

  console.log(`  Found ${tools.length} tools:`);
  const toolNames = tools.slice(0, 10).map((t) => t.name);
  for (const t of tools.slice(0, 10)) {
    console.log(`    - ${t.name} (server: ${t.server})`);
  }

  // Step 2: describe_tools with those exact names
  if (toolNames.length > 0) {
    console.log(`\nStep 2: Calling describe_tools with ${toolNames.length} names...`);
    const describeResp = await shim.send("tools/call", {
      name: "describe_tools",
      arguments: { names: toolNames },
    });
    const describeResult = parseContent(describeResp.result);

    let found = 0;
    let notFound = 0;
    const failures = [];

    if (Array.isArray(describeResult)) {
      for (const r of describeResult) {
        if (r.error === "not found") {
          notFound++;
          failures.push(r.name);
        } else {
          found++;
        }
      }
    }

    console.log(`\n  Results: ${found} found, ${notFound} NOT FOUND`);
    if (failures.length > 0) {
      console.log(`  ISSUE 1 REPRODUCED! Failed tools:`);
      for (const f of failures) {
        console.log(`    - ${f}`);
      }
    } else {
      console.log(`  All tools resolved successfully (issue may not reproduce with this query)`);
    }

    // Try with more diverse tools — filesystem tools with mount paths
    console.log("\n  Trying with filesystem/mount-path tools...");
    const fsRetrieve = await shim.send("tools/call", {
      name: "retrieve_tools",
      arguments: { query: "read files edit files run command filesystem" },
    });
    const fsResult = parseContent(fsRetrieve.result);
    const fsTools = Array.isArray(fsResult)
      ? fsResult
      : fsResult?.tools || [];
    const fsNames = fsTools.slice(0, 10).map((t) => t.name);

    if (fsNames.length > 0) {
      console.log(`  Found ${fsNames.length} filesystem tools:`);
      for (const n of fsNames) {
        console.log(`    - ${n}`);
      }

      const fsDescribe = await shim.send("tools/call", {
        name: "describe_tools",
        arguments: { names: fsNames },
      });
      const fsDescResult = parseContent(fsDescribe.result);

      let fsFound = 0;
      let fsNotFound = 0;
      const fsFailures = [];

      if (Array.isArray(fsDescResult)) {
        for (const r of fsDescResult) {
          if (r.error === "not found") {
            fsNotFound++;
            fsFailures.push(r.name);
          } else {
            fsFound++;
          }
        }
      }

      console.log(`\n  Results: ${fsFound} found, ${fsNotFound} NOT FOUND`);
      if (fsFailures.length > 0) {
        console.log(`  ISSUE 1 REPRODUCED! Failed tools:`);
        for (const f of fsFailures) {
          console.log(`    - ${f}`);
        }
      }
    }
  }

  // =========================================================================
  // ISSUE 2: args_json serialization
  // =========================================================================
  console.log("\n\n--- ISSUE 2: args_json serialization ---\n");

  // Test with simple args — rapid fire
  console.log("Test 2a: Rapid-fire call_tool_read with simple args (5x)...");
  const simpleResults = [];
  for (let i = 0; i < 5; i++) {
    try {
      const resp = await shim.send("tools/call", {
        name: "call_tool_read",
        arguments: {
          name: "utils:github__get_me",
          args: {},
        },
      });
      const result = parseContent(resp.result);
      const hasError =
        typeof result === "string" && result.includes("Invalid args_json");
      simpleResults.push({ attempt: i + 1, error: hasError, result: hasError ? result : "OK" });
      if (hasError) {
        console.log(`  Attempt ${i + 1}: FAILED — ${result.slice(0, 100)}`);
      } else {
        console.log(`  Attempt ${i + 1}: OK`);
      }
    } catch (err) {
      console.log(`  Attempt ${i + 1}: ERROR — ${err.message}`);
      simpleResults.push({ attempt: i + 1, error: true, result: err.message });
    }
  }

  const simpleFailures = simpleResults.filter((r) => r.error).length;
  if (simpleFailures > 0) {
    console.log(`\n  ISSUE 2 REPRODUCED! ${simpleFailures}/5 calls failed with simple args`);
  }

  // Test with pre-serialized string args (double-serialization edge case)
  console.log("\nTest 2b: call_tool_read with pre-serialized string args...");
  try {
    const resp = await shim.send("tools/call", {
      name: "call_tool_read",
      arguments: {
        name: "utils:github__get_me",
        args: JSON.stringify({}), // args is a string, not object — triggers double-serialization
      },
    });
    const result = parseContent(resp.result);
    const hasError =
      typeof result === "string" && result.includes("Invalid args_json");
    if (hasError) {
      console.log(`  ISSUE 2 REPRODUCED! Pre-serialized string args caused: ${result.slice(0, 150)}`);
    } else {
      console.log(`  Result: OK (no double-serialization issue)`);
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }

  // Test with complex string args (heredoc-like content)
  console.log("\nTest 2c: call_tool_destructive with complex string content in args...");
  try {
    const complexArgs = {
      name: "utils:github__get_file_contents",
      args: {
        owner: "luutuankiet",
        repo: "mcp-proxy-shim",
        path: "README.md",
      },
    };
    const resp = await shim.send("tools/call", {
      name: "call_tool_destructive",
      arguments: complexArgs,
    });
    const result = parseContent(resp.result);
    const hasError =
      typeof result === "string" && result.includes("Invalid args_json");
    if (hasError) {
      console.log(`  ISSUE 2 REPRODUCED! Complex args caused: ${result.slice(0, 150)}`);
    } else {
      console.log(`  Result: OK`);
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log("\n\n=== REPRODUCTION SUMMARY ===\n");
  console.log("Issue 1 (describe_tools): Check output above for 'NOT FOUND' entries");
  console.log("Issue 2 (args_json):      Check output above for 'REPRODUCED' entries");

  shim.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
