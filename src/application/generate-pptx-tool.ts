import {
  DocumentDraftCompilationError,
  DocumentGenerationApplicationError,
  type DocumentDraftCompilerPort,
  type DocumentGenerationExecutionInput,
  type DocumentGenerationExecutionResult,
  type DocumentGenerationExecutorPort
} from './document-generation-service';
import {
  createCanonicalToolRegistry,
  validateCanonicalToolArguments,
  type CanonicalToolArguments,
  type CanonicalToolRegistry,
  type DocumentToolResult
} from '../domain/entities/canonical-tool-contract';
import type { DocumentAtomicExecutionContext, DocumentAtomicToolBinding } from './document-atomic-tools';
import { buildDocumentIRFromOutline } from '../domain/entities/document-agent';
import type { PresentationArtDirectionPlanner } from './presentation-art-direction';
import type { HostExecutionBudget } from './execution-budget';
import { presentationPlanningTotalPages, validatePresentationPageRequirement,
  type PresentationPageRequirement } from '../domain/entities/presentation-page-requirement';
import { presentationDocumentPageLimits } from '../domain/entities/document-generation';

/**
 * Host-owned inputs required to turn the business-only generate arguments into
 * a normal document generation execution. No filesystem locator is accepted.
 */
export interface GeneratePptxToolDependencies {
  readonly compiler: DocumentDraftCompilerPort;
  readonly executor: DocumentGenerationExecutorPort;
  readonly executionBudget?: HostExecutionBudget;
  /** Supplied by the host from the pinned user request, never by tool arguments. */
  readonly artDirection?: { readonly userRequirement: string; readonly request: PresentationArtDirectionPlanner };
  /** Requirement parsed from the pinned user brief by the host, never chosen by the model. */
  readonly pageRequirement?: PresentationPageRequirement;
  /** Read live ownership/permission state; snapshot arguments cannot authorize execution. */
  readonly revalidateAuthorization: (context: DocumentAtomicExecutionContext, phase: 'before' | 'after') => Promise<boolean>;
  readonly onGeneratedOutline?: (outline: NonNullable<ReturnType<DocumentDraftCompilerPort['compile']>>) => void;
  readonly createExecutionInput?: (input: {
    readonly args: CanonicalToolArguments;
    readonly outline: NonNullable<ReturnType<DocumentDraftCompilerPort['compile']>>;
    readonly context: DocumentAtomicExecutionContext;
  }) => DocumentGenerationExecutionInput | Promise<DocumentGenerationExecutionInput>;
}

