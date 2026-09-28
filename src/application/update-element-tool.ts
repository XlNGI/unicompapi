import {
  createCanonicalToolRegistry,
  validateCanonicalToolArguments
} from '../domain/entities/canonical-tool-contract';
import type { CanonicalToolRegistry, DocumentToolResult } from '../domain/entities/canonical-tool-contract';
import { updateTextPatch } from '../domain/entities/document-ir-patch';
import type { DocumentMutationCoordinator } from './document-mutation-coordinator';
import type { DocumentAtomicExecutionContext, DocumentAtomicToolBinding } from './document-atomic-tools';

export interface UpdateElementToolDependencies {
  readonly coordinator: DocumentMutationCoordinator;
  readonly revalidateAuthorization?: (context: DocumentAtomicExecutionContext, phase: 'before' | 'after') => Promise<boolean>;
}

/** Business-level text update. The coordinator owns identity, version and artifact state. */
export function createUpdateElementBinding(
  dependencies: UpdateElementToolDependencies,
  options: { readonly registry?: CanonicalToolRegistry } = {}
): DocumentAtomicToolBinding {
  const registry = options.registry ?? createCanonicalToolRegistry();
  const contract = registry.get('update_element');
  if (!contract) throw new TypeError('tool_not_registered');
  return {
    contract,
    authorize: async (_args, context) => authorized(context) &&
      (dependencies.revalidateAuthorization ? await dependencies.revalidateAuthorization(context, 'before') : true),
    execute: async (input, context) => {
      const args = validateCanonicalToolArguments(contract, input);
      if (!authorized(context) || context.abortSignal.aborted ||
          (dependencies.revalidateAuthorization && !await dependencies.revalidateAuthorization(context, 'before'))) {
        return failed('authorization_or_revision_invalid');
      }
      const result = await dependencies.coordinator.updateText({
        mutationId: context.taskContext.taskId,
        idempotencyKey: context.idempotencyKey,
        patch: updateTextPatch(String(args.elementId), String(args.text)),
        signal: context.abortSignal
      });
      if (result.status === 'cancelled') return failed('cancelled', 'cancelled');
      if (result.status === 'revision_conflict') return failed('revision_conflict');
      if (result.status === 'committed_pending_refresh') return {
        schemaVersion: 1, status: 'unknown',
        diagnostics: [{ code: 'committed_pending_refresh', severity: 'error', message: 'committed_pending_refresh' }]
      };
      if (result.status !== 'session_refreshed') return failed(result.record.diagnostic ?? 'tool_failed');
      return {
        schemaVersion: 1, status: 'success',
        irPatch: updateTextPatch(String(args.elementId), String(args.text)) as unknown as Readonly<Record<string, unknown>>,
        observation: { changedElementId: String(args.elementId), mutationState: result.status },
        ...(result.candidate ? { artifactRefs: [{ kind: 'work' as const, ref: result.candidate.workId }] } : {})
      };
    }
  };
}

function authorized(context: DocumentAtomicExecutionContext): boolean {
  return context.authorization.canWrite && context.authorization.allowedToolIds.includes('update_element') &&
    Boolean(context.currentDocumentId && context.currentDocumentIR && Number.isSafeInteger(context.revision)) &&
    !context.abortSignal.aborted;
}
function failed(code: string, status: 'failed' | 'cancelled' = 'failed'): DocumentToolResult {
  return { schemaVersion: 1, status, diagnostics: [{ code, severity: 'error', message: code }] };
}
