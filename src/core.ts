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

// TLS: Ensure insecure mode is set when core.ts is imported directly
// (not through index.ts). Covers stdio.ts, http-server.ts direct imports.
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

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

// Response size annotation — raises Claude Code's persistence ceiling.
// Without annotation: Claude Code caps MCP tool results at 50k chars (Vb_=50000).
// With annotation: ceiling rises to min(this value, 500000 chars) (IU6=500000).
// Set MCP_MAX_RESULT_CHARS=0 to disable annotation entirely.
const MAX_RESULT_CHARS = parseInt(process.env.MCP_MAX_RESULT_CHARS || "500000", 10);

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

export const DESCRIBE_TOOLS_SCHEMA: ToolSchema = {
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

export const PROXY_ADMIN_SCHEMA: ToolSchema = {
  name: "proxy_admin",
  description:
    "Manage the upstream MCP proxy — list/add/remove/patch servers, enable/disable/quarantine, " +
    "approve tools, inspect config, search tools, tail logs. Use for blip recovery and server management. " +
    "Supports nested proxy chains via path notation (e.g., server_name: \"thinkpad/personal\").",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["list", "restart", "reconnect", "tail_log", "add", "remove", "patch", "enable", "disable", "quarantine", "unquarantine", "approve_tools", "inspect_config", "inspect_server", "search_tools", "status"],
        description:
          "list: show servers with health status. restart: restart one server. reconnect: reconnect all. " +
          "tail_log: show recent logs. add: add a new server. remove: delete a server. patch: update server config. " +
          "enable/disable: toggle server. quarantine/unquarantine: toggle quarantine. " +
          "approve_tools: approve pending tools. inspect_config: show full config. inspect_server: show server details + tools. " +
          "search_tools: BM25 search the tool index. status: running state.",
      },
      server_name: {
        type: "string",
        description:
          "Server name (required for restart/tail_log/remove/patch/enable/disable/quarantine/unquarantine/approve_tools/inspect_server). " +
          "Path notation for nested proxies: \"thinkpad/personal\" routes through thinkpad's proxy_admin.",
      },
      lines: {
        type: "number",
        description: "Lines to return for tail_log (default: 50, max: 500).",
      },
      recursive: {
        type: "boolean",
        description: "For list: include servers from nested shim-wrapped upstreams.",
      },
      config: {
        type: "object",
        description:
          "Server configuration for add/patch operations. Fields: name, url, command, args, env, headers, " +
          "working_dir, protocol (stdio|http|streamable-http|sse|auto), enabled, quarantined, reconnect_on_use.",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Tool names for approve_tools operation.",
      },
      approve_all: {
        type: "boolean",
        description: "Approve all pending tools (approve_tools operation).",
      },
      query: {
        type: "string",
        description: "Search query for search_tools operation.",
      },
      limit: {
        type: "number",
        description: "Max results for search_tools (default: 10).",
      },
    },
    required: ["operation"],
  },
};

// ---------------------------------------------------------------------------
// Upstream MCP session (manual HTTP — avoids SDK client bugs)
// ---------------------------------------------------------------------------

let sessionId: string | null = null;

/** Expose session ID for daemon health endpoint */
export function getSessionId(): string | null {
  return sessionId;
}

/** Force-reset session (for daemon /reinit endpoint) */
export function resetSessionId(): void {
  sessionId = null;
}
let reqId = 0;

export function log(...args: unknown[]) {
  // stderr only — stdout is the stdio transport
  console.error("[mcp-shim]", ...args);
}

/** Mask credentials in log output */
export function maskUrl(url: string) {
  return url.replace(/apikey=[^&\s]+/gi, "apikey=***").replace(/\/\/[^@]*@/, "//***@");
}

// ---------------------------------------------------------------------------
// Admin API helpers — proxy lifecycle management
// ---------------------------------------------------------------------------

/**
 * Derive the admin API base URL from the upstream MCP_URL.
 * "http://localhost:9999/mcp/?apikey=admin" → "http://localhost:9999/api/v1/"
 */
export function getAdminBaseUrl(): string {
  const url = new URL(UPSTREAM_URL);
  return `${url.origin}/api/v1/`;
}

/**
 * Extract API key from MCP_URL for admin API authentication.
 * Falls back to "admin" — the standard mcpproxy-go default.
 */
