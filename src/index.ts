#!/usr/bin/env node
/**
 * MCP Stdio Shim
 *
 * A schema-transforming MCP proxy that sits between Claude Code (stdio)
 * and mcpproxy-go (StreamableHTTP).
 *
 * What it does:
 *   - Passes through ALL upstream tools unchanged (retrieve_tools, upstream_servers, etc.)
 *   - Transforms call_tool_read / call_tool_write / call_tool_destructive schemas:
 *     upstream args_json:string → downstream args:object
 *   - On tool call: serializes args back to args_json before forwarding upstream
 *
 * Why not use SDK StreamableHTTPClientTransport:
 *   - Bug #396: 2nd callTool times out (broken session multiplexing)
 *   - We use plain fetch for upstream — reliable, simple, zero SDK client bugs
 *
 * Why low-level Server class (not McpServer):
 *   - Bug #893: McpServer.registerTool() breaks dynamic registration post-connect
 *   - Low-level Server.setRequestHandler() works correctly
 *
 * Usage:
 *   MCP_URL="https://proxy.example.com/mcp/?apikey=KEY" npx @luutuankiet/mcp-proxy-shim
 *
 * .mcp.json entry:
 *   { "mcpServers": { "proxy": { "type": "stdio", "command": "npx", "args": ["-y", "@luutuankiet/mcp-proxy-shim"], "env": { "MCP_URL": "..." } } } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Proxy support — Node 22 built-in undici honors https_proxy via ProxyAgent
// This makes the shim work in both native sessions (no proxy) and cloud sandboxes
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const { ProxyAgent } = _require("undici") as { ProxyAgent: new (url: string) => object };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const UPSTREAM_URL = process.env.MCP_URL ?? (() => {
  console.error("[mcp-shim] Fatal: MCP_URL environment variable is required.");
  console.error("[mcp-shim] Example: MCP_URL='https://your-proxy/mcp/?apikey=KEY' mcp-proxy-shim");
  process.exit(1);
})() as never;

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

// Auto-detect HTTPS proxy from environment
const PROXY_URL = process.env.https_proxy || process.env.HTTPS_PROXY || "";
const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

// Tools whose schemas get transformed (args_json:string → args:object)
const CALL_TOOL_NAMES = new Set([
  "call_tool_read",
  "call_tool_write",
  "call_tool_destructive",
]);

// ---------------------------------------------------------------------------
// Shim-local tools (not forwarded upstream)
// ---------------------------------------------------------------------------

/**
 * describe_tools — batch-hydrate compact retrieve_tools results.
 *
 * Workflow: retrieve_tools (compact) → scan names → describe_tools (full schemas)
 * Zero network cost — reads from cached upstream tool list.
 *
 * Named for Claude Code lazy-load discovery: an agent that only sees the tool
 * name should immediately understand "this gives me full tool descriptions".
 */
const DESCRIBE_TOOLS_SCHEMA: ToolSchema = {
  name: "describe_tools",
  description:
    "Get full schemas for specific tools by name. Use after retrieve_tools to hydrate " +
    "compact results with complete inputSchema and descriptions. Accepts multiple tool " +
    "names for token-efficient batch lookup.",
  inputSchema: {
    type: "object",
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
        description:
          "Tool names to describe — use the 'name' field from retrieve_tools results",
      },
    },
    required: ["names"],
  },
};

// ---------------------------------------------------------------------------
// Upstream MCP session (manual HTTP — avoids SDK client bugs)
// ---------------------------------------------------------------------------

let sessionId: string | null = null;
let reqId = 0;

function log(...args: unknown[]) {
  // stderr only — stdout is the stdio transport
  console.error("[mcp-shim]", ...args);
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Send a JSON-RPC request/notification to upstream mcpproxy-go.
 * Handles session header, timeouts, and basic retry on transient failures.
 */
async function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  isNotification = false,
): Promise<JsonRpcResponse | null> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (!isNotification) {
    body.id = ++reqId;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // AbortSignal.timeout is self-cleaning (no timer leak on fetch failure)
      const fetchOpts: RequestInit & { dispatcher?: object } = {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      };
      if (proxyDispatcher) {
        fetchOpts.dispatcher = proxyDispatcher;
      }

      const resp = await fetch(UPSTREAM_URL, fetchOpts as RequestInit);

      // Capture session ID from response headers
      const sid = resp.headers.get("mcp-session-id");
      if (sid) sessionId = sid;

      // Notifications get 202 with no body
      if (isNotification || resp.status === 202) {
        return null;
      }

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `Upstream HTTP ${resp.status}: ${text.slice(0, 500)}`,
        );
      }

      // Handle SSE vs JSON response
      const contentType = resp.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream")) {
        // StreamableHTTP can return SSE — collect all data events
        return await parseSseResponse(resp);
      }

      return (await resp.json()) as JsonRpcResponse;
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * 2 ** attempt; // 1s, 2s
        log(`Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms:`, lastError.message);
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error("mcpRequest failed");
}

