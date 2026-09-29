import {
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

/**
 * Host-owned inputs required to turn the business-only generate arguments into
 * a normal document generation execution. No filesystem locator is accepted.
 */
export interface GeneratePptxToolDependencies {
  readonly compiler: DocumentDraftCompilerPort;
  readonly executor: DocumentGenerationExecutorPort;
  /** Supplied by the host from the pinned user request, never by tool arguments. */
  readonly artDirection?: { readonly userRequirement: string; readonly request: PresentationArtDirectionPlanner };
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
  return {
    contract,
    authorize: async (_args, context) => authorized(context) &&
      dependencies.revalidateAuthorization(context, 'before'),
    execute: async (input, context) => {
      const args = validateCanonicalToolArguments(contract, input);
      if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
      try {
        if (!authorized(context) || !await dependencies.revalidateAuthorization(context, 'before')) {
          return failed('authorization_or_revision_invalid');
        }
        const outline = dependencies.compiler.compile({
          content: String(args.content), kind: 'ppt', operation: 'create'
        });
        dependencies.onGeneratedOutline?.(outline);
        if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
        const executionInput = dependencies.createExecutionInput
          ? await dependencies.createExecutionInput({ args, outline, context })
          : await defaultExecutionInput(args, outline, context);
        const documentIR = dependencies.compiler.compileIR?.({ outline, operation: 'create' }) ??
          buildDocumentIRFromOutline({ outline, operation: 'create' });
        if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
        if (!await dependencies.revalidateAuthorization(context, 'before')) return failed('authorization_or_revision_invalid');
        const result = await dependencies.executor.run({
          ...executionInput,
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
      generated: true,
      ...(cancelRequested ? { cancelRequested: true } : {}),
      ...(!authorizedAfter ? { authorizationRevoked: true } : {})
    },
    artifactRefs: [{ kind: 'work', ref: result.workId }]
  };
}

function failed(code: string, status: 'failed' | 'cancelled' = 'failed'): DocumentToolResult {
  return { schemaVersion: 1, status, diagnostics: [{ code, severity: 'error', message: code }] };
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
