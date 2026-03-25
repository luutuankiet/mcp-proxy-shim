# Reproduce & Fix Issue #1

GitHub Issue: https://github.com/luutuankiet/mcp-proxy-shim/issues/1

## Two bugs to fix

1. **describe_tools name resolution** — returns "not found" for tools that retrieve_tools discovers
2. **args_json double-serialization** — intermittent `Invalid args_json format` errors

## Prerequisites

The MCP_URL environment variable must be set to the upstream mcpproxy-go
endpoint (with apikey). Unset https_proxy/HTTPS_PROXY if the environment
has a proxy that blocks direct HTTPS connections.

## Step 1: Start the test harness

```bash
npm install && npm run build
https_proxy= HTTPS_PROXY= MCP_URL="$MCP_URL" node test/harness.mjs &
# Wait for "[harness] Listening on http://127.0.0.1:3456"
```

## Step 2: Reproduce Bug 1 — describe_tools

```bash
# Discover tools
TOOLS=$(curl -s http://localhost:3456/retrieve_tools \
  -d '{"query": "read files edit files run command"}' | jq -r '.parsed.tools[].name' | head -10)
echo "$TOOLS"

# Try to describe them — some will return "not found"
NAMES_JSON=$(echo "$TOOLS" | jq -R -s 'split("\n") | map(select(length > 0))')
curl -s http://localhost:3456/describe_tools \
  -d "{\"names\": $NAMES_JSON}" | jq '.parsed[] | select(.error == "not found")'
```

### Root cause (src/core.ts ~line 510)

The describe_tools handler builds search queries by splitting tool names
on `__` and using ONLY the last segment:

```
"bi-platform__query" → splits to ["bi-platform", "query"] → searches "query"
```

"query" is too generic — retrieve_tools returns unrelated tools, and the
exact name never appears in the index. Meanwhile tools like
`bi-platform__run_dashboard` work because "run dashboard" is specific enough.

### Fix

1. Use the FULL tool name (with separators→spaces) as the primary search query
2. Keep the last-segment query as a fallback
3. Use flexible name matching: exact → strip/add server prefix → suffix match

## Step 3: Reproduce Bug 2 — args_json serialization

```bash
# Test: args as a pre-serialized string (some MCP clients do this)
curl -s http://localhost:3456/call -d '{
  "name": "call_tool_read",
  "arguments": {
    "name": "utils:github__get_me",
    "args": "{}"
  }
}' | jq .parsed
# Expected error: "Invalid args_json format: json: cannot unmarshal string..."
```

### Root cause (src/core.ts transformToolCallArgs)

```typescript
const { args: argsObj, ...rest } = args;
return { ...rest, args_json: JSON.stringify(argsObj) };
```

If `argsObj` is already a string `"{}"`, `JSON.stringify("{}")` produces
`"\"{}\"` — a JSON string containing a string, not a JSON object.
Upstream Go does `json.Unmarshal(argsJson, &map[string]interface{})` and
gets a string instead of a map.

### Fix

Check if args is a string. If so, validate it's valid JSON and pass
through directly. Only stringify if it's an actual object.

## Step 4: Run the automated repro script

```bash
https_proxy= HTTPS_PROXY= MCP_URL="$MCP_URL" node test/repro-issues.mjs
```

## Step 5: Write e2e tests

After applying fixes, write `test/e2e.test.mjs` using Node's built-in
test runner (`node:test`). Tests should cover:

- retrieve_tools → describe_tools round-trip (all names resolve)
- transformToolCallArgs with args as object
- transformToolCallArgs with args as pre-serialized string
- transformToolCallArgs with args_json passthrough (backward compat)
- Concurrent calls (5-10 parallel) to surface race conditions

## Step 6: Commit, push, create PR

Branch: `claude/fix-github-tool-mcp-proxy-AhISB`
Reference issue #1 in the PR.
