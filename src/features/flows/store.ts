/**
 * The flow store — the only place saved flows are read and written.
 *
 * The old viewer did this inline in six places, and two of them disagreed: an
 * edit made while viewing a saved flow re-rendered but was never written back
 * (audit F7), and deleting a flow cleared the index before the steps, so a
 * failure halfway left an orphaned `savedFlow_<id>` key that nothing could ever
 * reach or delete. Both orders are fixed here, once.
 *
 * Every function returns a `Result`. Storage has a 10 MB ceiling and saving a
 * flow is the single largest write the extension makes, so a full area is a
 * normal outcome to report — not an exception to swallow.
 */

import { countByType, countFailures, flowHost, renumber } from '../../core/flow/index.js';
import { buildFlowReact, pruneComponents } from '../../core/react/attribution.js';
import { getLocal, removeLocal, setLocal } from '../../chrome/storage.js';
import { sendToWorker } from '../../shared/messages.js';
import { err, ok, type Result } from '../../shared/result.js';
import { flowError } from '../../shared/errors.js';
import {
  savedFlowKey,
  savedFlowReactKey,
  type FlowMeta,
  type FlowReact,
  type Step,
} from '../../shared/types.js';
import { makeThumbnail } from './thumbnail.js';

/** A flow and its steps, whether it is the live recording or an archived one. */
export interface Flow {
  /** `null` is the recording in progress, which has no id until it is saved. */
  id: string | null;
  name: string;
  steps: Step[];
  meta: FlowMeta | null;
  /** Absent when the flow was not recorded on a React page. */
  react: FlowReact | null;
}

/** The name the unsaved recording is shown under until it is given one. */
export const CURRENT_FLOW_NAME = 'Current recording';

// ── The index ────────────────────────────────────────────────────────────────

export async function listFlows(): Promise<Result<FlowMeta[]>> {
  const stored = await getLocal('savedFlowsMeta');
  if (!stored.ok) return stored;

  const meta = stored.value.savedFlowsMeta;
  // Newest first: the flow someone wants is almost always the last one recorded.
  return ok(Array.isArray(meta) ? [...meta].sort((a, b) => b.createdAt - a.createdAt) : []);
}

