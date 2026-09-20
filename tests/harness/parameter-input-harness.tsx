/**
 * P4 Electron acceptance harness for the parameter input decoupling (P3).
 *
 * This file is a test asset, not shipping code. It is bundled by
 * `scripts/verify-parameter-input-electron.cjs`, injected into a hidden
 * Electron BrowserWindow that loads the production preload, and driven from the
 * main process. It is the strongest available evidence short of a human click
 * session: real Electron renderer, real React commit path, real rsuite controls,
 * real input events.
 *
 * What it measures (all numbers are returned to the main process as JSON):
 * - input event → updated text visible in the DOM, per keystroke (p50/p95/max);
 * - whole-draft replacements the parent performed while typing;
 * - candidate refreshes triggered while typing;
 * - that an invalid intermediate value is visible, editable and never committed;
 * - that the explicit flush before save/submit commits the focused control;
 * - that a remount (reopen) shows the committed value, not a stale one.
 *
 * Scope limit, stated plainly: this page mounts the parameter form on its own,
 * not the video/image workbench. Workbench-level wiring is covered by
 * tests/ui/parameter-input-decoupling.test.mjs (source contracts) and remains
 * part of the human acceptance pass.
 */

import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DynamicParameterForm,
  type DynamicParameterField,
  type DynamicParameterFormHandle,
  type DynamicParameterValue,
  validateDynamicParameterValues
} from '../../src/components/DynamicParameterForm';
import { reportParameterInputCandidateRequest } from '../../src/ui/parameter-input-performance-probe';

const fields: readonly DynamicParameterField[] = [
  {
    fieldId: 'provider.parameter.prompt',
    labelId: 'prompt',
    valueType: 'string',
    required: false
  },
  {
    fieldId: 'provider.parameter.duration',
    labelId: 'duration',
    valueType: 'number',
    required: false,
    minimum: 1,
    maximum: 60
  },
  {
    fieldId: 'provider.parameter.frames',
    labelId: 'frames',
    valueType: 'number_array',
    required: false,
    minimum: 1,
    maximum: 240
  },
  {
    fieldId: 'provider.parameter.metadata',
    labelId: 'metadata',
    valueType: 'object',
    required: false
  },
  {
    fieldId: 'provider.parameter.mode',
    labelId: 'mode',
    valueType: 'enum',
    required: false,
    options: ['auto', 'high']
  },
  {
    fieldId: 'provider.parameter.watermark',
    labelId: 'watermark',
    valueType: 'boolean',
    required: false
  }
];

interface HarnessCounters {
  /** Whole-draft replacements the parent performed. */
  parentCommits: number;
  /** Candidate-list refreshes the parent would have issued. */
  candidateRefreshes: number;
  /** Renders of the parameter host. */
  hostRenders: number;
}

const counters: HarnessCounters = {
  parentCommits: 0,
  candidateRefreshes: 0,
  hostRenders: 0
};

let currentValues: Record<string, DynamicParameterValue | undefined> = {};
let currentErrors: Record<string, string> = {};
let formHandle: DynamicParameterFormHandle | null = null;
let remount: (() => void) | null = null;
let mounted = false;

function ParameterHost() {
  const [values, setValues] = useState<Record<string, DynamicParameterValue | undefined>>({});
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [mountKey, setMountKey] = useState(0);
  const handleRef = useRef<DynamicParameterFormHandle>(null);
  const firstRender = useRef(true);
  counters.hostRenders += 1;

  currentValues = values;
  currentErrors = inputErrors;
  remount = () => setMountKey((key) => key + 1);

  // Refs are attached after the first render, so readiness is published from an
  // effect rather than from the render pass.
  useEffect(() => {
    formHandle = handleRef.current;
    mounted = true;
  });

  // Models the workbench: a candidate read is a consequence of a *committed*
  // draft change, never of a keystroke.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    counters.candidateRefreshes += 1;
    reportParameterInputCandidateRequest();
  }, [values]);

  const handleChange = useCallback((
    fieldId: string,
    value: DynamicParameterValue | undefined
  ) => {
    counters.parentCommits += 1;
    setValues((current) => {
      const next = { ...current };
      if (value === undefined) delete next[fieldId];
      else next[fieldId] = value;
      return next;
    });
  }, []);

  const validation = validateDynamicParameterValues(fields, values, inputErrors);

  return (
    <DynamicParameterForm
      key={mountKey}
      ref={handleRef}
      errors={validation.errors}
      fields={fields}
      surface="video_generation"
      onInputErrorChange={(fieldId, error) => {
        setInputErrors((current) => {
          const next = { ...current };
          if (error) next[fieldId] = error;
          else delete next[fieldId];
          return next;
        });
      }}
      onChange={handleChange}
      values={values}
    />
  );
}

