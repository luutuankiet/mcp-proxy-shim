/**
 * MCP Proxy Shim — Token Economics Middleware (M1 + M2)
 *
 * Pure functions for shrinking schema-discovery payloads:
 *   - dedupTools():    fold byte-identical fs-mcp tools across hosts (M1)
 *   - compactSchema(): strip lossless cruft from any schema-shaped object (M2)
 *   - flattenReadFilesNesting(): collapse the read_files reads[] structural dup (M2)
 *
 * No I/O, no module state. The two env kill-switches
 * (SHIM_DISABLE_DEDUP, SHIM_DISABLE_COMPACT) live at the call site so
 * these helpers stay testable without process.env mocking.
 *
 * See gsd-lite/RESEARCH-shim-trim.md §2 for the byte-cost baseline that
 * motivated this layer, and DECISION-010..017 in WORK.md for the rules
 * encoded below.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Loose tool shape — accepts whatever upstream/proxy hands us
// ---------------------------------------------------------------------------

export interface ProxyTool {
  name?: string;
  server?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  call_with?: string;
  score?: number;
  _meta?: Record<string, unknown>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUFFIX_SEPARATOR = "__";
const DESCRIPTION_PREFIX_RE = /^\[[^\]]+\]\s*/;
const STRIP_KEYS = new Set(["$schema", "additionalProperties", "_meta", "score", "title"]);
const READ_FILES_SUFFIX = "read_files";

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

export function nameSuffix(name: string): string {
  const noServer = name.includes(":") ? name.split(":").slice(1).join(":") : name;
  const parts = noServer.split(SUFFIX_SEPARATOR);
  return parts[parts.length - 1] || noServer;
}

export function strippedDescription(desc: string | undefined): string {
  if (!desc) return "";
  return desc.replace(DESCRIPTION_PREFIX_RE, "");
}

// ---------------------------------------------------------------------------
// M2 — compactSchema (recursive cruft strip)
// ---------------------------------------------------------------------------

/**
 * Recursively strip lossless-boilerplate keys from any schema-shaped object:
 *   $schema, additionalProperties, _meta, score, title.
 *
 * Walks arrays + nested objects. Returns a fresh structure — never mutates input.
 * Safe to apply to a tool, a JSON Schema, or arbitrary nested data.
 */
export function compactSchema<T>(node: T): T {
  if (node === null || node === undefined || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return (node as unknown[]).map(item => compactSchema(item)) as unknown as T;
  }
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (STRIP_KEYS.has(key)) continue;
    out[key] = compactSchema(obj[key]);
  }
  return out as T;
}

/**
 * Specific structural flatten for the `read_files` family of tools:
 * inputSchema.properties.files.items.properties.reads.items.properties
 * re-declares mode fields (head/tail/start_line/end_line/read_to_next_pattern)
 * verbatim from the parent file item. Replace duplicate inner descriptions
 * with a 1-line pointer.
 *
 * Idempotent and pattern-gated — leaves unrelated tools untouched.
 */
