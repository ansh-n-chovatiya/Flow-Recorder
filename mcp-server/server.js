#!/usr/bin/env node
/**
 * FlowSnap MCP server — recorded browser flows, as tools Claude can call.
 *
 * LOCAL (default): stdio MCP, plus an HTTP receiver on 127.0.0.1:7734 that the
 * Chrome extension POSTs recordings to.
 *
 *   claude mcp add flowsnap --scope user -- npx -y flowsnap-mcp
 *
 * REMOTE: SSE MCP and the receiver on $PORT, for a hosted deployment.
 *
 *   MCP_MODE=remote node server.js
 *
 * Flows are written to ~/.flowsnap/flows, not next to this file: under npx the
 * package lives in a cache directory that gets cleared without warning, which
 * would take every recording with it. FLOWSNAP_DIR overrides the location.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const { version: VERSION } = createRequire(import.meta.url)('./package.json');
const REMOTE = process.env.MCP_MODE === 'remote';
const HOME = process.env.FLOWSNAP_DIR
  ? path.resolve(process.env.FLOWSNAP_DIR)
  : path.join(os.homedir(), '.flowsnap');
const FLOWS_DIR = path.join(HOME, 'flows');
// 7734 is what the extension posts to by default; FLOWSNAP_PORT is for the rare
// machine where something else already owns it, and must be changed on both sides.
const HTTP_PORT = REMOTE ? Number(process.env.PORT) || 8080 : Number(process.env.FLOWSNAP_PORT) || 7734;

/** How many images one `get_flow_screenshots` call will return. */
const MAX_IMAGES = 8;
/** Request and response bodies are cut to this in tool output. */
const BODY_LIMIT = 2000;

await fs.mkdir(FLOWS_DIR, { recursive: true });

function log(message) {
  process.stderr.write(`FlowSnap: ${message}\n`);
}

// ── Flow shape ─────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

/** A directory name is a path segment, and `id` arrives over HTTP and from tool args. */
function flowDir(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return path.join(FLOWS_DIR, id);
}

function truncate(value, limit = BODY_LIMIT) {
  if (typeof value !== 'string') return value;
  return value.length <= limit ? value : `${value.slice(0, limit)}… [${value.length} chars total]`;
}

/** A request that never landed, or landed badly. */
function failedCalls(step) {
  return (step.networkCalls ?? []).filter((call) => call.status === null || call.status >= 400);
}

function consoleErrors(step) {
  return (step.consoleLogs ?? []).filter((entry) => entry.level === 'error');
}

function countFailures(steps) {
  return steps.filter((step) => consoleErrors(step).length > 0 || failedCalls(step).length > 0)
    .length;
}

function screenshotPath(dir, step) {
  return step.screenshotFile ? path.join(dir, 'screenshots', step.screenshotFile) : null;
}

/**
 * The component a step happened in, if the flow says so.
 *
 * The extension writes the id down at export time (`element.react.owner`)
 * precisely so this does not have to re-derive it: choosing between the twelve
 * components a click sits inside takes four preference tiers, and a server that
 * guessed differently would contradict the same flow's own markdown.
 */
function stepComponent(flow, step) {
  const owner = step.element?.react?.owner;
  return owner ? (flow.react?.components?.[owner] ?? null) : null;
}

/**
 * Where a component was written, as one string.
 *
 * NOTE: this is text and only ever text. `source` came off a web page — it is
 * whatever that page's source map claimed — so it is never joined to a
 * directory, never opened, and never used to name a file on this machine.
 * Screenshots are named by index for the same reason.
 */
function componentSource(component) {
  if (component.source) {
    return component.line ? `${component.source}:${component.line}` : component.source;
  }
  if (component.compiled) {
    const { url, line, column } = component.compiled;
    return `${url}:${line}:${column}`;
  }
  return null;
}

/** The one table, listing each component in the order the steps meet it. */
function componentTable(flow) {
  const components = flow.react?.components;
  if (!components) return [];

  const seen = new Set();
  const rows = [];

  for (const step of flow.steps) {
    for (const id of step.element?.react?.chain ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);

      const component = components[id];
      if (!component) continue;
      rows.push(
        `| ${component.name} | ${componentSource(component) ?? '—'} | ${component.detail ?? ''} |`,
      );
    }
  }

  return rows;
}