function getAdminApiKey(): string {
  try {
    const url = new URL(UPSTREAM_URL);
    return url.searchParams.get("apikey") || "admin";
  } catch {
    return "admin";
  }
}

/**
 * Make an HTTP request to the upstream proxy's admin API.
 * Derives the admin URL from MCP_URL and forwards the API key.
 */
export async function adminRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const baseUrl = getAdminBaseUrl();
  const fullUrl = `${baseUrl}${path}`;
  const apiKey = getAdminApiKey();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  };

  const fetchOpts: RequestInit & { dispatcher?: object } = {
    method,
    headers,
    signal: AbortSignal.timeout(10_000),
    body: body ? JSON.stringify(body) : undefined,
  };
  if (proxyDispatcher) {
    fetchOpts.dispatcher = proxyDispatcher;
  }

  const resp = await fetch(fullUrl, fetchOpts as RequestInit);
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    data = await resp.text();
  }

  return { status: resp.status, data };
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
export async function mcpRequest(
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

export async function reinitOnExpiry(): Promise<boolean> {
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
  let result = tool;

  // --- args_json → args transform (call_tool_* only) ---
  if (CALL_TOOL_NAMES.has(tool.name) && tool.inputSchema?.properties && "args_json" in tool.inputSchema.properties) {
    const props = { ...tool.inputSchema.properties };
    delete props.args_json;
    props.args = {
      type: "object",
      description:
        "The upstream tool's arguments as a native JSON object (not a string). " +
        "IMPORTANT: Must be single-line compact JSON — do not pretty-print with newlines or indentation, " +
        "as the parameter encoding layer may serialize multiline content as a string instead of an object. " +
        "Use describe_tools to get the upstream tool's inputSchema, then pass " +
        "those fields here directly. Example: if the upstream tool expects " +
        '{owner: string, repo: string}, pass args: {"owner": "foo", "repo": "bar"}. ' +
        "Nested strings containing JSON are fine — only the top-level args must be an object.",
      additionalProperties: true,
    };

    let required = tool.inputSchema.required;
    if (required) {
      required = required.map((r) => (r === "args_json" ? "args" : r));
    }

    result = {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: props,
        ...(required ? { required } : {}),
      },
    };
  }

  // --- Response size annotation (all tools) ---
  // Raises Claude Code's persistence ceiling from Vb_=50k to IU6=500k chars.
  // Configurable via MCP_MAX_RESULT_CHARS env var. Set to 0 to disable.
  if (MAX_RESULT_CHARS > 0) {
    const existingMeta = (result._meta ?? {}) as Record<string, unknown>;
    result = {
      ...result,
      _meta: {
        ...existingMeta,
        "anthropic/maxResultSizeChars": MAX_RESULT_CHARS,
      },
    };
  }

  return result;
}

/**
 * Validate and re-serialize a JSON string to canonical form.
 * The upstream Go server expects args_json to unmarshal into map[string]interface{}.
 *
 * CRITICAL: Always re-serializes from the parsed object via JSON.stringify()
 * rather than passing through the raw input string. This prevents failures when
 * args arrives as a pre-serialized string from the LLM with non-canonical
 * escaping, encoding quirks, or formatting that Go's json.Unmarshal rejects.
 * See: https://github.com/luutuankiet/mcp-proxy-shim/issues/1
 *
 * Throws ArgsValidationError on invalid input — never silently drops data.
 */
class ArgsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgsValidationError";
  }
}

function validateAndSerializeArgs(jsonStr: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new ArgsValidationError(
      `args is a string but not valid JSON. The "args" field must be a native JSON object, ` +
      `not a pre-serialized string. Pass args as {"key": "value"}, not as '{"key": "value"}'. ` +
      `Parse error: ${(err as Error).message}. Input (first 200 chars): ${jsonStr.slice(0, 200)}`
    );
  }

  // Defensive unwrapping: if parsed is a string containing a JSON object,
  // unwrap one level. This handles double-encoded args from Claude's tool calling
  // infrastructure when multiline/pretty-printed JSON gets wrapped in string
  // delimiters (e.g., "{\n  \"files\": [...]}" → {files: [...]}).
  // See: https://github.com/luutuankiet/mcp-proxy-shim/issues/7
  if (typeof parsed === "string") {
    try {
      const inner = JSON.parse(parsed);
      if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
        parsed = inner;
      }
    } catch {
      // Not valid JSON inside the string — fall through to error below
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const actualType = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    throw new ArgsValidationError(
      `args must be a JSON object, got ${actualType}. ` +
      `Pass args as {"key": "value"}, not as a primitive or array. ` +
      `Input: ${jsonStr.slice(0, 200)}`
    );
  }

  // Re-serialize from parsed object for canonical JSON.
  // Do NOT return jsonStr directly — the raw string from the LLM may have
  // non-canonical escaping (e.g., \\/ vs /, unicode escapes, whitespace)
  // that Go's json.Unmarshal handles differently than Node's JSON.parse.
  return JSON.stringify(parsed);
}