export function flattenReadFilesNesting(tool: ProxyTool): ProxyTool {
  if (!tool || typeof tool !== "object") return tool;
  if (nameSuffix(tool.name ?? "") !== READ_FILES_SUFFIX) return tool;

  const inputSchema = tool.inputSchema as Record<string, unknown> | undefined;
  const topProps = inputSchema?.properties as Record<string, unknown> | undefined;
  const filesProp = topProps?.files as Record<string, unknown> | undefined;
  const filesItems = filesProp?.items as Record<string, unknown> | undefined;
  const parentProps = filesItems?.properties as Record<string, unknown> | undefined;
  const readsProp = parentProps?.reads as Record<string, unknown> | undefined;
  const readsItems = readsProp?.items as Record<string, unknown> | undefined;
  const innerProps = readsItems?.properties as Record<string, unknown> | undefined;
  if (!parentProps || !innerProps) return tool;

  const parentKeys = new Set(Object.keys(parentProps));
  const trimmedInner: Record<string, unknown> = {};
  let trimmedAny = false;
  for (const key of Object.keys(innerProps)) {
    if (parentKeys.has(key)) {
      const original = innerProps[key] as Record<string, unknown> | undefined;
      trimmedInner[key] = {
        ...(original?.type !== undefined ? { type: original.type } : {}),
        ...(original?.nullable !== undefined ? { nullable: original.nullable } : {}),
        description: `See parent file item.${key}`,
      };
      trimmedAny = true;
    } else {
      trimmedInner[key] = innerProps[key];
    }
  }
  if (!trimmedAny) return tool;

  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      properties: {
        ...topProps!,
        files: {
          ...filesProp!,
          items: {
            ...filesItems!,
            properties: {
              ...parentProps,
              reads: {
                ...readsProp!,
                items: {
                  ...readsItems!,
                  properties: trimmedInner,
                  description:
                    (readsItems!.description as string | undefined) ??
                    "A single read specification. Mode fields mutually exclusive within this object.",
                },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * Convenience: cruft-strip + apply known structural flattens.
 */
export function compactTool(tool: ProxyTool): ProxyTool {
  return flattenReadFilesNesting(compactSchema(tool));
}

// ---------------------------------------------------------------------------
// M1 — dedupTools
// ---------------------------------------------------------------------------

export interface DedupOptions {
  /** Include inputSchema in the dedup hash (default: true) */
  includeSchema?: boolean;
  /** Override the warn channel (default: console.warn). Useful for tests. */
  onWarn?: (msg: string) => void;
}

/**
 * Fold byte-identical tools across hosts into a single canonical entry with
 * `servers: [...]`. Dedup key is
 * `sha256(suffix + "\n" + stripped_description + "\n" + canonical(annotations) [+ "\n" + canonical(inputSchema)])`.
 *
 * - The proxy `server` field is intentionally excluded from the hash — the
 *   whole point is to merge across hosts.
 * - Description `[nested_server_id] ` prefix is stripped before hashing AND
 *   on the collapsed canonical entry (since `servers: [...]` already
 *   preserves attribution).
 * - Singletons (groups of one) are emitted unchanged — no description rewrite,
 *   no schema mutation.
 * - Groups with 2 members emit a console.warn: dedup expected fleet-scale
 *   duplication, so a small group hints the description-prefix heuristic
 *   may be drifting (per RESEARCH §9 risk #1).
 * - Non-object array entries pass through unchanged.
 */
export function dedupTools(tools: unknown[], opts: DedupOptions = {}): unknown[] {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  const includeSchema = opts.includeSchema !== false;
  const warn = opts.onWarn ?? ((m: string) => console.warn(m));

  type Group = { canonical: ProxyTool; servers: string[]; members: ProxyTool[]; passthru: boolean };
  const groups = new Map<string, Group>();
  const order: string[] = [];

  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    if (!t || typeof t !== "object") {
      const k = `__passthru__${i}`;
      groups.set(k, { canonical: t as ProxyTool, servers: [], members: [t as ProxyTool], passthru: true });
      order.push(k);
      continue;
    }
    const tool = t as ProxyTool;
    const suffix = nameSuffix(tool.name ?? "");
    const desc = strippedDescription(tool.description);
    const annotations = canonicalJson(tool.annotations ?? {});
    const schema = includeSchema && tool.inputSchema ? canonicalJson(tool.inputSchema) : "";
    const key = sha256Hex(suffix + "\n" + desc + "\n" + annotations + (schema ? "\n" + schema : ""));

    const existing = groups.get(key);
    const serverName = typeof tool.server === "string" ? tool.server : "";
    if (!existing) {
      groups.set(key, {
        canonical: tool,
        servers: serverName ? [serverName] : [],
        members: [tool],
        passthru: false,
      });
      order.push(key);
    } else {
      if (serverName && !existing.servers.includes(serverName)) existing.servers.push(serverName);
      existing.members.push(tool);
    }
  }

  const out: unknown[] = [];
  for (const key of order) {
    const g = groups.get(key)!;
    if (g.passthru) {
      out.push(g.canonical);
      continue;
    }
    if (g.members.length === 1) {
      out.push(g.canonical);
      continue;
    }
    if (g.members.length === 2) {
      warn(`[mcp-shim/dedup] small group (2) for suffix=${nameSuffix(g.canonical.name ?? "")} — prefix-strip heuristic may be drifting`);
    }
    const merged: Record<string, unknown> = {
      ...g.canonical,
      description: strippedDescription(g.canonical.description),
      servers: g.servers,
    };
    delete merged.server;
    out.push(merged);
  }
  return out;
}