function writeIndex(flows: FlowMeta[]): Promise<Result<void>> {
  return setLocal({ savedFlowsMeta: flows });
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * The recording in progress.
 *
 * The worker is asked first because it holds steps that may not have been
 * flushed yet, but it may also be asleep — in which case storage is the truth,
 * exactly as it was before.
 */
export async function readCurrent(): Promise<Result<Step[]>> {
  const live = await sendToWorker({ type: 'GET_STEPS' });
  if (live?.steps.length) return ok(live.steps);

  const stored = await getLocal('recordedSteps');
  if (!stored.ok) return stored;

  const steps = stored.value.recordedSteps;
  return ok(Array.isArray(steps) ? steps : []);
}

export function writeCurrent(steps: Step[]): Promise<Result<void>> {
  return setLocal({ recordedSteps: steps });
}

/**
 * The live recording's React components, pruned to the steps given.
 *
 * The resolver writes `reactComponents` continuously while a recording runs, so
 * this is a snapshot of an answer that is still being filled in — which is
 * exactly why it is read at the moment it is needed rather than held anywhere.
 * A read that fails costs the flow its component table and nothing else.
 */
export async function readCurrentReact(steps: Step[]): Promise<FlowReact | null> {
  const stored = await getLocal(['reactComponents', 'reactMeta']);
  if (!stored.ok) return null;

  return buildFlowReact(steps, stored.value.reactMeta ?? null, stored.value.reactComponents ?? {}) ?? null;
}

/**
 * One saved flow. `null` means the id is not in storage — a link to a flow that
 * has since been deleted, which the viewer shows as a missing flow rather than
 * as an empty one.
 */
export async function readFlow(id: string): Promise<Result<Flow | null>> {
  const flows = await listFlows();
  if (!flows.ok) return flows;

  const meta = flows.value.find((flow) => flow.id === id) ?? null;
  if (!meta) return ok(null);

  const key = savedFlowKey(id);
  const reactKey = savedFlowReactKey(id);
  const stored = await getLocal([key, reactKey]);
  if (!stored.ok) return stored;

  const steps = stored.value[key];
  if (!Array.isArray(steps)) return ok(null);

  // Flows archived before components were captured have no such key at all.
  const react = (stored.value[reactKey] as FlowReact | undefined) ?? null;

  return ok({ id, name: meta.name, steps: steps as Step[], meta, react });
}

// ── Describing ───────────────────────────────────────────────────────────────

/**
 * Everything the library shows about a flow without opening it.
 *
 * Derived here, at write time, because the alternative is deriving it at read
 * time for every flow in the list — which means loading every flow's steps, and
 * an index whose entries cost as much as the things they index is not an index.
 */
export async function describeFlow(
  id: string,
  name: string,
  steps: Step[],
  createdAt: number,
  /**
   * Reuse an existing thumbnail instead of redrawing one. Editing a note is a
   * write, and decoding and re-encoding a full-page screenshot every time
   * somebody leaves a textarea is work with nothing to show for it.
   */
  thumbnail?: string | null,
): Promise<FlowMeta> {
  return {
    id,
    name,
    createdAt,
    stepCount: steps.length,
    host: flowHost(steps),
    bytes: approximateBytes(steps),
    thumbnail: thumbnail === undefined ? await makeThumbnail(steps) : thumbnail,
    counts: countByType(steps),
    errorCount: countFailures(steps),
  };
}

/**
 * Roughly what this flow costs in storage.
 *
 * `JSON.stringify().length` counts UTF-16 code units, not the UTF-8 bytes Chrome
 * charges against the quota. For a flow it is close enough to be useful: the
 * overwhelming majority of the payload is base64 screenshot data, which is ASCII
 * and so counts one for one. It is shown as a size, never used as a guard.
 */
export function approximateBytes(steps: Step[]): number {
  try {
    return JSON.stringify(steps).length;
  } catch {
    return 0;
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * Archive the recording in progress under a name.
 *
 * Archiving is the moment a flow stops changing, so it is also the moment its
 * component table is frozen: one last resolve pass while the recorded pages may
 * still be open and their bundles still cached, then a snapshot. The pass is
 * asked to be final; the worker refuses that if a recording is still running,
 * because writing pending components off as skipped would then be a lie.
 */
export async function saveAsFlow(name: string, steps: Step[]): Promise<Result<FlowMeta>> {
  if (steps.length === 0) return err(flowError('STORAGE_WRITE', 'nothing to save'));

  const id = `flow_${Date.now()}`;
  const numbered = renumber(steps);
  const meta = await describeFlow(id, name, numbered, Date.now());

  await sendToWorker({ type: 'RESOLVE_COMPONENTS', final: true });
  const react = await readCurrentReact(numbered);

  // Steps first: if the index write fails, the orphaned key is overwritten by
  // the next save with the same timestamp-derived id or cleaned up by "delete
  // all". If the index went first and the steps failed, the library would list a
  // flow that cannot be opened.
  const written = await setLocal({
    [savedFlowKey(id)]: numbered,
    ...(react ? { [savedFlowReactKey(id)]: react } : {}),
  });
  if (!written.ok) return written;

  const flows = await listFlows();
  if (!flows.ok) return flows;

  const indexed = await writeIndex([meta, ...flows.value]);
  if (!indexed.ok) return indexed;

  return ok(meta);
}

/**
 * Persist an edit to a saved flow.
 *
 * The old viewer re-rendered these and dropped them on the floor: deleting a
 * step or writing a note while viewing a saved flow looked like it worked until
 * the flow was reopened.
 */
export async function updateFlowSteps(id: string, steps: Step[]): Promise<Result<void>> {
  const flows = await listFlows();
  if (!flows.ok) return flows;

  const existing = flows.value.find((flow) => flow.id === id);
  if (!existing) return err(flowError('STORAGE_WRITE', `no flow ${id}`));

  const numbered = renumber(steps);

  /*
   * Deleting a step has to drop the components only that step reached, or the
   * flow keeps shipping source paths for code nothing in it points at any more.
   * Pruning against the surviving steps is idempotent, so an edit that changed
   * nothing structural rewrites the same table.
   */
  const stored = await getLocal(savedFlowReactKey(id));
  const react = stored.ok ? (stored.value[savedFlowReactKey(id)] as FlowReact | undefined) : undefined;

  const written = await setLocal({
    [savedFlowKey(id)]: numbered,
    ...(react ? { [savedFlowReactKey(id)]: { ...react, components: pruneComponents(numbered, react.components) } } : {}),
  });
  if (!written.ok) return written;

  // The step count is the signal that the *shape* of the flow changed and the
  // thumbnail may now be of a step that is gone. An edit to a note or a title
  // leaves it alone.
  const structural = existing.stepCount !== numbered.length;
  const meta = await describeFlow(
    id,
    existing.name,
    numbered,
    existing.createdAt,
    structural ? undefined : (existing.thumbnail ?? null),
  );

  return writeIndex(flows.value.map((flow) => (flow.id === id ? meta : flow)));
}

export async function renameFlow(id: string, name: string): Promise<Result<void>> {
  const flows = await listFlows();
  if (!flows.ok) return flows;

  return writeIndex(flows.value.map((flow) => (flow.id === id ? { ...flow, name } : flow)));
}

/**
 * Delete a flow, and hand back what it took so it can be put back.
 *
 * The index entry is removed *after* the steps: a failure between the two leaves
 * a flow that is listed and openable, which is recoverable. The other order
 * leaves bytes in a 10 MB store that nothing can name.
 */
export async function deleteFlow(id: string): Promise<Result<DeletedFlow>> {
  const flow = await readFlow(id);
  if (!flow.ok) return flow;
  if (!flow.value?.meta) return err(flowError('STORAGE_WRITE', `no flow ${id}`));

  const removed = await removeLocal([savedFlowKey(id), savedFlowReactKey(id)]);
  if (!removed.ok) return removed;

  const flows = await listFlows();
  if (!flows.ok) return flows;

  const indexed = await writeIndex(flows.value.filter((entry) => entry.id !== id));
  if (!indexed.ok) return indexed;

  return ok({ meta: flow.value.meta, steps: flow.value.steps, react: flow.value.react });
}

/** Everything a delete took, which is everything an undo has to put back. */
export interface DeletedFlow {
  meta: FlowMeta;
  steps: Step[];
  react: FlowReact | null;
}

/** Put a deleted flow back, for the undo on the toast. */
export async function restoreFlow(
  meta: FlowMeta,
  steps: Step[],
  react: FlowReact | null = null,
): Promise<Result<void>> {
  const written = await setLocal({
    [savedFlowKey(meta.id)]: steps,
    ...(react ? { [savedFlowReactKey(meta.id)]: react } : {}),
  });
  if (!written.ok) return written;

  const flows = await listFlows();
  if (!flows.ok) return flows;

  return writeIndex([meta, ...flows.value.filter((entry) => entry.id !== meta.id)]);
}
