import {
  createCanonicalToolRegistry,
  validateCanonicalToolArguments
} from '../domain/entities/canonical-tool-contract';
import type { CanonicalToolRegistry, DocumentToolResult } from '../domain/entities/canonical-tool-contract';
import { updateTextPatch } from '../domain/entities/document-ir-patch';
import type { DocumentVersionPin } from '../domain/entities/document-version-pin';
import type { DocumentMutationCoordinator } from './document-mutation-coordinator';
import type { DocumentAtomicExecutionContext, DocumentAtomicToolBinding } from './document-atomic-tools';

export interface UpdateElementToolDependencies {
  readonly coordinator: DocumentMutationCoordinator;
  /** Resolves the pin captured in the Runtime context, never silently rebases a stale invocation. */
  readonly resolveVersionPin: (context: DocumentAtomicExecutionContext) => Promise<DocumentVersionPin>;
  readonly revalidateAuthorization: (context: DocumentAtomicExecutionContext, phase: 'before' | 'after') => Promise<boolean>;
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
    authorize: async (_args, context) => authorized(context) && await dependencies.revalidateAuthorization(context, 'before'),
    execute: async (input, context) => {
      if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
      let args;
      try { args = validateCanonicalToolArguments(contract, input); } catch { return failed('invalid_arguments'); }
      const authorize = async (): Promise<boolean> => authorized(context) && await dependencies.revalidateAuthorization(context, 'before');
      if (!await authorize()) return failed(context.abortSignal.aborted ? 'cancelled' : 'authorization_denied', context.abortSignal.aborted ? 'cancelled' : 'failed');
      let expectedPin: DocumentVersionPin;
      try { expectedPin = await dependencies.resolveVersionPin(context); } catch { return failed('identity_stale'); }
      if (expectedPin.headWorkId !== context.currentDocumentId || expectedPin.runtimeRevision !== context.revision) return failed('revision_conflict');
      let patch;
      try { patch = updateTextPatch(String(args.elementId), String(args.text)); } catch { return failed('invalid_arguments'); }
      const stableCallKey = await mutationId(context);
      const result = await dependencies.coordinator.updateText({
        // Runtime's general key includes the current revision/arguments. The durable write
        // ledger must also recognize this task/call after a revision change or argument conflict.
        mutationId: stableCallKey, idempotencyKey: stableCallKey,
        expectedPin, patch, signal: context.abortSignal, authorize
      });
      if (result.status === 'cancelled') return failed('cancelled', 'cancelled');
      if (result.status === 'revision_conflict') return failed('revision_conflict');
      if (result.status === 'committed_pending_refresh' || result.status === 'committed') return {
        schemaVersion: 1, status: 'unknown',
        observation: { elementId: String(args.elementId), changed: true, field: 'text', mutationState: 'committed_pending_refresh' },
        diagnostics: [{ code: 'committed_pending_refresh', severity: 'warning', message: 'committed_pending_refresh' }]
      };
      if (result.status === 'reconciliation_required') return failed('reconciliation_required', 'unknown');
      if (result.status !== 'session_refreshed') return failed(result.record.diagnostic ?? 'commit_failed');
      const stillAuthorized = await dependencies.revalidateAuthorization(context, 'after').catch(() => false);
      return {
        schemaVersion: 1, status: 'success',
        irPatch: patch as unknown as Readonly<Record<string, unknown>>,
        observation: { elementId: String(args.elementId), changed: true, field: 'text' },
        ...(!stillAuthorized ? { diagnostics: [{ code: 'authorization_denied', severity: 'warning' as const, message: 'authorization_denied' }] } : {})
      };
    }
  };
}

function authorized(context: DocumentAtomicExecutionContext): boolean {
  return context.authorization.canWrite && context.authorization.allowedToolIds.includes('update_element') &&
    Boolean(context.currentDocumentId && context.currentDocumentIR && Number.isSafeInteger(context.revision)) &&
    !context.abortSignal.aborted && (context.taskContext.deadlineAt === undefined || Date.now() < context.taskContext.deadlineAt);
}

async function mutationId(context: DocumentAtomicExecutionContext): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([context.projectContext.projectId, context.taskContext.taskId, context.callId]));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `mutation-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function failed(code: string, status: 'failed' | 'cancelled' | 'unknown' = 'failed'): DocumentToolResult {
  return { schemaVersion: 1, status, diagnostics: [{ code, severity: 'error', message: code }] };
}