function shell(valueType: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `.uc-dynamic-parameters__field[data-value-type="${valueType}"]`
  );
  if (!element) throw new Error(`missing control for value type ${valueType}`);
  return element;
}

function control(valueType: string, selector = 'input, textarea'): HTMLInputElement | HTMLTextAreaElement {
  const element = shell(valueType).querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!element) throw new Error(`missing ${selector} for value type ${valueType}`);
  return element;
}

/** One real keystroke: set the native value, then let React see the input event. */
function typeInto(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string
): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, text);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Focuses a control and settles the resulting render before typing into it.
 *
 * rsuite controls re-render on focus (their focus ring is React state). A
 * keystroke dispatched while that render is still settling can be ignored by
 * React's controlled-input value tracker, which silently drops the change and
 * makes a scenario fail for a harness reason rather than a product one. A real
 * user cannot type into a control they have not finished focusing, so the
 * harness waits for the frame that follows the focus.
 */
async function focusThenType(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string
): Promise<void> {
  element.focus();
  await settle();
  typeInto(element, text);
  await settle();
}

/**
 * Blur the focused control.
 *
 * React maps `onBlur` to the bubbling `focusout` event. A hidden BrowserWindow
 * does not always hold OS-level focus, which can make `element.blur()` a no-op
 * even while the element is `document.activeElement`, so when the native call
 * produces no `focusout` the very event a browser would send is dispatched
 * directly. The return value records which path was taken, so the evidence can
 * never hide a harness workaround behind a pass.
 */
async function blur(element: HTMLElement): Promise<{ native: boolean }> {
  let sawFocusOut = false;
  const observer = () => {
    sawFocusOut = true;
  };
  element.addEventListener('focusout', observer, true);
  element.blur();
  if (!sawFocusOut) {
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }
  element.removeEventListener('focusout', observer, true);
  await settle();
  return { native: sawFocusOut };
}

/**
 * Yields one macrotask so React has finished applying the update.
 *
 * This must NOT be `requestAnimationFrame`: rAF is driven by compositing, and a
 * hidden BrowserWindow pauses compositing, so a "frame" can take hundreds of
 * milliseconds or never arrive. That is longer than the 600 ms idle commit
 * boundary this harness has to outrun, which silently turned boundary
 * assertions into races (the idle timer committed first, so the blur had
 * nothing left to commit). React flushes the update for a discrete `input` event
 * synchronously before the event dispatch returns, so a macrotask is both
 * sufficient and immune to window visibility.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function alertText(valueType: string): string | undefined {
  return shell(valueType).querySelector('[role="alert"]')?.textContent ?? undefined;
}

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return Math.round((sorted[Math.max(0, index)] ?? 0) * 100) / 100;
}

interface ScenarioResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

interface AcceptanceReport {
  readonly scenarios: readonly ScenarioResult[];
  readonly latency: {
    readonly samples: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
  };
  readonly burst: {
    readonly keystrokes: number;
    readonly parentCommitsDuringTyping: number;
    readonly candidateRefreshesDuringTyping: number;
    readonly parentCommitsAfterIdle: number;
    readonly candidateRefreshesAfterIdle: number;
    readonly burstDurationMs: number;
  };
  /** Evidence about the harness itself, so a false pass cannot be silent. */
  readonly harness: {
    readonly devBuild: boolean;
    readonly hostRenders: number;
    readonly dom: Readonly<Record<string, string>>;
  };
}

