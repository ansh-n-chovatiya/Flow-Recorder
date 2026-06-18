// FlowSnap MCP Server
// Runs two transports on the same process:
//   1. stdio — MCP protocol for Claude Code / claude.ai desktop
//   2. HTTP  — port 7734, receives POSTed flows from the browser extension
//
// Start: node mcp-server/server.js
// Claude Code config: see ../.claude/settings.local.json

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLOWS_DIR = path.join(__dirname, 'flows');
const HTTP_PORT = 7734;

await fs.mkdir(FLOWS_DIR, { recursive: true });

// ── Helpers ────────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

function generateMarkdown(flow) {
  const lines = [];
  const date = new Date(flow.timestamp).toLocaleString();
  lines.push(`# ${flow.name}`);
  lines.push('');
  lines.push(`**Recorded:** ${date}  `);
  lines.push(`**Steps:** ${flow.steps.length}  `);
  if (flow.startUrl) lines.push(`**Start URL:** ${flow.startUrl}  `);
  lines.push('');
  lines.push('---');
  lines.push('');

  flow.steps.forEach((step, i) => {
    const label = step.action
      ? `${step.type || 'action'}: ${step.action}`
      : (step.type || 'step');
    lines.push(`## Step ${i + 1} — ${label}`);
    if (step.url)      lines.push(`- **URL:** ${step.url}`);
    if (step.selector) lines.push(`- **Element:** \`${step.selector}\``);
    if (step.value)    lines.push(`- **Value:** ${step.value}`);
    if (step.description) lines.push(`- **Note:** ${step.description}`);
    if (step.screenshotFile) lines.push(`- **Screenshot:** \`screenshots/${step.screenshotFile}\``);
    if (step.networkCalls && step.networkCalls.length) {
      lines.push(`- **Network calls:** ${step.networkCalls.length}`);
      step.networkCalls.slice(0, 3).forEach(nc => {
        lines.push(`  - \`${nc.method || 'GET'} ${nc.url}\` → ${nc.status || '?'}`);
      });
      if (step.networkCalls.length > 3) lines.push(`  - _…and ${step.networkCalls.length - 3} more_`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

async function saveFlow(flow) {
  const flowDir = path.join(FLOWS_DIR, flow.id);
  const screenshotsDir = path.join(flowDir, 'screenshots');
  await fs.mkdir(screenshotsDir, { recursive: true });

  // Extract screenshots from steps, write to disk, replace with filename ref
  const stepsClean = flow.steps.map((step, i) => {
    const { screenshot, screenshotOriginal, ...rest } = step;
    const dataUrl = screenshotOriginal || screenshot;
    if (dataUrl && dataUrl.startsWith('data:')) {
      const ext = dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
      const filename = `step-${pad2(i + 1)}.${ext}`;
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFile(path.join(screenshotsDir, filename), Buffer.from(base64, 'base64'))
        .catch(err => process.stderr.write(`FlowSnap: screenshot write failed: ${err.message}\n`));
      return { ...rest, screenshotFile: filename };
    }
    return rest;
  });

  const meta = {
    id: flow.id,
    name: flow.name,
    timestamp: flow.timestamp,
    stepCount: flow.steps.length,
    startUrl: flow.startUrl || (flow.steps[0] && flow.steps[0].url) || null,
  };

  const flowData = { ...meta, steps: stepsClean };
  const md = generateMarkdown({ ...meta, steps: flow.steps });

  await Promise.all([
    fs.writeFile(path.join(flowDir, 'flow.json'), JSON.stringify(flowData, null, 2), 'utf8'),
    fs.writeFile(path.join(flowDir, 'flow.md'),   md, 'utf8'),
    fs.writeFile(path.join(flowDir, 'meta.json'), JSON.stringify(meta), 'utf8'),
  ]);

  return meta;
}

async function listAllFlows() {
  const entries = await fs.readdir(FLOWS_DIR, { withFileTypes: true }).catch(() => []);
  const metas = await Promise.all(
    entries
      .filter(e => e.isDirectory())
      .map(async e => {
        try {
          const raw = await fs.readFile(path.join(FLOWS_DIR, e.name, 'meta.json'), 'utf8');
          return JSON.parse(raw);
        } catch { return null; }
      })
  );
  return metas.filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
}

async function readFlow(id) {
  const flowDir = path.join(FLOWS_DIR, id);
  const [jsonRaw, md] = await Promise.all([
    fs.readFile(path.join(flowDir, 'flow.json'), 'utf8'),
    fs.readFile(path.join(flowDir, 'flow.md'),   'utf8').catch(() => ''),
  ]);
  return { json: JSON.parse(jsonRaw), markdown: md };
}

async function readFlowScreenshots(id) {
  const screenshotsDir = path.join(FLOWS_DIR, id, 'screenshots');
  const files = await fs.readdir(screenshotsDir).catch(() => []);
  return Promise.all(
    files
      .filter(f => /\.(jpg|jpeg|png)$/.test(f))
      .sort()
      .map(async (f, i) => {
        const buf = await fs.readFile(path.join(screenshotsDir, f));
        return {
          stepNumber: i + 1,
          filename: f,
          base64: buf.toString('base64'),
          mimeType: f.endsWith('.png') ? 'image/png' : 'image/jpeg',
        };
      })
  );
}

// ── HTTP server (extension → server) ──────────────────────────────────────

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'flowsnap-mcp', port: HTTP_PORT }));
    return;
  }

  if (req.method === 'POST' && req.url === '/flows') {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const flow = JSON.parse(body);

      if (!flow.id || !Array.isArray(flow.steps)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields: id, steps' }));
        return;
      }

      const meta = await saveFlow(flow);
      process.stderr.write(`FlowSnap: saved flow "${meta.name}" (${meta.stepCount} steps)\n`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: meta.id, name: meta.name }));
    } catch (err) {
      process.stderr.write(`FlowSnap: error saving flow: ${err.message}\n`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404); res.end();
});

httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  process.stderr.write(`FlowSnap HTTP receiver listening on http://127.0.0.1:${HTTP_PORT}\n`);
});

// ── MCP server (server → Claude) ───────────────────────────────────────────

const mcpServer = new Server(
  { name: 'flowsnap', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_flows',
      description: 'List all recorded browser flows. Returns id, name, step count, timestamp, and start URL for each flow.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_flow',
      description: 'Get the full JSON data and markdown summary of a recorded flow. Use list_flows first to get the id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID returned by list_flows' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_flow_screenshots',
      description: 'Get screenshots for every step in a flow as base64 images. Call get_flow first to understand the steps, then call this to see them visually.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID returned by list_flows' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_latest_flow',
      description: 'Get the most recently recorded flow — JSON data and markdown summary. Shortcut for list_flows + get_flow on the newest entry.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'list_flows': {
      const flows = await listAllFlows();
      if (!flows.length) {
        return { content: [{ type: 'text', text: 'No flows recorded yet. Record a flow in the FlowSnap extension then stop recording — it will be sent here automatically.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(flows, null, 2) }] };
    }

    case 'get_flow': {
      try {
        const { json, markdown } = await readFlow(args.id);
        return {
          content: [
            { type: 'text', text: `## Markdown Summary\n\n${markdown}` },
            { type: 'text', text: `## Full JSON\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`` },
          ],
        };
      } catch {
        return { content: [{ type: 'text', text: `Flow "${args.id}" not found. Run list_flows to see available flows.` }], isError: true };
      }
    }

    case 'get_flow_screenshots': {
      try {
        const images = await readFlowScreenshots(args.id);
        if (!images.length) {
          return { content: [{ type: 'text', text: 'No screenshots found for this flow. Screenshots may have been dropped due to storage limits.' }] };
        }
        return {
          content: images.flatMap(img => [
            { type: 'text', text: `**Step ${img.stepNumber}** (${img.filename})` },
            { type: 'image', data: img.base64, mimeType: img.mimeType },
          ]),
        };
      } catch {
        return { content: [{ type: 'text', text: `Flow "${args.id}" not found. Run list_flows to see available flows.` }], isError: true };
      }
    }

    case 'get_latest_flow': {
      const flows = await listAllFlows();
      if (!flows.length) {
        return { content: [{ type: 'text', text: 'No flows recorded yet.' }] };
      }
      try {
        const { json, markdown } = await readFlow(flows[0].id);
        return {
          content: [
            { type: 'text', text: `## Latest Flow: ${flows[0].name}\n\n${markdown}` },
            { type: 'text', text: `## Full JSON\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`` },
          ],
        };
      } catch {
        return { content: [{ type: 'text', text: 'Could not read latest flow data.' }], isError: true };
      }
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
