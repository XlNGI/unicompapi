import {
  parseRepairPlan,
  type DocumentOutline,
  type RepairPlan
} from '../../domain';
import {
  applyStructuredDocumentPatch,
  type DocumentPatch
} from './structured-document-tools';
import type { DocumentQualityDiagnostic } from './temporary-document-workflow';

export type { DocumentQualityDiagnostic } from './temporary-document-workflow';

export interface RepairWorkflowOptions {
  readonly outline: DocumentOutline;
  readonly diagnostics: readonly DocumentQualityDiagnostic[];
  readonly diagnose: (outline: DocumentOutline) => readonly DocumentQualityDiagnostic[];
  /** Optional asynchronous diagnosis used by a real render/QA cycle. */
  readonly diagnoseAsync?: (
    outline: DocumentOutline,
    attempt: number
  ) => Promise<readonly DocumentQualityDiagnostic[]>;
  readonly deterministicRepair?: (
    outline: DocumentOutline,
    diagnostics: readonly DocumentQualityDiagnostic[]
  ) => { readonly outline: DocumentOutline; readonly summary?: string };
  readonly nextRepairPlan?: (
    diagnostics: readonly DocumentQualityDiagnostic[],
    attempt: number
  ) => Promise<unknown>;
  readonly expectedRevision?: number | ((attempt: number) => number);
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
}

export interface RepairWorkflowResult {
  readonly status: 'passed' | 'needs_user' | 'failed' | 'cancelled' | 'max_attempts' | 'repeated_diagnosis';
  readonly outline: DocumentOutline;
  readonly diagnostics: readonly DocumentQualityDiagnostic[];
  readonly attempts: number;
  readonly summaries: readonly string[];
}

export async function runBoundedRepairWorkflow(
  options: RepairWorkflowOptions
): Promise<RepairWorkflowResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 6) {
    throw new TypeError('maxAttempts must be between 1 and 6');
  }
  let outline = options.outline;
  let diagnostics = options.diagnostics;
  const summaries: string[] = [];
  const fingerprints = new Set<string>();
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) return finish('cancelled', outline, diagnostics, attempt, summaries);
    if (!hasErrors(diagnostics)) return finish('passed', outline, diagnostics, attempt, summaries);
    const fingerprint = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').map((diagnostic) => `${diagnostic.code}:${diagnostic.scope}`).sort().join('|');
    if (fingerprints.has(fingerprint)) return finish('repeated_diagnosis', outline, diagnostics, attempt, summaries);
    fingerprints.add(fingerprint);
    if (attempt >= maxAttempts) return finish('max_attempts', outline, diagnostics, attempt, summaries);

    if (options.deterministicRepair) {
      const deterministic = options.deterministicRepair(outline, diagnostics);
      if (deterministic.outline !== outline) {
        outline = deterministic.outline;
        if (deterministic.summary) summaries.push(deterministic.summary);
        diagnostics = await diagnose(options, outline, attempt + 1);
        continue;
      }
    }
    if (!options.nextRepairPlan) return finish('needs_user', outline, diagnostics, attempt, summaries);
    let plan: RepairPlan;
    try {
      plan = parseRepairPlan(await options.nextRepairPlan(diagnostics, attempt + 1));
    } catch {
      return finish(
        options.signal?.aborted ? 'cancelled' : 'failed',
        outline,
        diagnostics,
        attempt,
        summaries
      );
    }
    const expectedRevision = typeof options.expectedRevision === 'function'
      ? options.expectedRevision(attempt + 1)
      : options.expectedRevision;
    if (expectedRevision !== undefined && plan.expectedRevision !== expectedRevision) {
      return finish('failed', outline, diagnostics, attempt, summaries);
    }
    try {
      let changed = false;
      for (const operation of plan.operations) {
        const patched = applyStructuredDocumentPatch(outline, operation as DocumentPatch);
        outline = patched.document;
        changed ||= patched.change.changed;
      }
      if (!changed) return finish('failed', outline, diagnostics, attempt, summaries);
    } catch {
      return finish('failed', outline, diagnostics, attempt, summaries);
    }
    summaries.push(plan.reason);
    diagnostics = await diagnose(options, outline, attempt + 1);
  }
  return finish('max_attempts', outline, diagnostics, maxAttempts, summaries);
}

async function diagnose(
  options: RepairWorkflowOptions,
  outline: DocumentOutline,
  attempt: number
): Promise<readonly DocumentQualityDiagnostic[]> {
  return options.diagnoseAsync
    ? options.diagnoseAsync(outline, attempt)
    : options.diagnose(outline);
}

function hasErrors(diagnostics: readonly DocumentQualityDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

function finish(
  status: RepairWorkflowResult['status'],
  outline: DocumentOutline,
  diagnostics: readonly DocumentQualityDiagnostic[],
  attempts: number,
  summaries: readonly string[]
): RepairWorkflowResult {
  return { status, outline, diagnostics, attempts, summaries };
}