/**
 * Transform call_tool_* arguments: args:object → args_json:string.
 * Returns the transformed args, or throws ArgsValidationError if
 * the client sends malformed args.
 */
export function transformToolCallArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!CALL_TOOL_NAMES.has(toolName)) return args;

  if ("args_json" in args) {
    // Backward compat: if args_json is already present, ensure it's a string.
    const existing = args.args_json;
    if (typeof existing === "string") {
      return { ...args, args_json: validateAndSerializeArgs(existing) };
    }
    // If it's an object, stringify it.
    if (existing !== null && existing !== undefined && typeof existing === "object") {
      return { ...args, args_json: JSON.stringify(existing) };
    }
    throw new ArgsValidationError(
      `args_json must be a JSON string or object, got ${existing === null ? "null" : typeof existing}. ` +
      `Pass args_json as '{"key": "value"}' (string) or use the "args" field with a native object instead.`
    );
  }

  if ("args" in args) {
    const { args: argsObj, ...rest } = args;
    let argsJson: string;

    if (argsObj === null || argsObj === undefined) {
      // Nullish args — treat as empty object (common for tools with no required params)
      argsJson = "{}";
    } else if (typeof argsObj === "string") {
      // LLM sent args as a pre-serialized string — validate and re-serialize.
      argsJson = validateAndSerializeArgs(argsObj);
    } else if (typeof argsObj === "object" && !Array.isArray(argsObj)) {
      // Happy path: native object → serialize.
      // Nested strings containing JSON are fine — JSON.stringify handles them correctly.
      argsJson = JSON.stringify(argsObj);
    } else {
      const actualType = Array.isArray(argsObj) ? "array" : typeof argsObj;
      throw new ArgsValidationError(
        `args must be a JSON object, got ${actualType}. ` +
        `Pass args as {"key": "value"}. Use describe_tools to get the upstream tool's inputSchema.`
      );
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

export function deepUnwrapResult(result: unknown): unknown {
  if (!isMcpContentWrapper(result)) return result;
  if (result.content.length === 1) {
    return deepParseText(result.content[0].text);
  }
  return result.content.map((c: { type: string; text: string }) =>
    c.type === "text" ? deepParseText(c.text) : c,
  );
}

/**
 * Check if an MCP result contains non-text content blocks (image, audio, etc.).
 * These must be passed through as-is to preserve native rendering for vision-capable clients.
 */
function hasNonTextContent(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.content) || o.content.length === 0) return false;
  return o.content.some((c: unknown) => {
    const item = c as Record<string, unknown>;
    return item?.type && item.type !== "text";
  });
}

/**
 * Convert a value to a structuredContent-compatible JSON object.
 * MCP 2025-03-26+ spec requires structuredContent to be a JSON object.
 * Primitives and arrays are wrapped in { result: value }.
 */
function toStructuredContent(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}

/**
 * Extract structuredContent from an upstream result if present.
 * The upstream (or mcpproxy-go) may already provide structuredContent
 * — we should prefer it over computing our own from the text payload.
 */
function extractUpstreamSC(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const r = result as Record<string, unknown>;
  if (r.structuredContent && typeof r.structuredContent === "object" && !Array.isArray(r.structuredContent)) {
    return r.structuredContent as Record<string, unknown>;
  }
  return undefined;
}

function unwrapAndRewrap(result: unknown): { content: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown> } {
  // Non-text content (ImageContent, AudioContent) — NO structuredContent.
  // Reason: Claude Code sends ONLY structuredContent to the model when present,
  // ignoring the content array. If we add text-only structuredContent here,
  // the model loses access to ImageContent blocks. Model image access > TUI display.
  if (hasNonTextContent(result)) {
    return result as { content: Array<Record<string, unknown>> };
  }

  // Prefer upstream structuredContent if already present (e.g., from a spec-compliant server).
  const upstreamSC = extractUpstreamSC(result);

  const unwrapped = deepUnwrapResult(result);
  const structuredContent = upstreamSC ?? toStructuredContent(unwrapped);

  if (isMcpContentWrapper(unwrapped)) {
    return {
      ...(unwrapped as { content: Array<{ type: "text"; text: string }> }),
      structuredContent,
    };
  }
  const text = typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped);
  return { content: [{ type: "text", text }], structuredContent };
}

