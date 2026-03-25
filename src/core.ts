/**
 * MCP Proxy Shim — Shared Core
 *
 * Contains all upstream session management, schema transformation,
 * response unwrapping, and tool handling logic shared between
 * stdio and HTTP server entry points.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Proxy support — Node 22 built-in undici honors https_proxy via ProxyAgent
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const { ProxyAgent } = _require("undici") as { ProxyAgent: new (url: string) => object };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const UPSTREAM_URL = process.env.MCP_URL ?? (() => {
  console.error("[mcp-shim] Fatal: MCP_URL environment variable is required.");
  console.error("[mcp-shim] Example: MCP_URL='https://your-proxy/mcp/?apikey=KEY' mcp-proxy-shim");
  process.exit(1);
})() as never;

export const REQUEST_TIMEOUT_MS = 120_000;
export const MAX_RETRIES = 2;

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

export function log(...args: unknown[]) {
  // stderr only — stdout is the stdio transport
  console.error("[mcp-shim]", ...args);
}

/** Mask credentials in log output */
export function maskUrl(url: string) {
  return url.replace(/apikey=[^&\s]+/gi, "apikey=***").replace(/\/\/[^@]*@/, "//***@");
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

export async function ensureSession(): Promise<void> {
  if (!sessionId) {
    await initUpstream();
  }
}

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

export interface ToolSchema {
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

function transformToolSchema(tool: ToolSchema): ToolSchema {
  if (!CALL_TOOL_NAMES.has(tool.name)) return tool;
  if (!tool.inputSchema?.properties) return tool;

  const props = { ...tool.inputSchema.properties };

  if (!("args_json" in props)) return tool;

  delete props.args_json;
  props.args = {
    type: "object",
    description:
      "Tool arguments as a native JSON object. The shim serializes this to args_json before forwarding upstream.",
    additionalProperties: true,
  };

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
 * Ensure a value is a JSON string representing an object (not a primitive).
 * The upstream Go server expects args_json to unmarshal into map[string]interface{}.
 * If the value is a primitive JSON string (e.g., "true", "42", '"hello"'),
 * wrap it in an object to prevent Go unmarshal errors.
 */
function ensureJsonObjectString(jsonStr: string): string {
  try {
    const parsed = JSON.parse(jsonStr);
    // Must be a non-null object (not array, not primitive)
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return jsonStr;
    }
    // It's valid JSON but not an object — this would cause
    // "cannot unmarshal X into Go value of type map[string]interface{}"
    // Fall through to return empty object as safe default
    log("args_json is valid JSON but not an object, wrapping:", jsonStr.slice(0, 100));
  } catch {
    // Not valid JSON at all — log and use empty object
    log("args_json is not valid JSON, using empty object. Input:", jsonStr.slice(0, 100));
  }
  return "{}";
}

function transformToolCallArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!CALL_TOOL_NAMES.has(toolName)) return args;

  if ("args_json" in args) {
    // Backward compat: if args_json is already present, ensure it's a string.
    const existing = args.args_json;
    if (typeof existing === "string") {
      return { ...args, args_json: ensureJsonObjectString(existing) };
    }
    // If it's an object (shouldn't happen but defensive), stringify it.
    if (existing !== null && existing !== undefined && typeof existing === "object") {
      return { ...args, args_json: JSON.stringify(existing) };
    }
    // Primitive or nullish — use empty object
    return { ...args, args_json: "{}" };
  }

  if ("args" in args) {
    const { args: argsObj, ...rest } = args;
    let argsJson: string;

    if (argsObj === null || argsObj === undefined) {
      // Nullish args — safe default to empty object
      argsJson = "{}";
    } else if (typeof argsObj === "string") {
      // args is already a pre-serialized JSON string — validate it's an object
      // to avoid double-serialization AND ensure upstream Go can unmarshal it.
      argsJson = ensureJsonObjectString(argsObj);
    } else if (typeof argsObj === "object") {
      argsJson = JSON.stringify(argsObj);
    } else {
      // Primitive (boolean, number) — not a valid args object
      log("args is a primitive, using empty object. Type:", typeof argsObj);
      argsJson = "{}";
    }

    return {
      ...rest,
      args_json: argsJson,
    };
  }

  return args;
}

// ---------------------------------------------------------------------------
// Response unwrapping (deep, recursive)
// ---------------------------------------------------------------------------

