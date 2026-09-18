import {
  PARAMETER_INPUT_MIN_SAMPLES,
  summarizeParameterInputSamples,
  type ParameterInputControlKind,
  type ParameterInputPerformanceSummary,
  type ParameterInputSample,
  type ParameterInputSurface
} from '../shared/parameter-input-performance';

export type {
  ParameterInputControlKind,
  ParameterInputPerformanceSummary,
  ParameterInputSample,
  ParameterInputSurface
} from '../shared/parameter-input-performance';

/**
 * Development-time probe for one parameter editing session.
 *
 * It is deliberately passive: it observes, counts and reports, and never
 * decides anything about the draft. It exists so the cost of the current
 * "every keystroke replaces the whole draft" coupling can be measured in the
 * real Electron renderer before P3 removes it, and re-measured after.
 *
 * The probe is disabled outside development builds, so production behaviour,
 * timings and bundle work are unchanged.
 */

export interface ParameterInputProbe {
  /** Marks the input event; always pair with {@link ParameterInputProbe.settle}. */
  begin(controlKind: ParameterInputControlKind): void;
  /** One whole-draft replacement performed by the parent for this keystroke. */
  parentCommit(): void;
  /** One candidate-list request caused by this keystroke. */
  candidateRequest(): void;
  /** One autosave IPC message caused by this keystroke. */
  autosaveIpc(): void;
  /** One render of the parameter area while the keystroke is still pending. */
  parameterAreaRender(): void;
  /** Marks the moment the new value became visible on screen. */
  settle(): void;
  /** Number of settled samples in the current session. */
  sampleCount(): number;
  /** Emits the summary now when the session is long enough. */
  flush(): void;
}

export interface ParameterInputProbeOptions {
  readonly surface: ParameterInputSurface;
  readonly emit: (summary: ParameterInputPerformanceSummary) => void;
  /** Defaults to `import.meta.env.DEV`. Tests must pass an explicit value. */
  readonly enabled?: boolean;
  readonly now?: () => number;
  /** Idle period that ends a session. Defaults to 2000 ms. */
  readonly idleFlushMs?: number;
}

export function createParameterInputProbe(
  options: ParameterInputProbeOptions
): ParameterInputProbe {
  const enabled = options.enabled ?? Boolean(import.meta.env?.DEV);
  const now = options.now ?? (() => performance.now());
  const idleFlushMs = options.idleFlushMs ?? 2_000;
  let samples: ParameterInputSample[] = [];
  let pendingStart: number | undefined;
  let pendingKind: ParameterInputControlKind | undefined;
  let pendingParentCommits = 0;
  let pendingCandidateRequests = 0;
  let pendingAutosaveIpcs = 0;
  let pendingRenders = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  if (!enabled) {
    return {
      begin: () => undefined,
      parentCommit: () => undefined,
      candidateRequest: () => undefined,
      autosaveIpc: () => undefined,
      parameterAreaRender: () => undefined,
      settle: () => undefined,
      sampleCount: () => 0,
      flush: () => undefined
    };
  }

  const clearIdleTimer = () => {
    if (idleTimer === undefined) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const flush = () => {
    clearIdleTimer();
    const summary = summarizeParameterInputSamples(samples);
    samples = [];
    if (!summary) return;
    options.emit(summary);
  };

  const scheduleIdleFlush = () => {
    clearIdleTimer();
    if (samples.length < PARAMETER_INPUT_MIN_SAMPLES) return;
    idleTimer = setTimeout(flush, idleFlushMs);
    // Never hold the Node/Electron event loop open for a diagnostic timer.
    const timer = idleTimer as unknown as { unref?: () => void };
    timer.unref?.();
  };

  return {
    begin(controlKind) {
      pendingStart = now();
      pendingKind = controlKind;
      pendingParentCommits = 0;
      pendingCandidateRequests = 0;
      pendingAutosaveIpcs = 0;
      pendingRenders = 0;
    },
    parentCommit() {
      pendingParentCommits += 1;
    },
    candidateRequest() {
      pendingCandidateRequests += 1;
    },
    autosaveIpc() {
      pendingAutosaveIpcs += 1;
    },
    parameterAreaRender() {
      if (pendingStart === undefined) return;
      pendingRenders += 1;
    },
    settle() {
      if (pendingStart === undefined || pendingKind === undefined) return;
      const startedAt = pendingStart;
      const controlKind = pendingKind;
      pendingStart = undefined;
      pendingKind = undefined;
      samples.push({
        surface: options.surface,
        controlKind,
        visibleLatencyMs: Math.max(0, now() - startedAt),
        parentCommitCount: pendingParentCommits,
        candidateRequestCount: pendingCandidateRequests,
        autosaveIpcCount: pendingAutosaveIpcs,
        parameterAreaRenderCount: pendingRenders
      });
      // Counters belong to exactly one keystroke: work the idle boundary
      // triggers afterwards must not be charged to the key that preceded it.
      pendingParentCommits = 0;
      pendingCandidateRequests = 0;
      pendingAutosaveIpcs = 0;
      pendingRenders = 0;
      scheduleIdleFlush();
    },
    sampleCount() {
      return samples.length;
    },
    flush
  };
}

/**
 * The probe lives with the parameter form, but the work it must observe happens
 * in other layers (candidate reads in the panel, autosave IPC in the save
 * coordinator). The form registers its session probe here so those layers can
 * report without threading a probe reference through every component.
 */
let activeProbe: ParameterInputProbe | undefined;

export function setActiveParameterInputProbe(probe: ParameterInputProbe | undefined): void {
  activeProbe = probe;
}

export function hasActiveParameterInputProbe(): boolean {
  return activeProbe !== undefined;
}

/** One candidate-list read issued while a parameter edit is pending. */
export function reportParameterInputCandidateRequest(): void {
  activeProbe?.candidateRequest();
}

/** One autosave IPC persist issued while a parameter edit is pending. */
export function reportParameterInputAutosaveIpc(): void {
  activeProbe?.autosaveIpc();
}

/**
 * Sends a summary to the main process, where it is written to a local log.
 * Reads `window.unicomp` defensively so the probe stays inert in tests and in
 * any renderer without the preload bridge.
 */
export function emitParameterInputSummary(
  summary: ParameterInputPerformanceSummary
): void {
  if (typeof window === 'undefined') return;
  window.unicomp?.parameterInputDiagnostics?.record(summary);
}