/**
 * Parse an SSE response stream and extract the JSON-RPC result.
 * StreamableHTTP servers may respond with SSE for long-running operations.
 */
async function parseSseResponse(resp: Response): Promise<JsonRpcResponse> {
  const text = await resp.text();
  const lines = text.split("\n");
  let lastData: string | null = null;

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      lastData = line.slice(6);
    }
  }

  if (lastData) {
    try {
      return JSON.parse(lastData) as JsonRpcResponse;
    } catch {
      // fall through
    }
  }

  throw new Error("No valid JSON-RPC response in SSE stream");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Upstream session lifecycle
// ---------------------------------------------------------------------------

async function initUpstream(): Promise<void> {
  log("Initializing upstream session...");

  const resp = await mcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-stdio-shim", version: "1.0.0" },
  });

  if (!sessionId) {
    throw new Error("No session ID received from upstream after initialize");
  }

  log("Session ID:", sessionId.slice(0, 12) + "...");

  // Send initialized notification (MCP spec requirement)
  await mcpRequest("notifications/initialized", {}, true);
}

async function ensureSession(): Promise<void> {
  if (!sessionId) {
    await initUpstream();
  }
}

/**
 * Re-initialize on session expiry (e.g., upstream restart).
 * Returns true if re-init succeeded.
 */
async function reinitOnExpiry(): Promise<boolean> {
  log("Session may have expired — re-initializing...");
  sessionId = null;
  try {
    await initUpstream();
    return true;
  } catch (err) {
    log("Re-init failed:", (err as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Schema transformation
// ---------------------------------------------------------------------------

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

/**
 * Transform call_tool_* schemas: replace args_json:string with args:object.
 * All other tools pass through unchanged.
 */
function transformToolSchema(tool: ToolSchema): ToolSchema {
  if (!CALL_TOOL_NAMES.has(tool.name)) return tool;
  if (!tool.inputSchema?.properties) return tool;

  const props = { ...tool.inputSchema.properties };

  // Only transform if args_json exists
  if (!("args_json" in props)) return tool;

  // Remove args_json, add args:object
  delete props.args_json;
  props.args = {
    type: "object",
    description:
      "Tool arguments as a native JSON object. The shim serializes this to args_json before forwarding upstream.",
    additionalProperties: true,
  };

  // Update required array
  let required = tool.inputSchema.required;
  if (required) {
    required = required.map((r) => (r === "args_json" ? "args" : r));
  }

  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: props,
      ...(required ? { required } : {}),
    },
  };
}

/**
 * On tool call: if it's a call_tool_*, serialize the args object back to
 * args_json string before forwarding upstream.
 */
function transformToolCallArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!CALL_TOOL_NAMES.has(toolName)) return args;

  // If caller already sent args_json (backward compat), pass through
  if ("args_json" in args) return args;

  // Transform: args → args_json
  if ("args" in args) {
    const { args: argsObj, ...rest } = args;
    return {
      ...rest,
      args_json: JSON.stringify(argsObj),
    };
  }

  return args;
}

// ---------------------------------------------------------------------------
// Response unwrapping (deep, recursive)
// ---------------------------------------------------------------------------

/**
 * Detect MCP content wrapper shape: {content: [{type: "text", text: "..."}]}
 */
function isMcpContentWrapper(obj: unknown): obj is { content: Array<{ type: string; text: string }> } {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.content) || o.content.length === 0) return false;
  const first = o.content[0] as Record<string, unknown>;
  return first?.type === "text" && typeof first?.text === "string";
}

