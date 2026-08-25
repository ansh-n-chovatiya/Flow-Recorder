/**
 * What the MCP server needs from `core/`, in one entry point.
 *
 * The server is published to npm as its own package and cannot import TypeScript
 * out of `src/`, so it used to carry a second markdown renderer written by hand
 * — 65 lines that had to agree with the 375 in `core/export/markdown.ts` and
 * did not. The good renderer omitted brittle selectors, printed a URL only when
 * the page changed, and escaped page text so a response body could not forge a
 * step heading; the server's printed the full URL and absolute screenshot path
 * on every step and escaped nothing. The careful one rendered the file a human
 * downloads. The weak one rendered what the model read.
 *
 * So `core/` is bundled into the server package instead (`npm run build:mcp`),
 * which is what `core/` being pure — no Chrome, no DOM, no clock — has always
 * been for. One renderer, one set of rules, one place to fix them.
 *
 * Nothing but re-exports belongs here. Anything this file pulls in is shipped to
 * npm, so it is deliberately narrow.
 */

export { exportToMarkdown, renderComponents, renderStep, flowHost, urlPath } from './export/markdown.js';
export { compactBody } from './schema/index.js';
export { callFailed, statusClass, stepFailed, worstLevel } from './flow/index.js';
export { stepEnclosing, stepOwner, formatSource } from './react/attribution.js';
