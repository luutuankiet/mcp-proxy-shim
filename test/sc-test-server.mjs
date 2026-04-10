#!/usr/bin/env node
/**
 * Throwaway MCP server that returns structuredContent.
 * Responds with plain JSON (not SSE) for easy curl testing.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = parseInt(process.env.MCP_PORT || '9877', 10);

function ok(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': 'Mcp-Session-Id' });
    return res.end();
  }
  if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(404); return res.end(); }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const { method, params, id } = JSON.parse(Buffer.concat(chunks).toString());

  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Mcp-Session-Id' };

  if (method === 'initialize') {
    headers['Mcp-Session-Id'] = crypto.randomUUID();
    res.writeHead(200, headers);
    res.end(ok(id, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'sc-test-server', version: '1.0.0' },
    }));
  } else if (method === 'notifications/initialized') {
    res.writeHead(202); res.end();
  } else if (method === 'tools/list') {
    res.writeHead(200, headers);
    res.end(ok(id, { tools: [
      { name: 'echo_with_sc', description: 'Returns both content AND structuredContent', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
      { name: 'echo_text_only', description: 'Returns only content (no SC)', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
    ] }));
  } else if (method === 'tools/call') {
    const msg = params?.arguments?.message || 'hello';
    res.writeHead(200, headers);
    if (params?.name === 'echo_with_sc') {
      res.end(ok(id, {
        content: [{ type: 'text', text: `Echo: ${msg}` }],
        structuredContent: { echo: msg, ts: new Date().toISOString(), meta: { source: 'sc-test-server' } },
      }));
    } else if (params?.name === 'echo_text_only') {
      res.end(ok(id, { content: [{ type: 'text', text: `Echo (text only): ${msg}` }] }));
    } else {
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool' } }));
    }
  } else {
    res.writeHead(202); res.end();
  }
});

server.listen(PORT, () => {
  console.error(`[sc-test] http://0.0.0.0:${PORT}/mcp — tools: echo_with_sc, echo_text_only`);
});
