/**
 * Development-time parameter input performance contract.
 *
 * The parameter form currently hands every keystroke to its parent, which
 * replaces the whole workplace draft, marks it dirty, queues an autosave and
 * re-renders the parameter area. P3 removes that coupling; this module exists so
 * the cost can be *measured* before and after, with a fixed, redaction-safe
 * shape.
 *
 * Redaction is structural, not editorial: samples and summaries carry only
 * bounded enums, counts and millisecond numbers. There is no free-text field
 * anywhere in the DTO, so a prompt, credential, file path or parameter payload
 * cannot be smuggled into a diagnostic log even by mistake.
 *
 * P3 added the parameter-area render counter, so the same session can show that
 * a keystroke now costs one local render instead of a whole-draft replacement.
 */

export const parameterInputDiagnosticsIpcChannel = 'parameter-input-diagnostics:record';

/** The baseline is only meaningful with at least this many consecutive inputs. */
export const PARAMETER_INPUT_MIN_SAMPLES = 30;

/** Upper bound for a single measured duration, so no clock or unit bug passes. */
export const PARAMETER_INPUT_MAX_LATENCY_MS = 600_000;

export const parameterInputSurfaces = ['image_generation', 'video_generation'] as const;
export type ParameterInputSurface = (typeof parameterInputSurfaces)[number];

/**
 * Control categories, not field keys: a key could be provider- or user-derived,
 * while the category is a fixed vocabulary owned by this file.
 */
export const parameterInputControlKinds = [
  'text',
  'number',
  'integer',
  'array',
  'json',
  'boolean',
  'enum',
  'media_slot'
] as const;
export type ParameterInputControlKind = (typeof parameterInputControlKinds)[number];

/**
 * One measured keystroke. Counts are per keystroke, not cumulative: they are
 * reset when the keystroke is settled, so a commit or candidate read that the
 * idle boundary triggers later cannot be blamed on an earlier key.
 */
export interface ParameterInputSample {
  readonly surface: ParameterInputSurface;
  readonly controlKind: ParameterInputControlKind;
  /** Input event → updated text visible on screen. */
  readonly visibleLatencyMs: number;
  /** Whole-draft replacements the parent performed for this keystroke. */
  readonly parentCommitCount: number;
  /** Candidate list requests caused by this keystroke. */
  readonly candidateRequestCount: number;
  /** Autosave IPC messages caused by this keystroke. */
  readonly autosaveIpcCount: number;
  /** Parameter-area renders caused by this keystroke. */
  readonly parameterAreaRenderCount: number;
}

/** Aggregated result for one editing session of at least 30 inputs. */
export interface ParameterInputPerformanceSummary {
  readonly surface: ParameterInputSurface;
  readonly sampleCount: number;
  readonly visibleLatencyP50Ms: number;
  readonly visibleLatencyP95Ms: number;
  readonly visibleLatencyMaxMs: number;
  readonly parentCommitCount: number;
  readonly candidateRequestCount: number;
  readonly autosaveIpcCount: number;
  readonly parameterAreaRenderCount: number;
}

export interface ParameterInputDiagnosticsApi {
  record(summary: ParameterInputPerformanceSummary): void;
}

const surfaceSet = new Set<string>(parameterInputSurfaces);
const controlKindSet = new Set<string>(parameterInputControlKinds);

/** Nearest-rank percentile, matching the read-model performance gate. */
export function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

export function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Collapses a measured editing session into the recorded baseline shape.
 * Returns `undefined` when the session is too short to be a baseline.
 */
export function summarizeParameterInputSamples(
  samples: readonly ParameterInputSample[]
): ParameterInputPerformanceSummary | undefined {
  if (samples.length < PARAMETER_INPUT_MIN_SAMPLES) return undefined;
  const surface = samples[0]?.surface;
  if (!surface || samples.some((sample) => sample.surface !== surface)) return undefined;
  if (samples.some((sample) => !isValidSample(sample))) return undefined;
  const latencies = samples.map((sample) => sample.visibleLatencyMs);
  return {
    surface,
    sampleCount: samples.length,
    visibleLatencyP50Ms: roundMilliseconds(percentile(latencies, 0.5)),
    visibleLatencyP95Ms: roundMilliseconds(percentile(latencies, 0.95)),
    visibleLatencyMaxMs: roundMilliseconds(Math.max(...latencies)),
    parentCommitCount: sum(samples, (sample) => sample.parentCommitCount),
    candidateRequestCount: sum(samples, (sample) => sample.candidateRequestCount),
    autosaveIpcCount: sum(samples, (sample) => sample.autosaveIpcCount),
    parameterAreaRenderCount: sum(samples, (sample) => sample.parameterAreaRenderCount)
  };
}

/**
 * Redaction gate applied where the summary leaves the renderer. Rejects any
 * payload that adds a field, carries text, or exceeds the bounded number
 * ranges, so a diagnostic log can never become a data-exfiltration channel.
 */
export function isParameterInputPerformanceSummary(
  value: unknown
): value is ParameterInputPerformanceSummary {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    'surface',
    'sampleCount',
    'visibleLatencyP50Ms',
    'visibleLatencyP95Ms',
    'visibleLatencyMaxMs',
    'parentCommitCount',
    'candidateRequestCount',
    'autosaveIpcCount',
    'parameterAreaRenderCount'
  ]);
  if (Object.keys(value).length !== allowedKeys.size) return false;
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (!surfaceSet.has(String(value.surface))) return false;
  if (!isBoundedCount(value.sampleCount, 1_000_000)) return false;
  if (Number(value.sampleCount) < PARAMETER_INPUT_MIN_SAMPLES) return false;
  for (const key of [
    'visibleLatencyP50Ms',
    'visibleLatencyP95Ms',
    'visibleLatencyMaxMs'
  ] as const) {
    if (!isBoundedMilliseconds(value[key])) return false;
  }
  for (const key of [
    'parentCommitCount',
    'candidateRequestCount',
    'autosaveIpcCount',
    'parameterAreaRenderCount'
  ] as const) {
    if (!isBoundedCount(value[key], Number.MAX_SAFE_INTEGER)) return false;
  }
  return true;
}

export function isValidSample(value: unknown): value is ParameterInputSample {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    'surface',
    'controlKind',
    'visibleLatencyMs',
    'parentCommitCount',
    'candidateRequestCount',
    'autosaveIpcCount',
    'parameterAreaRenderCount'
  ]);
  if (Object.keys(value).length !== allowedKeys.size) return false;
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (!surfaceSet.has(String(value.surface))) return false;
  if (!controlKindSet.has(String(value.controlKind))) return false;
  if (!isBoundedMilliseconds(value.visibleLatencyMs)) return false;
  return (
    isBoundedCount(value.parentCommitCount, Number.MAX_SAFE_INTEGER) &&
    isBoundedCount(value.candidateRequestCount, Number.MAX_SAFE_INTEGER) &&
    isBoundedCount(value.autosaveIpcCount, Number.MAX_SAFE_INTEGER) &&
    isBoundedCount(value.parameterAreaRenderCount, Number.MAX_SAFE_INTEGER)
  );
}

function sum(
  samples: readonly ParameterInputSample[],
  select: (sample: ParameterInputSample) => number
): number {
  return samples.reduce((total, sample) => total + select(sample), 0);
}

function isBoundedMilliseconds(value: unknown): boolean {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= PARAMETER_INPUT_MAX_LATENCY_MS;
}

function isBoundedCount(value: unknown, maximum: number): boolean {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