export function compactRetrieveTools(
  unwrapped: unknown,
  args: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown> } {
  const compact = args.compact !== false;
  const limit = typeof args.limit === "number" ? args.limit : 0;

  let result = unwrapped as Record<string, unknown>;
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
  return { content: [{ type: "text", text }], structuredContent: toStructuredContent(output) };
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

// ---------------------------------------------------------------------------
// Admin operations — proxy_admin tool implementation
// ---------------------------------------------------------------------------

/**
 * Discover a nested proxy_admin tool for a specific upstream server.
 * Uses retrieve_tools (BM25) which returns server attribution, handling
 * multiple upstreams that expose identically-named "proxy_admin" tools.
 * Returns "server:proxy_admin" format for use with call_tool_read routing.
 */
async function discoverNestedProxyAdmin(serverName: string): Promise<string | null> {
  // Primary: BM25 search with server attribution
  try {
    await ensureSession();
    const resp = await mcpRequest("tools/call", {
      name: "retrieve_tools",
      arguments: { query: `${serverName} proxy_admin`, limit: 10 },
    });
    if (resp?.result) {
      const unwrapped = deepUnwrapResult(resp.result) as Record<string, unknown>;
      const tools: unknown[] = Array.isArray(unwrapped)
        ? unwrapped
        : (Array.isArray(unwrapped?.tools) ? unwrapped.tools as unknown[] : []);

      for (const t of tools) {
        const tool = t as Record<string, unknown>;
        if (tool.name === "proxy_admin" && tool.server === serverName) {
          return `${serverName}:proxy_admin`;
        }
      }
    }
  } catch (err) {
    log("discoverNestedProxyAdmin retrieve_tools failed:", (err as Error).message);
  }

  // Fallback: scan cachedTools for prefixed __proxy_admin naming
  if (!cachedTools) {
    try {
      cachedTools = await fetchUpstreamTools();
    } catch {
      return null;
    }
  }

  for (const tool of cachedTools) {
    if (tool.name === "proxy_admin") continue;
    if (tool.name.endsWith("__proxy_admin") && tool.name.toLowerCase().includes(serverName.toLowerCase())) {
      return tool.name;
    }
  }

  return null;
}

/**
 * Handle a proxy_admin operation. Shared between MCP tool handler and daemon REST.
 */
export async function handleProxyAdminOperation(
  operation: string,
  serverName: string,
  options: {
    lines?: number;
    recursive?: boolean;
    config?: Record<string, unknown>;
    tools?: string[];
    approve_all?: boolean;
    query?: string;
    limit?: number;
  } = {},
): Promise<{ data: unknown; isError?: boolean }> {
  const { lines = 50, recursive = false } = options;

  // P2: Path routing for nested proxy chains
  if (serverName.includes("/") && (operation === "restart" || operation === "tail_log")) {
    const segments = serverName.split("/");
    const targetServer = segments[0];
    const remainingPath = segments.slice(1).join("/");

    const nestedTool = await discoverNestedProxyAdmin(targetServer);
    if (!nestedTool) {
      return {
        data: { error: `No proxy_admin tool found for server "${targetServer}". Is it shim-wrapped?` },
        isError: true,
      };
    }

    await ensureSession();
    const nestedArgs: Record<string, unknown> = { operation, server_name: remainingPath };
    if (lines !== 50) nestedArgs.lines = lines;
    const resp = await mcpRequest("tools/call", {
      name: "call_tool_read",
      arguments: {
        name: nestedTool,
        args_json: JSON.stringify(nestedArgs),
        intent_reason: "Nested proxy_admin routing",
        intent_data_sensitivity: "internal",
      },
    });

    if (!resp || resp.error) {
      return {
        data: { error: "Nested proxy_admin call failed", detail: resp?.error || "no response" },
        isError: true,
      };
    }

    return { data: deepUnwrapResult(resp.result) };
  }

  if (operation === "list") {
    const result = await adminRequest("GET", "servers");
    const output = result.data as Record<string, unknown>;
    const serversRaw = ((output?.data as Record<string, unknown>)?.servers as unknown[]) || [];

    const servers = (serversRaw as Record<string, unknown>[]).map((s) => ({
      name: s.name,
      health: (s.health as Record<string, unknown>)?.summary ?? s.health,
      enabled: s.enabled,
      url: s.url || "(stdio)",
      protocol: s.protocol,
    }));

    // P3: Recursive — walk nested shim-wrapped upstreams
    if (recursive) {
      for (const server of servers) {
        const nestedTool = await discoverNestedProxyAdmin(server.name as string);
        if (nestedTool) {
          try {
            await ensureSession();
            const resp = await mcpRequest("tools/call", {
              name: "call_tool_read",
              arguments: {
                name: nestedTool,
                args_json: JSON.stringify({ operation: "list" }),
                intent_reason: "Recursive proxy_admin list",
                intent_data_sensitivity: "internal",
              },
            });
            if (resp?.result) {
              (server as Record<string, unknown>).nested_servers =
                deepUnwrapResult(resp.result);
              (server as Record<string, unknown>).shim_wrapped = true;
            }
          } catch (err) {
            (server as Record<string, unknown>).nested_error = (err as Error).message;
          }
        }
      }
    }

    return { data: { servers, total: servers.length } };
  }

  if (operation === "restart") {
    if (!serverName) {
      return { data: { error: "server_name is required for restart" }, isError: true };
    }
    const result = await adminRequest("POST", `servers/${encodeURIComponent(serverName)}/restart`);
    return { data: result.data };
  }

  if (operation === "reconnect") {
    const result = await adminRequest("POST", "servers/reconnect");
    return { data: result.data };
  }

  if (operation === "tail_log") {
    if (!serverName) {
      return { data: { error: "server_name is required for tail_log" }, isError: true };
    }
    const result = await adminRequest("GET", `servers/${encodeURIComponent(serverName)}/logs?lines=${lines}`);
    return { data: result.data };
  }

  // --- v1.6.0: Expanded operations ---

  if (operation === "add") {
    const config = options.config;
    if (!config || !config.name) {
      return { data: { error: "config with at least 'name' is required for add" }, isError: true };
    }
    const result = await adminRequest("POST", "servers", config);
    return { data: result.data };
  }

  if (operation === "remove") {
    if (!serverName) {
      return { data: { error: "server_name is required for remove" }, isError: true };
    }
    const result = await adminRequest("DELETE", `servers/${encodeURIComponent(serverName)}`);
    return { data: result.data };
  }

  if (operation === "patch") {
    if (!serverName) {
      return { data: { error: "server_name is required for patch" }, isError: true };
    }
    const config = options.config;
    if (!config) {
      return { data: { error: "config is required for patch" }, isError: true };
    }
    const result = await adminRequest("PATCH", `servers/${encodeURIComponent(serverName)}`, config);
    return { data: result.data };
  }

  if (operation === "enable") {
    if (!serverName) {
      return { data: { error: "server_name is required for enable" }, isError: true };
    }
    const result = await adminRequest("POST", `servers/${encodeURIComponent(serverName)}/enable`);
    return { data: result.data };
  }

  if (operation === "disable") {
    if (!serverName) {
      return { data: { error: "server_name is required for disable" }, isError: true };
    }
    const result = await adminRequest("POST", `servers/${encodeURIComponent(serverName)}/disable`);
    return { data: result.data };
  }

  if (operation === "quarantine") {
    if (!serverName) {
      return { data: { error: "server_name is required for quarantine" }, isError: true };
    }
    const result = await adminRequest("POST", `servers/${encodeURIComponent(serverName)}/quarantine`);
    return { data: result.data };
  }

  if (operation === "unquarantine") {
    if (!serverName) {
      return { data: { error: "server_name is required for unquarantine" }, isError: true };
    }
    const result = await adminRequest("POST", `servers/${encodeURIComponent(serverName)}/unquarantine`);
    return { data: result.data };
  }

  if (operation === "approve_tools") {
    if (!serverName) {
      return { data: { error: "server_name is required for approve_tools" }, isError: true };
    }
    const body: Record<string, unknown> = {};
    if (options.approve_all) {
      body.approve_all = true;
    } else if (options.tools && Array.isArray(options.tools)) {
      body.tools = options.tools;
    } else {
      return { data: { error: "Either tools array or approve_all=true required" }, isError: true };
    }
    const result = await adminRequest("POST", `servers/${encodeURIComponent(serverName)}/tools/approve`, body);
    return { data: result.data };
  }

  if (operation === "inspect_config") {
    const result = await adminRequest("GET", "config");
    return { data: result.data };
  }

  if (operation === "inspect_server") {
    if (!serverName) {
      return { data: { error: "server_name is required for inspect_server" }, isError: true };
    }
    const [serversResult, toolsResult] = await Promise.all([
      adminRequest("GET", "servers"),
      adminRequest("GET", `servers/${encodeURIComponent(serverName)}/tools`),
    ]);
    const serversData = serversResult.data as Record<string, unknown>;
    const allServers = ((serversData?.data as Record<string, unknown>)?.servers as Record<string, unknown>[]) || [];
    const server = allServers.find(s => s.name === serverName);
    return { data: { server: server || { error: "server not found" }, tools: toolsResult.data } };
  }

  if (operation === "search_tools") {
    const query = options.query;
    if (!query) {
      return { data: { error: "query is required for search_tools" }, isError: true };
    }
    const limit = options.limit || 10;
    const result = await adminRequest("GET", `index/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    return { data: result.data };
  }

  if (operation === "status") {
    const result = await adminRequest("GET", "status");
    return { data: result.data };
  }

  return { data: { error: `Unknown operation: ${operation}` }, isError: true };
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
        PROXY_ADMIN_SCHEMA,
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

      // Always query live BM25 — no caching. Generate multiple search
      // queries per tool name for broader coverage:
      // 1. Raw name as-is (exact match in BM25 — most targeted)
      // 2. Full name with separators → spaces (e.g., "bi-platform query")
      // 3. Last __ segment only (e.g., "query") as a broader fallback
      // 4. First __ segment (e.g., "bi-platform") for server/mount prefix matching
      const queries = new Set<string>();
      for (const n of nameSet) {
        // Strip optional "server:" prefix for searching
        const withoutServer = n.includes(":") ? n.split(":").slice(1).join(":") : n;
        // Raw name as-is — BM25 often matches exact tool names better than transformed queries
        queries.add(withoutServer);
        // Full name → spaces (primary query, most specific)
        queries.add(withoutServer.replace(/__/g, " ").replace(/[-_]/g, " "));
        // Segment-based queries for compound names
        const parts = withoutServer.split("__");
        if (parts.length > 1) {
          // Last segment: tool action (e.g., "query", "edit_files")
          const toolPart = parts[parts.length - 1] || withoutServer;
          queries.add(toolPart.replace(/[-_]/g, " "));
          // First segment: server/mount prefix (e.g., "looker-da", "hetzner_at_slash")
          const prefixPart = parts[0];
          if (prefixPart && prefixPart !== toolPart) {
            queries.add(prefixPart.replace(/[-_]/g, " ") + " " + toolPart.replace(/[-_]/g, " "));
          }
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

      const results = names.map((n) => {
        const tool = resolveToolFromIndex(n, index);
        if (tool) return transformToolSchema(tool);
        return { name: n, error: "not found" };
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results) }],
        structuredContent: toStructuredContent(results),
      };
    }

    // --- Shim-local: proxy_admin ---
    if (name === "proxy_admin") {
      const operation = (args?.operation ?? "") as string;
      const serverName = (args?.server_name ?? "") as string;
      const lines = (args?.lines ?? 50) as number;
      const recursive = (args?.recursive ?? false) as boolean;
      const config = args?.config as Record<string, unknown> | undefined;
      const tools = args?.tools as string[] | undefined;
      const approve_all = args?.approve_all as boolean | undefined;
      const query = args?.query as string | undefined;
      const limit = args?.limit as number | undefined;

      try {
        const result = await handleProxyAdminOperation(operation, serverName, { lines, recursive, config, tools, approve_all, query, limit });
        const text = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
        return {
          content: [{ type: "text" as const, text }],
          ...(result.isError ? { isError: true } : {}),
          structuredContent: toStructuredContent(result.data),
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    let forwardArgs: Record<string, unknown>;
    try {
      forwardArgs = transformToolCallArgs(name, args || {});
    } catch (err) {
      if (err instanceof ArgsValidationError) {
        log("Args validation rejected:", err.message);
        return {
          content: [{ type: "text" as const, text: err.message }],
          isError: true,
        };
      }
      throw err;
    }

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
