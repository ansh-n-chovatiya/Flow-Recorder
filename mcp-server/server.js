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

/** The highest `FLOW_SCHEMA_VERSION` this server knows how to read. */
const SUPPORTED_SCHEMA = 1;

/**
 * Cap on a POSTed flow.
 *
 * The receiver listens on loopback and any page the user visits can reach it,
 * so the body is read into memory before anything has vouched for it. 500
 * screenshots at the extension's own limit come to well under this.
 */
const MAX_BODY_BYTES = 512 * 1024 * 1024;

/**
 * How much recorded history to keep, oldest evicted first.
 *
 * Nothing here ever deleted anything, so the directory grew for as long as the
 * user kept recording — a normal day of twenty twenty-step sends adds tens of
 * megabytes, forever, with no way to prune from the extension. Two ceilings
 * rather than one because they fail differently: a few enormous flows blow the
 * disk budget while the count looks fine, and a great many tiny ones blow the
 * count while the bytes look fine.
 *
 * Deliberately generous. This is a runaway guard, not a retention policy —
 * losing a recording someone still wanted is the worse failure, so the caps sit
 * far above any plausible working set and both are overridable.
 */
const MAX_FLOWS = Number(process.env.FLOWSNAP_MAX_FLOWS) || 200;
const MAX_FLOW_BYTES = Number(process.env.FLOWSNAP_MAX_BYTES) || 2 * 1024 * 1024 * 1024;

/**
 * How long a directory with no readable `meta.json` is left alone.
 *
 * `meta.json` is written last, so its absence means either a save happening
 * right now or one that failed part way. Waiting an hour tells those apart
 * without a lock.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

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

/**
 * Write via a sibling temp file and rename, so a reader never sees half a file.
 *
 * `rename` is atomic within a filesystem, and the temp file is a sibling so it
 * is always on the same one.
 */