function generateMarkdown(flow, dir) {
  const lines = [
    `# ${flow.name}`,
    '',
    `**Recorded:** ${new Date(flow.timestamp).toLocaleString()}  `,
    `**Steps:** ${flow.steps.length}  `,
  ];
  if (flow.startUrl) lines.push(`**Start URL:** ${flow.startUrl}  `);
  if (flow.errorCount) lines.push(`**Steps with failures:** ${flow.errorCount}  `);
  lines.push('', '---', '');

  flow.steps.forEach((step, i) => {
    const label = step.action ? `${step.type || 'action'}: ${step.action}` : step.type || 'step';
    lines.push(`## Step ${i + 1} — ${label}`);
    if (step.url) lines.push(`- **URL:** ${step.url}`);

    const selector = step.element?.cssSelector ?? step.selector;
    if (selector) lines.push(`- **Element:** \`${selector}\``);
    if (step.element?.label) lines.push(`- **Label:** ${step.element.label}`);

    // The name only. Its path is in the table at the end, so a flow that clicks
    // one button forty times spends the tokens on that path once.
    const component = stepComponent(flow, step);
    if (component) lines.push(`- **Component:** ${component.name}`);

    if (step.value) lines.push(`- **Value:** ${step.value}`);
    if (step.notes) lines.push(`- **Note:** ${step.notes}`);

    // Absolute, because whoever reads this markdown is running in some other
    // project's directory and has its own file tools.
    const image = screenshotPath(dir, step);
    if (image) lines.push(`- **Screenshot:** ${image}`);

    for (const entry of consoleErrors(step)) {
      lines.push(`- **Console error:** ${truncate(entry.args.join(' '), 300)}`);
    }

    const calls = step.networkCalls ?? [];
    const bad = failedCalls(step);
    if (calls.length) {
      lines.push(`- **Network calls:** ${calls.length}${bad.length ? ` (${bad.length} failed)` : ''}`);
      for (const call of bad.slice(0, 3)) {
        lines.push(`  - \`${call.method || 'GET'} ${call.url}\` → ${call.status ?? 'no response'}`);
      }
    }
    lines.push('');
  });

  const rows = componentTable(flow);
  if (rows.length) {
    lines.push(
      '## React components',
      '',
      'Where each component above was written, in this app\'s own source. Open',
      'these files directly rather than searching for the component by name.',
      '',
      '| Component | Source | Notes |',
      '| --- | --- | --- |',
      ...rows,
      '',
    );
  }

  return lines.join('\n');
}

async function saveFlow(flow) {
  const dir = flowDir(flow.id);
  if (!dir) throw new Error(`Invalid flow id: ${flow.id}`);

  const screenshotsDir = path.join(dir, 'screenshots');
  await fs.mkdir(screenshotsDir, { recursive: true });

  // Images come off the steps and onto disk: a step's JSON is read into a
  // context window, and a base64 JPEG in the middle of it is pure waste.
  const writes = [];
  const stepsClean = flow.steps.map((step, i) => {
    const { screenshot, screenshotOriginal, ...rest } = step;
    // The annotated image, which carries a highlight around the element that
    // was clicked. The clean original is the fallback, not the preference —
    // knowing *which* button was pressed is most of a screenshot's value here.
    const dataUrl = screenshot || screenshotOriginal;
    if (!dataUrl || !dataUrl.startsWith('data:')) return rest;

    const ext = dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
    const screenshotFile = `step-${pad2(i + 1)}.${ext}`;
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    writes.push(
      fs
        .writeFile(path.join(screenshotsDir, screenshotFile), Buffer.from(base64, 'base64'))
        .catch((error) => log(`screenshot write failed: ${error.message}`)),
    );
    return { ...rest, screenshotFile };
  });

  const meta = {
    id: flow.id,
    name: flow.name,
    timestamp: flow.timestamp,
    stepCount: flow.steps.length,
    startUrl: flow.startUrl || flow.steps[0]?.url || null,
    // In the index so a caller can tell which recording is the broken one
    // without opening every flow.
    errorCount: countFailures(flow.steps),
    schemaVersion: flow.schemaVersion ?? 1,
  };

  // Additive, and absent entirely when the page was not React — which is also
  // how every flow recorded before this existed reads.
  const data = { ...meta, steps: stepsClean, ...(flow.react ? { react: flow.react } : {}) };

  // Awaited, not fired and forgotten: the POST response tells the extension the
  // flow is readable, and a tool call can arrive immediately after it.
  await Promise.all([
    ...writes,
    fs.writeFile(path.join(dir, 'flow.json'), JSON.stringify(data, null, 2), 'utf8'),
    fs.writeFile(path.join(dir, 'flow.md'), generateMarkdown(data, dir), 'utf8'),
    fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8'),
  ]);

  return meta;
}

async function listAllFlows() {
  const entries = await fs.readdir(FLOWS_DIR, { withFileTypes: true }).catch(() => []);
  const metas = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          return JSON.parse(await fs.readFile(path.join(FLOWS_DIR, entry.name, 'meta.json'), 'utf8'));
        } catch {
          return null;
        }
      }),
  );
  return metas.filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
}

