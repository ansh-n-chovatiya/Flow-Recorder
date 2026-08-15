/**
 * Viewer controller: owns the state, routes between the two views, and is the
 * only place either of them talks to storage.
 *
 * The file it replaces was 1,496 lines holding the whole flow-management product
 * — save, load, delete, edit, annotate, export, transmit — with no seam between
 * UI and Chrome APIs. What is left here is a router and a state object; every
 * decision it used to make inline now lives in a pure module with tests.
 */

import { bytesInUse, getLocal } from '../../chrome/storage.js';
import { flowHost } from '../../core/flow/index.js';
import {
  CURRENT_FLOW_NAME,
  listFlows,
  readCurrent,
  readFlow,
  saveAsFlow,
  updateFlowSteps,
  writeCurrent,
} from '../../features/flows/store.js';
import type { RecordingState, Step } from '../../shared/types.js';
import { formatDateTime } from '../format.js';
import { hydrateIcons } from '../icons.js';
import { initTheme } from '../theme.js';
import { showToast } from '../toast.js';
import type { App, ViewerState } from './app.js';
import { askName } from './dialogs.js';
import { mountLibrary, showLibrary } from './library.js';
import { mountReview, showReview } from './review.js';
import { parseRoute, routeHash, sameRoute, type Route } from './route.js';

initTheme();
hydrateIcons();

const state: ViewerState = {
  route: parseRoute(location.hash),
  flows: null,
  current: null,
  usedBytes: null,
  query: '',
  sort: 'recent',
  flow: null,
  missing: false,
  filter: 'all',
  activeIndex: null,
  undo: [],
};

const app: App = {
  state,
  navigate,
  paint,
  reload,
  commit,
};

const library = mountLibrary(app, () => void saveCurrent());
const review = mountReview(app, () => void saveCurrent());

// ── Painting ─────────────────────────────────────────────────────────────────

function paint(): void {
  const onLibrary = state.route.view === 'library';

  showLibrary(onLibrary);
  showReview(!onLibrary);

  if (onLibrary) library.paint();
  else review.paint();
}

// ── Routing ──────────────────────────────────────────────────────────────────

function navigate(route: Route): void {
  if (sameRoute(route, state.route)) return;

  location.hash = routeHash(route);
  // `hashchange` does the rest, so a click and a Back button take one path.
}

window.addEventListener('hashchange', () => {
  const next = parseRoute(location.hash);
  if (sameRoute(next, state.route)) return;

  state.route = next;
  // Leaving a flow clears what only made sense inside it. The undo stack in
  // particular: offering to restore a step into a flow you are no longer
  // looking at is a promise the screen cannot show you being kept.
  state.flow = null;
  state.missing = false;
  state.filter = 'all';
  state.activeIndex = null;
  state.undo = [];

  paint();
  void reload();
  window.scrollTo({ top: 0 });
});

// ── Reading ──────────────────────────────────────────────────────────────────

async function readRecordingState(): Promise<RecordingState> {
  const stored = await getLocal(['recordingActive', 'recordingPaused']);
  if (!stored.ok) return 'idle';

  return stored.value.recordingActive
    ? stored.value.recordingPaused
      ? 'paused'
      : 'recording'
    : 'idle';
}

async function reload(): Promise<void> {
  const [steps, recording] = await Promise.all([readCurrent(), readRecordingState()]);
  state.current = { steps: steps.ok ? steps.value : [], recording };

  if (state.route.view === 'library') {
    const [flows, used] = await Promise.all([listFlows(), bytesInUse()]);

    state.flows = flows.ok ? flows.value : [];
    state.usedBytes = used;
    if (!flows.ok) showToast({ message: flows.error.message, tone: 'danger' });

    paint();
    return;
  }

  if (state.route.id === null) {
    state.flow = {
      id: null,
      name: CURRENT_FLOW_NAME,
      steps: state.current.steps,
      createdAt: state.current.steps[0]?.timestamp ?? null,
    };
    state.missing = false;
    paint();
    return;
  }

  const flow = await readFlow(state.route.id);
  if (!flow.ok) {
    state.missing = true;
    showToast({ message: flow.error.message, tone: 'danger' });
  } else if (!flow.value) {
    state.missing = true;
  } else {
    state.flow = {
      id: flow.value.id,
      name: flow.value.name,
      steps: flow.value.steps,
      createdAt: flow.value.meta?.createdAt ?? null,
    };
    state.missing = false;
  }

  paint();
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * When we last wrote, so our own change does not come back as an external one.
 *
 * `storage.onChanged` fires for every write including ours, and reacting to it
 * would rebuild the step list under the user on every note they finish typing.
 * The window is deliberately short: a recording running in another tab is still
 * picked up, just on its next capture rather than this one.
 */
let selfWriteAt = 0;
const SELF_WRITE_WINDOW_MS = 500;

/** Write the open flow's steps back to wherever they came from. */
async function commit(steps: Step[]): Promise<void> {
  const { flow } = state;
  if (!flow) return;

  selfWriteAt = Date.now();

  const written =
    flow.id === null ? await writeCurrent(steps) : await updateFlowSteps(flow.id, steps);

  if (!written.ok) {
    // The write failed, so the screen is now showing something that is not
    // stored. Re-reading is the only honest response.
    showToast({ message: written.error.message, tone: 'danger' });
    await reload();
    return;
  }

  if (flow.id === null && state.current) state.current.steps = steps;
}

async function saveCurrent(): Promise<void> {
  const steps = state.current?.steps ?? [];
  if (steps.length === 0) {
    showToast({ message: 'There is nothing to save yet.' });
    return;
  }

  const name = await askName({
    title: 'Save this recording',
    label: 'Flow name',
    value: suggestName(steps),
    confirmLabel: 'Save flow',
  });
  if (!name) return;

  const saved = await saveAsFlow(name, steps);
  if (!saved.ok) {
    showToast({ message: saved.error.message, tone: 'danger' });
    return;
  }

  await reload();
  showToast({
    message: `Saved “${name}” to the library.`,
    tone: 'success',
  });
}

/**
 * What to call a recording, before the user renames it.
 *
 * The page's own title first: "ChatGPT" says what the flow is about in a way
 * that "chatgpt.com — 3 steps" does not, and the row underneath already prints
 * the step count, the host and the size. A name that repeats the line below it
 * is a name doing no work.
 */
function suggestName(steps: Step[]): string {
  const title = steps.find((step) => step.title?.trim())?.title?.trim();
  if (title) return title.slice(0, 80);

  const host = flowHost(steps);
  return host || `Recording — ${formatDateTime(Date.now())}`;
}

// ── Live updates ─────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  const watched = ['recordedSteps', 'recordingActive', 'recordingPaused', 'savedFlowsMeta'];
  if (!watched.some((key) => key in changes)) return;
  if (Date.now() - selfWriteAt < SELF_WRITE_WINDOW_MS) return;

  // A recording running in another tab changes the flow under our feet. Only
  // the library and the live flow follow it; a saved flow being reviewed is not
  // affected by what the recorder is doing.
  const reviewingSaved = state.route.view === 'review' && state.route.id !== null;
  if (reviewingSaved && !('savedFlowsMeta' in changes)) return;

  void reload();
});

// ── Start ────────────────────────────────────────────────────────────────────

// The route decides which view is on screen before anything is read, so the
// right skeleton is showing while it loads rather than the wrong one.
paint();
void reload();