/**
 * Recursively unwrap a single text value.
 * Keeps parsing until it's no longer a JSON string or an MCP content wrapper.
 */
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
        return parsed.content.map((c: { type: string; text: string }) =>
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

/**
 * Unwrap an MCP result object to its deepest payload.
 */
function deepUnwrapResult(result: unknown): unknown {
  if (!isMcpContentWrapper(result)) return result;
  if (result.content.length === 1) {
    return deepParseText(result.content[0].text);
  }
  return result.content.map((c: { type: string; text: string }) =>
    c.type === "text" ? deepParseText(c.text) : c,
  );
}

/**
 * Unwrap then re-wrap for MCP protocol compliance.
 * The shim must return valid {content: [{type: "text", text: "..."}]} to Claude.
 */
function unwrapAndRewrap(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  const unwrapped = deepUnwrapResult(result);
  // If it's already a content wrapper with no further nesting, return as-is
  if (isMcpContentWrapper(unwrapped)) {
    return unwrapped as { content: Array<{ type: "text"; text: string }> };
  }
  const text = typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped);
  return { content: [{ type: "text", text }] };
}

/**
 * Smart compaction for retrieve_tools responses.
 * When payload > 5KB and compact !== false, strip inputSchema to save tokens.
 */
function compactRetrieveTools(
  unwrapped: unknown,
  args: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const compact = args.compact !== false; // default true
  const limit = typeof args.limit === "number" ? args.limit : 0;

  let result = unwrapped as Record<string, unknown>;
  // retrieve_tools may return {query, tools[], total} or a raw array
  let tools: unknown[] | undefined = Array.isArray(result)
    ? result
    : (result && Array.isArray(result.tools) ? result.tools as unknown[] : undefined);

  let wasCompacted = false;
  if (compact && tools) {
    const fullJson = JSON.stringify(tools);
    if (fullJson.length > 5000) {
      wasCompacted = true;
      tools = tools.map((t: unknown) => {
        const tool = t as Record<string, unknown>;
        return {
          server: tool.server,
          name: tool.name,
          call_with: tool.call_with,
          description: typeof tool.description === "string"
            ? tool.description.slice(0, 100) + (tool.description.length > 100 ? "..." : "")
            : undefined,
        };
      });
    }
  }
  if (limit > 0 && tools) {
    tools = tools.slice(0, limit);
  }
  // Reconstruct the result with compacted tools
  let output: unknown;
  if (Array.isArray(result)) {
    output = tools || result;
  } else if (result && typeof result === "object" && tools) {
    output = {
      ...result,
      tools,
      // When compacted, tell the agent how to get full schemas
      ...(wasCompacted ? {
        note: "Results are compacted (inputSchema stripped). Before calling a tool, use describe_tools({names: [tool.name]}) to get the full inputSchema and avoid parameter errors.",
      } : {}),
    };
  } else {
    output = unwrapped;
  }
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Upstream tool list (cached, refreshed on tools/list)
// ---------------------------------------------------------------------------

let cachedTools: ToolSchema[] | null = null;

async function fetchUpstreamTools(): Promise<ToolSchema[]> {
  await ensureSession();

  const resp = await mcpRequest("tools/list", {});
  if (!resp || resp.error) {
    throw new Error(
      `Failed to list upstream tools: ${JSON.stringify(resp?.error || "no response")}`,
    );
  }

  const result = resp.result as { tools?: ToolSchema[] } | undefined;
  const tools = result?.tools || [];
  log(`Fetched ${tools.length} upstream tools`);

  return tools;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Mask credentials in log output (apikey params, proxy auth)
  const maskUrl = (url: string) => url.replace(/apikey=[^&\s]+/gi, "apikey=***").replace(/\/\/[^@]*@/, "//***@");
  log("Upstream:", maskUrl(UPSTREAM_URL));
  if (proxyDispatcher) {
    log("Using HTTPS proxy:", maskUrl(PROXY_URL));
  }

  // 1. Connect upstream
  await initUpstream();

  // 2. Fetch initial tool list
  cachedTools = await fetchUpstreamTools();
  const transformed = cachedTools.map(transformToolSchema);

  const callToolCount = transformed.filter((t) =>
    CALL_TOOL_NAMES.has(t.name),
  ).length;
  log(
    `Ready: ${transformed.length} tools (${callToolCount} with schema transform)`,
  );

  // 3. Create downstream stdio MCP server
  const server = new Server(
    { name: "mcp-stdio-shim", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Handle tools/list — return transformed schemas
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Refresh tool list on each request — upstream may have changed
    // (dynamic server management via /mcp/call mode)
    try {
      cachedTools = await fetchUpstreamTools();
    } catch (err) {
      log("Tool refresh failed, using cached:", (err as Error).message);
      // Fall back to cached if refresh fails
      if (!cachedTools) throw err;
    }

    return {
      tools: [
        ...cachedTools.map(transformToolSchema),
        DESCRIBE_TOOLS_SCHEMA, // shim-local: always present
      ],
    };
  });

  // Handle tools/call — transform args and forward upstream
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // --- Shim-local: describe_tools ---
    // Hydrates compact retrieve_tools results with full schemas.
    // Must query upstream retrieve_tools (not tools/list) because remote tools
    // like "github__create_or_update_file" are only in the upstream search index.
    if (name === "describe_tools") {
      const names = (args?.names ?? []) as string[];
      if (!Array.isArray(names) || names.length === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "names array is required" }) }],
          isError: true,
        };
      }

      await ensureSession();

      // Derive BM25 search queries from tool names.
      // e.g. "github__create_or_update_file" → "create or update file"
      const nameSet = new Set(names);
      const queries = new Set<string>();
      for (const n of nameSet) {
        const parts = n.split("__");
        const toolPart = parts[parts.length - 1] || n;
        queries.add(toolPart.replace(/_/g, " "));
      }

      // Fetch full tool entries from upstream (no compaction applied)
      const index = new Map<string, ToolSchema>();
      for (const query of queries) {
        try {
          log("describe_tools: querying upstream retrieve_tools with:", query);
          const resp = await mcpRequest("tools/call", {
            name: "retrieve_tools",
            arguments: { query },
          });
          log("describe_tools: resp exists:", !!resp, "resp.result exists:", !!resp?.result);
          if (resp?.result) {
            const unwrapped = deepUnwrapResult(resp.result);
            log("describe_tools: unwrapped type:", typeof unwrapped, "isArray:", Array.isArray(unwrapped));
            if (unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)) {
              log("describe_tools: unwrapped keys:", Object.keys(unwrapped as Record<string, unknown>).join(", "));
            }
            const result = unwrapped as Record<string, unknown>;
            const tools: unknown[] = Array.isArray(result)
              ? result
              : (result && Array.isArray(result.tools) ? result.tools as unknown[] : []);
            log("describe_tools: found", tools.length, "tools from query");
            for (const t of tools) {
              const tool = t as ToolSchema;
              if (tool.name && !index.has(tool.name)) {
                index.set(tool.name, tool);
              }
            }
          }
        } catch (err) {
          log("describe_tools query failed:", query, (err as Error).message);
        }
      }
      log("describe_tools: index has", index.size, "tools, looking up:", names.join(", "));

      // Look up each requested tool — return full schema (with transform applied)
      const results = names.map((n) => {
        const tool = index.get(n);
        if (!tool) return { name: n, error: "not found" };
        return transformToolSchema(tool);
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results) }],
      };
    }

    const forwardArgs = transformToolCallArgs(name, args || {});

    try {
      await ensureSession();

      const resp = await mcpRequest("tools/call", {
        name,
        arguments: forwardArgs,
      });

      if (!resp) {
        return {
          content: [{ type: "text" as const, text: "No response from upstream" }],
          isError: true,
        };
      }

      if (resp.error) {
        // Check for session-expired errors
        if (
          resp.error.message?.includes("session") ||
          resp.error.message?.includes("Session") ||
          resp.error.code === -32001
        ) {
          const ok = await reinitOnExpiry();
          if (ok) {
            // Retry once with new session
            const retry = await mcpRequest("tools/call", {
              name,
              arguments: forwardArgs,
            });
            if (retry && !retry.error) {
              if (name === "retrieve_tools") {
                return compactRetrieveTools(deepUnwrapResult(retry.result), args || {});
              }
              return unwrapAndRewrap(retry.result);
            }
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(resp.error),
            },
          ],
          isError: true,
        };
      }

      // Deep unwrap + re-wrap for clean responses
      if (name === "retrieve_tools") {
        return compactRetrieveTools(deepUnwrapResult(resp.result), args || {});
      }
      return unwrapAndRewrap(resp.result);
    } catch (err) {
      const msg = (err as Error).message;
      log("Tool call error:", name, msg);

      // Attempt re-init on network errors
      if (msg.includes("fetch") || msg.includes("abort") || msg.includes("ECONNR")) {
        await reinitOnExpiry();
      }

      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  // 4. Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("Stdio transport connected — shim is live");
}

main().catch((err) => {
  log("Fatal:", err);
  process.exit(1);
});