function isMcpContentWrapper(obj: unknown): obj is { content: Array<{ type: string; text: string }> } {
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

function deepUnwrapResult(result: unknown): unknown {
  if (!isMcpContentWrapper(result)) return result;
  if (result.content.length === 1) {
    return deepParseText(result.content[0].text);
  }
  return result.content.map((c: { type: string; text: string }) =>
    c.type === "text" ? deepParseText(c.text) : c,
  );
}

function unwrapAndRewrap(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  const unwrapped = deepUnwrapResult(result);
  if (isMcpContentWrapper(unwrapped)) {
    return unwrapped as { content: Array<{ type: "text"; text: string }> };
  }
  const text = typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped);
  return { content: [{ type: "text", text }] };
}

function compactRetrieveTools(
  unwrapped: unknown,
  args: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const compact = args.compact !== false;
  const limit = typeof args.limit === "number" ? args.limit : 0;

  let result = unwrapped as Record<string, unknown>;
  let tools: unknown[] | undefined = Array.isArray(result)
    ? result
    : (result && Array.isArray(result.tools) ? result.tools as unknown[] : undefined);

  // Populate persistent schema cache with full tool data before compacting
  if (tools) {
    cacheToolSchemas(tools);
  }

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
  let output: unknown;
  if (Array.isArray(result)) {
    output = tools || result;
  } else if (result && typeof result === "object" && tools) {
    output = {
      ...result,
      tools,
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

// ---------------------------------------------------------------------------
// Persistent tool schema cache for describe_tools
// ---------------------------------------------------------------------------
// Accumulates full schemas from every retrieve_tools response so that
// describe_tools can resolve tools by exact name without relying solely
// on BM25 search queries (which may not return all tools).

const toolSchemaCache = new Map<string, ToolSchema>();

/** Index tools into the persistent schema cache. */
function cacheToolSchemas(tools: unknown[]): void {
  for (const t of tools) {
    const tool = t as ToolSchema;
    if (tool.name) {
      toolSchemaCache.set(tool.name, tool);
    }
  }
}

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
// Tool name resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a tool name against an index map, handling server prefixes and
 * suffix matching for mount-path variations.
 */
function resolveToolFromIndex(name: string, index: Map<string, ToolSchema>): ToolSchema | undefined {
  // 1. Exact match
  let tool = index.get(name);
  if (tool) return tool;

  // 2. Try without server prefix (e.g., "utils:bi-platform__query" → "bi-platform__query")
  if (name.includes(":")) {
    const withoutPrefix = name.split(":").slice(1).join(":");
    tool = index.get(withoutPrefix);
    if (tool) return tool;
  }

  // 3. Try suffix/prefix matching — check all indexed tools
  for (const [key, candidate] of index) {
    if (key.endsWith(name) || name.endsWith(key)) {
      return candidate;
    }
  }

  // 4. Fuzzy suffix match — handle mount-path variations
  const nParts = name.includes(":") ? name.split(":").slice(1).join(":").split("__") : name.split("__");
  const nSuffix = nParts[nParts.length - 1];
  if (nSuffix) {
    for (const [, candidate] of index) {
      const cParts = candidate.name.split("__");
      const cSuffix = cParts[cParts.length - 1];
      if (cSuffix === nSuffix && candidate.name.includes(nParts[0])) {
        return candidate;
      }
    }
  }

  return undefined;
}

/**
 * Resolve a tool name against the persistent schema cache.
 * Uses the same resolution strategy as resolveToolFromIndex.
 */
function resolveToolFromCache(name: string): ToolSchema | undefined {
  return resolveToolFromIndex(name, toolSchemaCache);
}

// ---------------------------------------------------------------------------
// Server factory — creates a wired-up MCP Server (transport-agnostic)
// ---------------------------------------------------------------------------

export interface ShimServerOptions {
  /**
   * If true, skip eager upstream initialization. Upstream session will be
   * established lazily on first tool call (via ensureSession).
   * Useful for HTTP server mode where we want the server to start even
   * if upstream is temporarily unavailable.
   */
  lazyInit?: boolean;
}

/**
 * Create and wire up an MCP Server with all shim handlers.
 * Caller connects their chosen transport (stdio or HTTP).
 */
export async function createShimServer(options: ShimServerOptions = {}): Promise<Server> {
  log("Upstream:", maskUrl(UPSTREAM_URL));
  if (proxyDispatcher) {
    log("Using HTTPS proxy:", maskUrl(PROXY_URL));
  }

  if (!options.lazyInit) {
    // Eager init: connect upstream and fetch tools immediately
    await initUpstream();

    cachedTools = await fetchUpstreamTools();
    const transformed = cachedTools.map(transformToolSchema);

    const callToolCount = transformed.filter((t) =>
      CALL_TOOL_NAMES.has(t.name),
    ).length;
    log(
      `Ready: ${transformed.length} tools (${callToolCount} with schema transform)`,
    );
  } else {
    log("Lazy init mode — upstream session will be established on first request");
  }

  // 3. Create MCP server (transport-agnostic)
  const server = new Server(
    { name: "mcp-proxy-shim", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Handle tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      cachedTools = await fetchUpstreamTools();
    } catch (err) {
      log("Tool refresh failed, using cached:", (err as Error).message);
      if (!cachedTools) throw err;
    }

    return {
      tools: [
        ...cachedTools.map(transformToolSchema),
        DESCRIBE_TOOLS_SCHEMA,
      ],
    };
  });

  // Handle tools/call
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // --- Shim-local: describe_tools ---
    if (name === "describe_tools") {
      const names = (args?.names ?? []) as string[];
      if (!Array.isArray(names) || names.length === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "names array is required" }) }],
          isError: true,
        };
      }

      await ensureSession();

      const nameSet = new Set(names);

      // --- Phase 1: Resolve from persistent cache (instant, no upstream calls) ---
      const resolved = new Map<string, ToolSchema>();
      const unresolved = new Set<string>();

      for (const n of nameSet) {
        const tool = resolveToolFromCache(n);
        if (tool) {
          resolved.set(n, tool);
        } else {
          unresolved.add(n);
        }
      }

      if (unresolved.size > 0) {
        log("describe_tools: cache hit", resolved.size, "/ miss", unresolved.size);

        // --- Phase 2: Query upstream retrieve_tools for unresolved names ---
        // Generate multiple search queries per tool name for broader coverage:
        // 1. Raw name as-is (exact match in BM25 — most targeted)
        // 2. Full name with separators → spaces (e.g., "bi-platform query")
        // 3. Last segment only (e.g., "query") as a fallback
        const queries = new Set<string>();
        for (const n of unresolved) {
          // Strip optional "server:" prefix for searching
          const withoutServer = n.includes(":") ? n.split(":").slice(1).join(":") : n;
          // Raw name as-is — BM25 often matches exact tool names better than transformed queries
          queries.add(withoutServer);
          // Full name → spaces (primary query, most specific)
          queries.add(withoutServer.replace(/__/g, " ").replace(/[-_]/g, " "));
          // Last __ segment (fallback, broader)
          const parts = withoutServer.split("__");
          if (parts.length > 1) {
            const toolPart = parts[parts.length - 1] || withoutServer;
            queries.add(toolPart.replace(/[-_]/g, " "));
          }
        }

        const index = new Map<string, ToolSchema>();
        for (const query of queries) {
          try {
            log("describe_tools: querying upstream retrieve_tools with:", query);
            const resp = await mcpRequest("tools/call", {
              name: "retrieve_tools",
              arguments: { query },
            });
            if (resp?.result) {
              const unwrapped = deepUnwrapResult(resp.result);
              const result = unwrapped as Record<string, unknown>;
              const tools: unknown[] = Array.isArray(result)
                ? result
                : (result && Array.isArray(result.tools) ? result.tools as unknown[] : []);
              log("describe_tools: found", tools.length, "tools from query:", query);
              // Populate both the local index and persistent cache
              cacheToolSchemas(tools);
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
        log("describe_tools: index has", index.size, "tools, looking up unresolved:", [...unresolved].join(", "));

        // Try to resolve remaining names from the fresh index
        for (const n of unresolved) {
          const tool = resolveToolFromIndex(n, index) ?? resolveToolFromCache(n);
          if (tool) {
            resolved.set(n, tool);
          }
        }
      } else {
        log("describe_tools: all", resolved.size, "tools resolved from cache");
      }

      const results = names.map((n) => {
        const tool = resolved.get(n);
        if (tool) return transformToolSchema(tool);
        return { name: n, error: "not found" };
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
        if (
          resp.error.message?.includes("session") ||
          resp.error.message?.includes("Session") ||
          resp.error.code === -32001
        ) {
          const ok = await reinitOnExpiry();
          if (ok) {
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

      if (name === "retrieve_tools") {
        // compactRetrieveTools already populates the persistent cache
        return compactRetrieveTools(deepUnwrapResult(resp.result), args || {});
      }
      return unwrapAndRewrap(resp.result);
    } catch (err) {
      const msg = (err as Error).message;
      log("Tool call error:", name, msg);

      if (msg.includes("fetch") || msg.includes("abort") || msg.includes("ECONNR")) {
        await reinitOnExpiry();
      }

      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}