async function writeAtomic(file, contents) {
  const temp = `${file}.tmp`;
  try {
    await fs.writeFile(temp, contents, 'utf8');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
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

/**
 * Only ever a file this server named itself.
 *
 * `screenshotFile` is minted in `saveFlow` and joined onto the flow's own
 * directory here. A POST that supplied its own would be choosing the path this
 * function returns — and `path.join` resolves `..` happily, so `flow.md`,
 * `get_flow`'s `screenshotPath` and `get_flow_screenshots` would between them
 * name, print and base64 any file the server can read. The id is already
 * validated by `flowDir`; this is the other half of the same rule.
 */
const SCREENSHOT_FILE = /^step-\d{2,}\.(png|jpg)$/;

/**
 * The sentence to say instead of "nothing failed", when nothing failed only
 * because the failures were never sent.
 *
 * The send dialog defaults to leaving console and network data on the machine,
 * so a recording made specifically to capture a 500 arrives with no networkCalls
 * at all. `countFailures` then honestly reports zero, and this tool told the
 * caller the run was clean — the single most misleading answer it could give,
 * to the question it exists to answer.
 */
function withheld(flow) {
  const missing = (flow.omitted ?? []).filter((section) => section === 'network' || section === 'logs');
  if (!missing.length) return null;

  const names = missing.map((section) => (section === 'network' ? 'network calls' : 'console logs'));
  return (
    `"${flow.name}" was sent without its ${names.join(' or ')}, so this tool cannot tell whether anything failed — ` +
    'it is not reporting a clean run. Re-send the flow from the FlowSnap extension with those switches on.'
  );
}

function screenshotPath(dir, step) {
  if (!step.screenshotFile || !SCREENSHOT_FILE.test(step.screenshotFile)) return null;
  return path.join(dir, 'screenshots', step.screenshotFile);
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
 * The feature component that one sits inside, if the flow says so.
 *
 * Written down by the extension beside the owner, and for the same reason: on an
 * app with a shared UI kit the owner is `Button`, correctly, and this is the
 * `CheckoutButton` that makes the step mean something.
 */
function stepEnclosing(flow, step) {
  const within = step.element?.react?.within;
  return within ? (flow.react?.components?.[within] ?? null) : null;
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
    if (component) {
      const within = stepEnclosing(flow, step);
      lines.push(`- **Component:** ${component.name}${within ? ` — in ${within.name}` : ''}`);
    }

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

/** Sections the extension can leave out of a send, in the order it names them. */
const OMITTABLE = ['images', 'network', 'logs', 'react'];

async function saveFlow(flow) {
  const dir = flowDir(flow.id);
  if (!dir) throw new Error(`Invalid flow id: ${flow.id}`);

  const omitted = Array.isArray(flow.omitted)
    ? OMITTABLE.filter((section) => flow.omitted.includes(section))
    : [];

  const screenshotsDir = path.join(dir, 'screenshots');
  await fs.mkdir(screenshotsDir, { recursive: true });

  // Images come off the steps and onto disk: a step's JSON is read into a
  // context window, and a base64 JPEG in the middle of it is pure waste.
  const staged = flow.steps.map((step, i) => {
    // `screenshotFile` is discarded with the images: it is this server's own
    // field, and a payload that arrives carrying one is not describing a
    // picture it sent — it is naming a path for `screenshotPath` to read back.
    const { screenshot, screenshotOriginal, screenshotFile: _claimed, ...rest } = step;
    // The annotated image, which carries a highlight around the element that
    // was clicked. The clean original is the fallback, not the preference —
    // knowing *which* button was pressed is most of a screenshot's value here.
    const dataUrl = screenshot || screenshotOriginal;
    if (!dataUrl || !dataUrl.startsWith('data:')) return { rest, pending: null };

    const ext = dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
    const screenshotFile = `step-${pad2(i + 1)}.${ext}`;
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    // Resolves to the name only if the bytes actually landed. A step labelled
    // with a file that is not on disk sends every later reader after it: the
    // markdown prints the path, `get_flow` returns it as `screenshotPath`, and
    // `get_flow_screenshots` skips it and answers with nothing at all — no
    // image, no error, no explanation.
    const pending = fs
      .writeFile(path.join(screenshotsDir, screenshotFile), Buffer.from(base64, 'base64'))
      .then(() => screenshotFile)
      .catch((error) => {
        log(`screenshot write failed for step ${i + 1}: ${error.message}`);
        return null;
      });
    return { rest, pending };
  });

  const stepsClean = await Promise.all(
    staged.map(async ({ rest, pending }) => {
      const screenshotFile = pending && (await pending);
      return screenshotFile ? { ...rest, screenshotFile } : rest;
    }),
  );

  const meta = {
    id: flow.id,
    name: flow.name,
    timestamp: flow.timestamp,
    stepCount: flow.steps.length,
    startUrl: flow.startUrl || flow.steps[0]?.url || null,
    // In the index so a caller can tell which recording is the broken one
    // without opening every flow.
    errorCount: countFailures(flow.steps),
    // What the sender chose not to hand over. Without this the server cannot
    // tell a recording where nothing failed from one whose console and network
    // data was never sent — and it reported both as "nothing failed", which is
    // the wrong answer to give someone debugging a failure.
    ...(omitted.length ? { omitted } : {}),
    schemaVersion: flow.schemaVersion ?? 1,
  };

  // Additive, and absent entirely when the page was not React — which is also
  // how every flow recorded before this existed reads.
  const data = { ...meta, steps: stepsClean, ...(flow.react ? { react: flow.react } : {}) };

  // Awaited, not fired and forgotten: the POST response tells the extension the
  // flow is readable, and a tool call can arrive immediately after it.
  //
  // Written to one side and renamed into place, because `writeFile` truncates
  // first: a disk that fills — or a re-send interrupted half way — used to
  // leave `flow.json` cut off mid-object where a complete one had been, and
  // `meta.json` still listed it. `list_flows` showed the flow, `get_flow` threw
  // in `JSON.parse` and answered "not found", pointing straight back at the
  // list that had just offered it. `meta.json` goes last for the same reason:
  // it is the file that makes a flow visible, so nothing is listed before it is
  // readable.
  await Promise.all([
    writeAtomic(path.join(dir, 'flow.json'), JSON.stringify(data, null, 2)),
    writeAtomic(path.join(dir, 'flow.md'), generateMarkdown(data, dir)),
  ]);
  await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta));

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

/** Bytes on disk under one flow directory. */
async function dirBytes(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirBytes(full);
    } else {
      const stat = await fs.stat(full).catch(() => null);
      if (stat) total += stat.size;
    }
  }
  return total;
}

/**
 * Delete the oldest flows until the store is back inside its ceilings.
 *
 * Ordered by when the flow was *recorded*, which is what "oldest" means to the
 * person who made it — not by when it was last sent. That does mean re-sending
 * an old recording stores something that is immediately the oldest thing there,
 * which is exactly why `keepId` exists: whatever this save just wrote is never
 * a candidate, however old the recording behind it is.
 *
 * Runs after the save rather than before it, so a flow is never evicted to make
 * room for one that then fails to write.
 */
async function enforceRetention(keepId) {
  const names = await fs
    .readdir(FLOWS_DIR, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    .catch(() => []);

  const flows = [];
  const evicted = [];

  for (const name of names) {
    const dir = path.join(FLOWS_DIR, name);
    let meta = null;
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    } catch {
      // No readable meta: a save in flight, or one that died part way. Only the
      // second is safe to touch, and only age can tell them apart.
      if (name === keepId) continue;
      const stat = await fs.stat(dir).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > ORPHAN_GRACE_MS) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        evicted.push({ id: name, reason: 'unreadable' });
      }
      continue;
    }

    if (name === keepId) continue;
    flows.push({ id: name, dir, at: Number(meta.timestamp) || 0, bytes: await dirBytes(dir) });
  }

  // Newest first, so what falls off the end of the list is the oldest.
  flows.sort((a, b) => b.at - a.at);

  const keptBytes = keepId ? await dirBytes(path.join(FLOWS_DIR, keepId)) : 0;
  let count = keepId ? 1 : 0;
  let bytes = keptBytes;

  for (const flow of flows) {
    count += 1;
    bytes += flow.bytes;
    if (count <= MAX_FLOWS && bytes <= MAX_FLOW_BYTES) continue;

    await fs.rm(flow.dir, { recursive: true, force: true }).catch(() => {});
    evicted.push({ id: flow.id, reason: count > MAX_FLOWS ? 'count' : 'size' });
    count -= 1;
    bytes -= flow.bytes;
  }

  // Said out loud rather than done quietly: a store that silently drops the
  // oldest recording reads as one that lost it.
  for (const gone of evicted) log(`evicted "${gone.id}" (${gone.reason})`);
  return evicted.map((gone) => gone.id);
}