/** Canonical binding for the provider-visible generate_pptx capability. */
export function createGeneratePptxBinding(
  dependencies: GeneratePptxToolDependencies,
  options: { readonly registry?: CanonicalToolRegistry } = {}
): DocumentAtomicToolBinding {
  const registry = options.registry ?? createCanonicalToolRegistry();
  const contract = registry.get('generate_pptx');
  if (!contract) throw new TypeError('tool_not_registered');
  type PreparedContent = { readonly outline: NonNullable<ReturnType<DocumentDraftCompilerPort['compile']>>;
    readonly documentIR: ReturnType<typeof buildDocumentIRFromOutline> };
  const preparedContent = new Map<string, PreparedContent>();
  let planningFeedbackGiven = false;
  const contentKey = (args: CanonicalToolArguments, context: DocumentAtomicExecutionContext) =>
    JSON.stringify([context.projectContext.projectId, context.taskContext.taskId, context.revision, args]);
  const requirementFor = (args: CanonicalToolArguments): PresentationPageRequirement | undefined => {
    const requirement = dependencies.pageRequirement ?? (args.requestedTotalPages === undefined ? undefined
      : { mode: 'target' as const, targetPages: Number(args.requestedTotalPages), countBasis: 'total' as const });
    if (requirement) validatePresentationPageRequirement(requirement);
    return requirement;
  };
  const compileContent = (args: CanonicalToolArguments, context: DocumentAtomicExecutionContext): PreparedContent => {
    const key = contentKey(args, context), cached = preparedContent.get(key);
    if (cached) return cached;
    const outline = dependencies.compiler.compile({ content: String(args.content), kind: 'ppt', operation: 'create' });
    if (outline.kind !== 'ppt' || !outline.sections.length || outline.sections.some(section =>
      section.pageKind === 'cover' || section.pageKind === 'closing')) throw new DocumentDraftCompilationError('invalid_structure', 'Invalid presentation body plan');
    const documentIR = dependencies.compiler.compileIR?.({ outline, operation: 'create',
      identitySeed: JSON.stringify([context.projectContext.projectId, context.taskContext.taskId, context.revision, outline]) }) ??
      buildDocumentIRFromOutline({ outline, operation: 'create' });
    const prepared = { outline, documentIR };
    // The session has a bounded proposal count; keep a similarly bounded local cache.
    if (preparedContent.size >= 8) preparedContent.delete(preparedContent.keys().next().value!);
    preparedContent.set(key, prepared);
    return prepared;
  };
  return {
    contract,
    authorize: async (_args, context) => authorized(context) &&
      dependencies.revalidateAuthorization(context, 'before'),
    preflight: async (input, context) => {
      if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
      if (!authorized(context) || !await dependencies.revalidateAuthorization(context, 'before')) return failed('authorization_or_revision_invalid');
      try {
        const args = validateCanonicalToolArguments(contract, input);
        const requirement = requirementFor(args);
        const { outline } = compileContent(args, context);
        if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
        if (!await dependencies.revalidateAuthorization(context, 'before')) return failed('authorization_or_revision_invalid');
        const plannedTotalPages = outline.sections.length + presentationDocumentPageLimits.systemGeneratedPages;
        // A planning target may invite one inexpensive revision; it cannot block delivery forever.
        // Physical pagination and all explicit hard constraints remain the executor's responsibility.
        if (requirement?.mode === 'target' && !planningFeedbackGiven &&
          plannedTotalPages !== presentationPlanningTotalPages(requirement)) {
          planningFeedbackGiven = true;
          return { schemaVersion: 1, status: 'failed', observation: {
            planningTargetTotalPages: presentationPlanningTotalPages(requirement), plannedBodySections: outline.sections.length,
            plannedTotalPages, systemGeneratedPages: presentationDocumentPageLimits.systemGeneratedPages,
            planningFeedbackRemaining: 0, planningTargetIsBlocking: false
          }, diagnostics: [{ code: 'page_plan_incomplete', severity: 'warning',
            message: 'page_plan_incomplete' }] };
        }
        return undefined;
      } catch (error) {
        if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
        if (error instanceof TypeError && /(?:invalid|unsupported)_page_requirement/u.test(error.message)) return failed('page_count_mismatch');
        return failed(error instanceof DocumentDraftCompilationError ? compilationFailureCode(error) : 'invalid_outline');
      }
    },
    execute: async (input, context) => {
      const args = validateCanonicalToolArguments(contract, input);
      if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
      try {
        if (!authorized(context) || !await dependencies.revalidateAuthorization(context, 'before')) {
          return failed('authorization_or_revision_invalid');
        }
        const { outline, documentIR } = compileContent(args, context);
        dependencies.onGeneratedOutline?.(outline);
        if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
        const executionInput = dependencies.createExecutionInput
          ? await dependencies.createExecutionInput({ args, outline, context })
          : await defaultExecutionInput(args, outline, context);
        const pageRequirement = requirementFor(args);
        if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
        if (!await dependencies.revalidateAuthorization(context, 'before')) return failed('authorization_or_revision_invalid');
        const result = await dependencies.executor.run({
          ...executionInput,
          ...(dependencies.executionBudget ? { executionBudget: dependencies.executionBudget } : {}),
          ...(pageRequirement ? { pageRequirement, requestedTotalPages: presentationPlanningTotalPages(pageRequirement) } : {}),
          documentIR,
          ...(dependencies.artDirection ? { userRequirement: dependencies.artDirection.userRequirement,
            requestArtDirection: dependencies.artDirection.request } : {}),
          // Runtime cancellation must reach the existing runner and its writer.
          signal: context.abortSignal
        });
        // A resolved executor result is a registered artifact, even if Stop
        // arrives at that exact boundary. Never turn that fact into "not generated".
        const stillAuthorized = await dependencies.revalidateAuthorization(context, 'after').catch(() => false);
        return success(result, context.abortSignal.aborted, stillAuthorized);
      } catch (error) {
        if (error instanceof TypeError && /(?:invalid|unsupported)_page_requirement/u.test(error.message)) {
          return failed('page_count_mismatch');
        }
        if (error instanceof DocumentDraftCompilationError) return failed(compilationFailureCode(error));
        if (context.abortSignal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return failed('cancelled', 'cancelled');
        }
        if (error instanceof DocumentGenerationApplicationError && error.code === 'result_sync_pending') {
          return { schemaVersion: 1, status: 'unknown', diagnostics: [
            { code: 'reconciliation_required', severity: 'error', message: 'reconciliation_required' }
          ] };
        }
        const code = error instanceof DocumentGenerationApplicationError &&
          ['page_count_mismatch', 'verification_failed'].includes(error.code) ? error.code : 'generation_failed';
        return failed(code);
      }
    }
  };
}