async function readFlow(id) {
  const dir = flowDir(id);
  if (!dir) throw new Error(`Invalid flow id: ${id}`);

  const [jsonRaw, markdown] = await Promise.all([
    fs.readFile(path.join(dir, 'flow.json'), 'utf8'),
    fs.readFile(path.join(dir, 'flow.md'), 'utf8').catch(() => ''),
  ]);
  return { dir, json: JSON.parse(jsonRaw), markdown };
}

// ── HTTP receiver (extension → server, and SSE MCP when remote) ────────────

const sseTransports = {};

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'flowsnap-mcp',
        version: VERSION,
        mode: REMOTE ? 'remote' : 'local',
        flowsDir: FLOWS_DIR,
      }),
    );
    return;
  }

  if (REMOTE && req.method === 'GET' && req.url === '/mcp') {
    const transport = new SSEServerTransport('/mcp/message', res);
    sseTransports[transport.sessionId] = transport;
    res.on('close', () => delete sseTransports[transport.sessionId]);
    await mcpServer.connect(transport);
    return;
  }

  if (REMOTE && req.method === 'POST' && req.url?.startsWith('/mcp/message')) {
    const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
    const transport = sseTransports[sessionId];
    if (!transport) {
      res.writeHead(404);
      res.end();
      return;
    }
    await transport.handlePostMessage(req, res);
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
      log(`saved "${meta.name}" — ${meta.stepCount} steps, ${meta.errorCount} with failures`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: meta.id, name: meta.name }));
    } catch (error) {
      log(`error saving flow: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

/*
 * Installed at user scope, this server runs once per Claude session — so opening
 * a second project means a second process reaching for the same port. The state
 * that matters is FLOWS_DIR, not the process: whichever instance owns the port
 * receives flows, and every instance reads what it writes. So losing the race is
 * survivable, and only the process that wins listens.
 *
 * Remote mode has no such luxury — the port is how MCP itself is served there.
 */
httpServer.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && !REMOTE) {
    log(`port ${HTTP_PORT} already taken — another session is receiving. Serving from ${FLOWS_DIR}.`);
    return;
  }
  log(`HTTP server error: ${error.message}`);
  process.exit(1);
});

httpServer.listen(HTTP_PORT, REMOTE ? '0.0.0.0' : '127.0.0.1', () => {
  log(`listening on ${HTTP_PORT} (${REMOTE ? 'remote/SSE' : 'local/stdio'}) — flows in ${FLOWS_DIR}`);
});

// ── MCP server (server → Claude) ───────────────────────────────────────────

const mcpServer = new Server({ name: 'flowsnap', version: VERSION }, { capabilities: { tools: {} } });

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_flows',
      description:
        'List recorded browser flows, newest first. Each entry has id, name, step count, start URL, and errorCount — how many steps logged a console error or got a failed/4xx/5xx response. Start here to find the recording to investigate.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_flow_errors',
      description:
        'Only the steps that failed in a flow: console errors, failed and 4xx/5xx network calls with their bodies, the element involved, and the screenshot path for each. Far smaller than get_flow — call this first when debugging something that broke. On a React app each failing step also names the component it happened in; get_flow has the table mapping those names to source files.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Flow ID from list_flows' } },
        required: ['id'],
      },
    },
    {
      name: 'get_flow',
      description:
        'The full recording: a markdown walkthrough plus the step JSON. Every step carries an absolute screenshotPath — read those image files directly with your own file tools, one at a time, rather than calling get_flow_screenshots. On a React app it also carries the source file and line of the component behind each step: read those files instead of searching the repo for the component by name.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Flow ID from list_flows' } },
        required: ['id'],
      },
    },
    {
      name: 'get_flow_screenshots',
      description:
        `Screenshots as base64 images, for at most ${MAX_IMAGES} steps per call. Only use this when you cannot read files from disk — otherwise read the screenshotPath values from get_flow, which costs nothing until you open one. Omit "steps" to list what is available without transferring any image data.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows' },
          steps: {
            type: 'array',
            items: { type: 'number' },
            description: `Step numbers, 1-based. Omit to list available screenshots and their paths.`,
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_latest_flow',
      description:
        'The most recent recording, as get_flow would return it. Shortcut for the common case of debugging what was just recorded.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

const text = (value) => ({ content: [{ type: 'text', text: value }] });
const failure = (value) => ({ content: [{ type: 'text', text: value }], isError: true });
const notFound = (id) => failure(`Flow "${id}" not found. Run list_flows to see what is available.`);

function flowPayload(dir, json, markdown, heading) {
  return {
    content: [
      { type: 'text', text: `${heading}\n\n${markdown}` },
      {
        type: 'text',
        text: `Screenshots are in ${path.join(dir, 'screenshots')} — read them directly.\n\n## Step data\n\n\`\`\`json\n${JSON.stringify(
          { ...json, steps: json.steps.map((s) => ({ ...s, screenshotPath: screenshotPath(dir, s) })) },
          null,
          2,
        )}\n\`\`\``,
      },
    ],
  };
}

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'list_flows': {
      const flows = await listAllFlows();
      if (!flows.length) {
        return text(
          `No flows recorded yet (looking in ${FLOWS_DIR}). Record one in the FlowSnap Chrome extension and press Send — it will appear here.`,
        );
      }
      return text(JSON.stringify(flows, null, 2));
    }

    case 'get_flow_errors': {
      let flow;
      try {
        flow = await readFlow(args.id);
      } catch {
        return notFound(args.id);
      }

      const broken = flow.json.steps
        .map((step, i) => ({ step, number: i + 1 }))
        .filter(({ step }) => consoleErrors(step).length > 0 || failedCalls(step).length > 0)
        .map(({ step, number }) => ({
          step: number,
          action: step.action,
          url: step.url,
          element: step.element?.cssSelector ?? null,
          // The one line that turns "something broke on this click" into a file
          // to open. Its path is in get_flow's table rather than repeated here.
          component: stepComponent(flow.json, step)?.name ?? undefined,
          screenshotPath: screenshotPath(flow.dir, step),
          consoleErrors: consoleErrors(step).map((entry) => truncate(entry.args.join(' '))),
          failedCalls: failedCalls(step).map((call) => ({
            method: call.method,
            url: call.url,
            status: call.status,
            durationMs: call.durationMs,
            requestBody: truncate(call.requestBody),
            responseBody: truncate(call.responseBody),
          })),
        }));

      if (!broken.length) {
        return text(
          `No step in "${flow.json.name}" logged a console error or a failed request. Call get_flow to read the whole recording.`,
        );
      }

      return text(
        `${broken.length} of ${flow.json.steps.length} steps in "${flow.json.name}" failed.\n\n\`\`\`json\n${JSON.stringify(broken, null, 2)}\n\`\`\``,
      );
    }

    case 'get_flow': {
      try {
        const { dir, json, markdown } = await readFlow(args.id);
        return flowPayload(dir, json, markdown, '## Walkthrough');
      } catch {
        return notFound(args.id);
      }
    }

    case 'get_flow_screenshots': {
      let flow;
      try {
        flow = await readFlow(args.id);
      } catch {
        return notFound(args.id);
      }

      const available = flow.json.steps
        .map((step, i) => ({ number: i + 1, file: screenshotPath(flow.dir, step) }))
        .filter((entry) => entry.file);

      if (!available.length) return text('No step in this flow has a screenshot.');

      if (!Array.isArray(args.steps) || args.steps.length === 0) {
        return text(
          `${available.length} screenshots. Read any of these directly, or pass "steps" to have them returned inline:\n\n${available
            .map((entry) => `- Step ${entry.number}: ${entry.file}`)
            .join('\n')}`,
        );
      }

      const wanted = available.filter((entry) => args.steps.includes(entry.number));
      if (!wanted.length) {
        return failure(
          `No screenshots for steps ${args.steps.join(', ')}. Available: ${available.map((e) => e.number).join(', ')}.`,
        );
      }

      const chosen = wanted.slice(0, MAX_IMAGES);
      const content = [];
      for (const entry of chosen) {
        const bytes = await fs.readFile(entry.file).catch(() => null);
        if (!bytes) continue;
        content.push({ type: 'text', text: `**Step ${entry.number}** — ${entry.file}` });
        content.push({
          type: 'image',
          data: bytes.toString('base64'),
          mimeType: entry.file.endsWith('.png') ? 'image/png' : 'image/jpeg',
        });
      }

      if (wanted.length > chosen.length) {
        content.push({
          type: 'text',
          text: `Returned ${chosen.length} of ${wanted.length} requested — ${MAX_IMAGES} is the per-call limit. Ask for the rest in another call, or read them from disk.`,
        });
      }

      return { content };
    }

    case 'get_latest_flow': {
      const flows = await listAllFlows();
      if (!flows.length) return text('No flows recorded yet.');
      try {
        const { dir, json, markdown } = await readFlow(flows[0].id);
        return flowPayload(dir, json, markdown, `## Latest flow: ${flows[0].name}`);
      } catch {
        return failure('The most recent flow could not be read.');
      }
    }

    default:
      return failure(`Unknown tool: ${name}`);
  }
});

if (!REMOTE) {
  await mcpServer.connect(new StdioServerTransport());
}