// ── HTTP receiver (extension → server, and SSE MCP when remote) ────────────

const sseTransports = {};

/**
 * Whether a write may come from this caller.
 *
 * Any page the user happens to visit can reach a loopback port, and CORS does
 * not stop the request being *made* — only the reply being read. A page that
 * posts here could overwrite a real recording with one it wrote itself, and
 * everything downstream then presents it to the reader as their own. Extension
 * origins only; a request with no `Origin` at all is a local tool like curl,
 * which is not a page and cannot be driven by a visited site.
 */
function extensionOrigin(req) {
  const origin = req.headers.origin;
  return !origin || /^(chrome|moz)-extension:\/\//.test(origin);
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
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

  /*
   * Deleting a flow in the extension has to reach the disk.
   *
   * `deleteFlow` cleared `chrome.storage` and never contacted the server, so a
   * recording the user deleted — perhaps *because* they noticed it captured a
   * session token in a response body — stayed in `~/.flowsnap/flows` and was
   * still handed to Claude by the very next `list_flows`. The row vanished and
   * the extension reported success, which is the worst version of not deleting
   * something.
   */
  if (req.method === 'DELETE' && req.url?.startsWith('/flows/')) {
    if (!extensionOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Flows may only be deleted by the FlowSnap extension.' }));
      return;
    }

    const id = decodeURIComponent(req.url.slice('/flows/'.length));
    const dir = flowDir(id);
    if (!dir) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid flow id: ${id}` }));
      return;
    }

    try {
      // `force` so deleting a flow the server never received is a success, not
      // an error: the extension is the one saying it should be gone, and it has
      // no way to know whether this flow was ever sent.
      await fs.rm(dir, { recursive: true, force: true });
      log(`deleted "${id}"`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id }));
    } catch (error) {
      log(`error deleting flow: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/flows') {
    if (!extensionOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Flows may only be posted by the FlowSnap extension.' }));
      return;
    }

    try {
      let body = '';
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        // Read before anything has vouched for it, so it needs its own ceiling:
        // an unbounded concatenation is a page away from exhausting the heap of
        // the process the user's Claude session depends on.
        if (bytes > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Flow too large.' }));
          req.destroy();
          return;
        }
        body += chunk;
      }
      const flow = JSON.parse(body);

      if (!flow.id || !Array.isArray(flow.steps)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields: id, steps' }));
        return;
      }

      // The version is the only thing that tells this server which shape it has
      // been handed, and the two sides ship separately — so a server older than
      // the extension must say so rather than store a flow it will misread and
      // then answer questions about with confidence.
      if (Number(flow.schemaVersion ?? 1) > SUPPORTED_SCHEMA) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error:
              `This flow uses format v${flow.schemaVersion}, and flowsnap-mcp ${VERSION} understands ` +
              `up to v${SUPPORTED_SCHEMA}. Update the server: npx -y flowsnap-mcp@latest`,
          }),
        );
        return;
      }

      const meta = await saveFlow(flow);
      log(`saved "${meta.name}" — ${meta.stepCount} steps, ${meta.errorCount} with failures`);

      // Never allowed to fail the save: the flow is already on disk and readable,
      // and telling the extension otherwise would have it offer a retry that
      // stores a second copy.
      const evicted = await enforceRetention(meta.id).catch((error) => {
        log(`retention sweep failed: ${error.message}`);
        return [];
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          id: meta.id,
          name: meta.name,
          ...(evicted.length ? { evicted } : {}),
        }),
      );
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
        'Only the steps that failed in a flow: console errors, failed and 4xx/5xx network calls with their bodies, the element involved, and the screenshot path for each. Far smaller than get_flow — call this first when debugging something that broke. On a React app each failing step also carries the component it happened in and that component\'s source file and line — open that file directly rather than searching the repo.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Flow ID from list_flows' } },
        required: ['id'],
      },
    },
    {
      name: 'get_flow',
      description:
        'The full recording: a markdown walkthrough plus the step JSON. Every step carries an absolute screenshotPath — read those image files directly with your own file tools, one at a time, rather than calling get_flow_screenshots. On a React app it also carries the source file and line of the component behind each step, and the feature component that one is rendered inside: read those files instead of searching the repo for the component by name.',
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
        .map(({ step, number }) => {
          // What turns "something broke on this click" into a file to open. The
          // path is repeated here rather than left to get_flow's table: this
          // tool exists to be the cheap call, and sending a debugger to make the
          // expensive one just to learn *where* would undo that.
          const component = stepComponent(flow.json, step);
          const within = stepEnclosing(flow.json, step);

          return {
            step: number,
            action: step.action,
            url: step.url,
            element: step.element?.cssSelector ?? null,
            component: component?.name ?? undefined,
            componentSource: component ? (componentSource(component) ?? undefined) : undefined,
            componentWithin: within?.name ?? undefined,
            componentWithinSource: within ? (componentSource(within) ?? undefined) : undefined,
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
          };
        });

      if (!broken.length) {
        return text(
          withheld(flow.json) ??
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
