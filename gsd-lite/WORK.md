# Work Log

## 1. Current Understanding

<current_mode>
Issue #1 fixes shipped + daemon feature complete. Branch claude/fix-mcp-daemon-setup-B7wLA ready for merge to main. All changes tested against live wmcpproxy upstream.
</current_mode>

<active_task>
TASK-001: Merge branch to main (resolve branch situation with claude/fix-github-tool-mcp-proxy-AhISB)
</active_task>

<parked_tasks>
- npm publish with updated version (post-merge)
- Dockerfile update for daemon mode
</parked_tasks>

<vision>
MCP proxy shim as the standard client-side adapter for mcpproxy-go, plus a standalone daemon gateway for cloud agents that can't spawn MCP servers.
</vision>

<decisions>
DECISION-001: No caching in describe_tools — always query live BM25 (owner requirement).
DECISION-002: Re-serialize args via JSON.stringify(JSON.parse()) instead of passthrough — prevents Go unmarshal failures from non-canonical LLM escaping.
DECISION-003: Reject invalid args with clear error instead of silent fallback to "{}" — never silently drop data.
DECISION-004: Daemon mode is independent of core.ts — pure MCP SDK passthrough, no mcpproxy-go dependency.
DECISION-005: daemon_help built-in tool + server instructions in initialize response — clients know how to use the gateway immediately.
</decisions>

<blockers>
None active.
</blockers>

<next_action>
Merge claude/fix-mcp-daemon-setup-B7wLA to main. Ditch middleman branch claude/fix-github-tool-mcp-proxy-AhISB.
</next_action>

---

## 2. Key Events

| Date | Event | Impact |
|------|-------|--------|
| 2026-03-25 | Issue #1 filed: describe_tools name resolution + args_json serialization errors | Two bugs from heavy multi-agent session (~15 subagents, ~80+ proxy calls) |
| 2026-03-25 | LOG-001: Issue #1 fixes — BM25 query improvements + ensureJsonObjectString | describe_tools always queries live BM25 with raw name + transformed queries. args re-serialized to canonical JSON. |
| 2026-03-25 | LOG-002: Transcript analysis — identified re-serialization as key fix for args_json | LLM intermittently sends args as pre-serialized string. Raw string passthrough caused Go unmarshal failures. |
| 2026-03-25 | LOG-003: Daemon mode implemented | Multi-server MCP gateway: stdio + HTTP upstreams, pure passthrough, tool namespacing, custom headers |
| 2026-03-26 | LOG-004: daemon_help tool + server instructions + README update | Clients get full usage guide via built-in tool and MCP instructions |
| 2026-03-26 | LOG-005: Strict args validation — reject instead of silent fallback | ArgsValidationError with descriptive messages. Schema description updated. |

---

## 3. Atomic Session Log

### [LOG-001] - [BUG] [EXEC] - Issue #1: describe_tools + args_json fixes - Task: TASK-001
**Timestamp:** 2026-03-25 22:00
**Depends On:** Issue #1 report

---

#### Discovery

Reproduced against live wmcpproxy upstream with multi-filesystem mounts. Both issues from Issue #1 analyzed:

1. **describe_tools**: BM25 search-only approach failed for certain tool name patterns. Fixed by adding raw tool name as BM25 query (most targeted) alongside transformed queries.

2. **args_json**: LLM intermittently sends `args` as pre-serialized JSON string instead of native object. The raw string could have non-canonical escaping that Go's `json.Unmarshal` rejects. Fixed by always re-serializing via `JSON.stringify(JSON.parse(input))`.

#### Evidence

Transcript from production session showed:
- LOG-030 heredoc append: `args: "{\"command\": \"cd ..."` (string, not object) → `Invalid args_json format`
- GitHub issue_write: `args: "{\"method\": \"create\", ..."` (string) → same error
- Both succeeded on retry when LLM sent `args` as native object

---

STATELESS HANDOFF
**What was decided:** Always query live BM25 (no caching). Re-serialize args to canonical JSON. Add raw tool name as BM25 query.
**Next action:** Strict validation (LOG-005).

### [LOG-002] - [EXEC] - Daemon mode implementation - Task: TASK-002
**Timestamp:** 2026-03-25 23:30
**Depends On:** LOG-001

---

#### Implementation

New `daemon` subcommand in `src/daemon.ts`:
- Connects to N upstream MCP servers (stdio spawn or HTTP Streamable)
- Aggregates all tools with `serverName__toolName` namespacing
- Pure passthrough — no schema transformation
- Custom HTTP headers per upstream (Authorization, API keys, etc.)
- HTTPS proxy support via undici ProxyAgent
- Health endpoint with per-server status

Tested against wmcpproxy upstream via HTTP Streamable transport. 10 tools aggregated, tool calls passthrough correctly.

---

STATELESS HANDOFF
**What was decided:** Daemon is independent of core.ts. Tool namespacing with double underscore. daemon_help built-in tool.
**Next action:** README docs + helper tool.

### [LOG-003] - [EXEC] - Strict args validation - Task: TASK-001
**Timestamp:** 2026-03-26 00:30
**Depends On:** LOG-001

---

#### Changes

Replaced silent `"{}"` fallback with `ArgsValidationError` that rejects immediately with descriptive error messages. Updated schema description to tell clients exactly what `args` expects.

Tested all scenarios:
- Native object ✅, valid JSON string ✅, null ✅
- Boolean ❌ rejected, string primitive ❌ rejected, bad JSON ❌ rejected, array ❌ rejected
- Nested JSON strings inside object ✅ (works fine)

---

STATELESS HANDOFF
**What was decided:** Never silently drop data. Reject with clear error that tells client how to fix.
**Next action:** Write GSD-Lite artifacts, merge branch.