async function runAcceptance(): Promise<AcceptanceReport> {
  const scenarios: ScenarioResult[] = [];
  const record = (name: string, passed: boolean, detail: string) => {
    scenarios.push({ name, passed, detail });
  };

  const textElement = control('string');
  const metadataElement = control('object', 'textarea');
  const framesElement = control('number_array');
  const durationElement = control('number');

  // --- 1. N consecutive keystrokes: local buffer only -----------------------
  const burstStart = counters.parentCommits;
  const burstCandidateStart = counters.candidateRefreshes;
  const burstBegin = performance.now();
  const burstSize = 30;
  for (let index = 1; index <= burstSize; index += 1) {
    typeInto(textElement, 'a'.repeat(index));
  }
  const burstDurationMs = performance.now() - burstBegin;
  const commitsDuringTyping = counters.parentCommits - burstStart;
  const candidateRefreshesDuringTyping = counters.candidateRefreshes - burstCandidateStart;
  record(
    'typing performs no whole-draft replacement',
    commitsDuringTyping === 0,
    `${burstSize} keystrokes → ${commitsDuringTyping} parent commits`
  );
  record(
    'typing issues no candidate refresh',
    candidateRefreshesDuringTyping === 0,
    `${burstSize} keystrokes → ${candidateRefreshesDuringTyping} candidate refreshes`
  );
  record(
    'the last keystroke is visible immediately',
    textElement.value === 'a'.repeat(burstSize),
    `control shows "${textElement.value.slice(0, 8)}…" (length ${textElement.value.length})`
  );

  // --- 2. The idle boundary commits exactly once, then the parent reacts -----
  await sleep(900);
  const commitsAfterIdle = counters.parentCommits - burstStart;
  const candidateRefreshesAfterIdle = counters.candidateRefreshes - burstCandidateStart;
  record(
    'the idle boundary commits the stable value exactly once',
    commitsAfterIdle === 1,
    `parent commits after idle: ${commitsAfterIdle}`
  );
  record(
    'the candidate refresh follows the commit, not the keystroke',
    candidateRefreshesAfterIdle === 1 && currentValues['provider.parameter.prompt'] === 'a'.repeat(burstSize),
    `candidate refreshes after idle: ${candidateRefreshesAfterIdle}, committed value length ${String(currentValues['provider.parameter.prompt'] ?? '').length}`
  );

  // --- 3. input → visible latency, one macrotask apart -----------------------
  const latencies: number[] = [];
  let staleReads = 0;
  for (let index = 0; index < burstSize; index += 1) {
    const text = 'b'.repeat(index + 1);
    const start = performance.now();
    typeInto(textElement, text);
    // Measure until the value is both present and survives a settled render; a
    // macrotask yield is the barrier that proves React applied the update.
    if (textElement.value !== text) await settle();
    const elapsed = performance.now() - start;
    if (textElement.value !== text) staleReads += 1;
    latencies.push(elapsed);
  }
  const latency = {
    samples: latencies.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs: percentile(latencies, 1)
  };
  record(
    'input → visible latency stays under the 100 ms acceptance target',
    staleReads === 0 && latency.p95Ms < 100,
    `p50 ${latency.p50Ms} ms, p95 ${latency.p95Ms} ms, max ${latency.maxMs} ms, stale reads ${staleReads}`
  );
  await sleep(900);

  // --- 4. Blur commits the stable value ------------------------------------
  const blurStartValues = currentValues['provider.parameter.duration'];
  await focusThenType(durationElement, '12');
  const blurFocused = document.activeElement === durationElement;
  const blurVisible = durationElement.value;
  const commitsBeforeBlur = counters.parentCommits;
  const blurSource = await blur(durationElement);
  const commitsAfterBlur = counters.parentCommits - commitsBeforeBlur;
  const committedDuration = currentValues['provider.parameter.duration'];
  record(
    'blur commits the stable value even before the idle boundary',
    commitsAfterBlur === 1 && committedDuration === 12,
    `duration ${String(blurStartValues)} → ${String(committedDuration)}, ` +
      `commits ${commitsAfterBlur}, focused ${blurFocused}, visible "${blurVisible}", ` +
      `blur via ${blurSource.native ? 'native' : 'focusout'}`
  );

  // --- 5. Invalid intermediate stays visible, editable and uncommitted -------
  await focusThenType(metadataElement, '{ "a": ');
  const jsonError = alertText('object');
  const commitsBeforeInvalid = counters.parentCommits;
  await blur(metadataElement);
  record(
    'invalid JSON is reported instead of committed',
    Boolean(jsonError) && counters.parentCommits === commitsBeforeInvalid,
    `message: ${jsonError ?? 'none'}; commits ${counters.parentCommits - commitsBeforeInvalid}; text kept: ${metadataElement.value === '{ "a": '}`
  );
  const commitsBeforeFix = counters.parentCommits;
  await focusThenType(metadataElement, '{ "a": 1 }');
  await blur(metadataElement);
  const fixed = currentValues['provider.parameter.metadata'];
  record(
    'fixing the JSON commits the parsed object',
    counters.parentCommits === commitsBeforeFix + 1 &&
      typeof fixed === 'object' && fixed !== null && !Array.isArray(fixed) &&
      (fixed as Record<string, unknown>).a === 1 && alertText('object') === undefined,
    `committed value: ${JSON.stringify(fixed)}`
  );

  // --- 6. A trailing comma is mid-typing, not a broken array ----------------
  await focusThenType(framesElement, '1, 2,');
  const arrayError = alertText('number_array');
  await blur(framesElement);
  const frames = currentValues['provider.parameter.frames'];
  record(
    'a trailing comma settles the completed items without an error',
    arrayError === undefined && Array.isArray(frames) &&
      frames.length === 2 && frames[0] === 1 && frames[1] === 2,
    `message: ${arrayError ?? 'none'}; committed: ${JSON.stringify(frames)}`
  );

  // --- 7. Explicit flush commits the focused control (save/submit path) ------
  await focusThenType(textElement, 'final prompt text');
  const commitsBeforeFlush = counters.parentCommits;
  const committedWithoutFlush =
    currentValues['provider.parameter.prompt'] === 'final prompt text';
  const flushed = formHandle?.flush();
  await settle();
  record(
    'the save/submit flush commits the focused control',
    !committedWithoutFlush &&
      counters.parentCommits === commitsBeforeFlush + 1 &&
      currentValues['provider.parameter.prompt'] === 'final prompt text' &&
      (flushed?.committedFieldIds ?? []).includes('provider.parameter.prompt'),
    `committed before flush: ${committedWithoutFlush}; flushed fields: ${JSON.stringify(flushed?.committedFieldIds ?? [])}`
  );

  // --- 8. Reopening shows the committed value, not a stale buffer -----------
  remount?.();
  await settle();
  await settle();
  const reopened = control('string');
  record(
    'reopening the form shows the committed value',
    reopened.value === 'final prompt text',
    `control shows "${reopened.value}"`
  );

  // --- 9. Discrete controls commit immediately (no buffering) ---------------
  // rsuite renders `Toggle` as `<label class="rs-toggle">` wrapping a real
  // `<input type="checkbox">`. The label comes first in document order, but a
  // programmatic click on it does not reliably activate the control, so the
  // checkbox itself is the click target — the same element a user's pointer
  // ends up activating.
  const booleanShell = shell('boolean');
  const toggleInput = booleanShell.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (toggleInput) {
    const commitsBeforeToggle = counters.parentCommits;
    toggleInput.click();
    await settle();
    record(
      'a discrete control commits on its own interaction',
      counters.parentCommits === commitsBeforeToggle + 1 &&
        currentValues['provider.parameter.watermark'] === true,
      `watermark ${String(currentValues['provider.parameter.watermark'])}, commits ${counters.parentCommits - commitsBeforeToggle}, checked ${toggleInput.checked}`
    );
  } else {
    record(
      'a discrete control commits on its own interaction',
      false,
      `checkbox not found in ${booleanShell.innerHTML.replace(/\s+/gu, ' ').slice(0, 200)}`
    );
  }

  return {
    scenarios,
    latency,
    burst: {
      keystrokes: burstSize,
      parentCommitsDuringTyping: commitsDuringTyping,
      candidateRefreshesDuringTyping: candidateRefreshesDuringTyping,
      parentCommitsAfterIdle: commitsAfterIdle,
      candidateRefreshesAfterIdle: candidateRefreshesAfterIdle,
      burstDurationMs: Math.round(burstDurationMs * 100) / 100
    },
    harness: {
      devBuild: Boolean(import.meta.env?.DEV),
      hostRenders: counters.hostRenders,
      dom: Object.fromEntries(
        ['string', 'number', 'number_array', 'object', 'enum', 'boolean'].map((valueType) => [
          valueType,
          shell(valueType).innerHTML.replace(/\s+/gu, ' ').slice(0, 300)
        ])
      )
    }
  };
}

declare global {
  interface Window {
    __parameterInputHarness?: {
      ready: boolean;
      counters: HarnessCounters;
      run: () => Promise<AcceptanceReport>;
      snapshot: () => {
        readonly values: Record<string, DynamicParameterValue | undefined>;
        readonly errors: Record<string, string>;
        readonly counters: HarnessCounters;
      };
    };
  }
}

const container = document.getElementById('harness-root');
if (!container) throw new Error('harness root missing');
createRoot(container).render(<ParameterHost />);

window.__parameterInputHarness = {
  get ready() {
    return mounted && formHandle !== null;
  },
  counters,
  run: runAcceptance,
  snapshot: () => ({ values: currentValues, errors: currentErrors, counters })
};