async function defaultExecutionInput(
  args: CanonicalToolArguments,
  outline: NonNullable<ReturnType<DocumentDraftCompilerPort['compile']>>,
  context: DocumentAtomicExecutionContext
): Promise<DocumentGenerationExecutionInput> {
  return {
    executionId: context.taskContext.taskId,
    kind: 'ppt',
    title: String(args.title),
    contentFingerprint: await sha256(JSON.stringify([context.taskContext.taskId, context.revision ?? 0,
      Object.entries(args).sort(([a], [b]) => a.localeCompare(b))])),
    draftRevision: context.revision ?? 0,
    sourceDraftId: context.taskContext.taskId,
    outline,
    requestedTotalPages: args.requestedTotalPages === undefined ? undefined : Number(args.requestedTotalPages),
    theme: args.theme as DocumentGenerationExecutionInput['theme'],
    presentationTemplate: args.presentationTemplate as DocumentGenerationExecutionInput['presentationTemplate'],
    signal: context.abortSignal,
    onCancellationClosed: () => undefined,
    images: []
  };
}

function success(result: DocumentGenerationExecutionResult, cancelRequested: boolean, authorizedAfter: boolean): DocumentToolResult {
  return {
    schemaVersion: 1,
    status: 'success',
    observation: {
      ...(authorizedAfter ? { fileName: result.fileName, sizeBytes: result.sizeBytes } : {}),
      ...(authorizedAfter && result.pageCountAssessment ? {
        pageCount: result.pageCountAssessment.actualTotalPages,
        pageCountAssessment: result.pageCountAssessment,
        ...(result.pageCountAssessment.mode === 'target' ? { planningTargetTotalPages:
          result.pageCountAssessment.targetPages + (result.pageCountAssessment.countBasis === 'content'
            ? presentationDocumentPageLimits.systemGeneratedPages : 0) } : {})
      } : {}),
      generated: true,
      ...(cancelRequested ? { cancelRequested: true } : {}),
      ...(!authorizedAfter ? { authorizationRevoked: true } : {})
    },
    ...(result.pageCountAssessment && !result.pageCountAssessment.satisfied && !result.pageCountAssessment.blocking
      ? { diagnostics: [{ code: 'page_count_deviation', severity: 'warning' as const, message: 'page_count_deviation' }] } : {}),
    artifactRefs: [{ kind: 'work', ref: result.workId }]
  };
}

function failed(code: string, status: 'failed' | 'cancelled' = 'failed'): DocumentToolResult {
  return { schemaVersion: 1, status, diagnostics: [{ code, severity: 'error', message: code }] };
}

function compilationFailureCode(error: DocumentDraftCompilationError): string {
  return error.code === 'invalid_structure' ? 'invalid_outline' : error.code;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function authorized(context: DocumentAtomicExecutionContext): boolean {
  const authorization = context.authorization as typeof context.authorization & {
    readonly generationAuthorization?: 'not_requested' | 'awaiting_user' | 'approved' | 'revoked';
  };
  return context.authorization.canWrite && context.authorization.allowedToolIds.includes('generate_pptx') &&
    authorization.generationAuthorization === 'approved' && !context.abortSignal.aborted;
}
