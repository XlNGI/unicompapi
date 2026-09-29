import {
  createCanonicalToolRegistry,
  validateCanonicalToolArguments,
  type CanonicalToolRegistry,
  type DocumentToolResult
} from '../domain/entities/canonical-tool-contract';
import { addTextPatch } from '../domain/entities/document-ir-patch';
import type { DocumentVersionPin } from '../domain/entities/document-version-pin';
import type { DocumentMutationCoordinator } from './document-mutation-coordinator';
import type { DocumentAtomicExecutionContext, DocumentAtomicToolBinding } from './document-atomic-tools';

export interface AddElementToolDependencies {
  readonly coordinator: DocumentMutationCoordinator;
  readonly resolveVersionPin: (context: DocumentAtomicExecutionContext) => Promise<DocumentVersionPin>;
  readonly revalidateAuthorization: (context: DocumentAtomicExecutionContext, phase: 'before' | 'after') => Promise<boolean>;
}

/** Adds one text element. The opaque element identity is created by the host. */
export function createAddElementBinding(
  dependencies: AddElementToolDependencies,
  options: { readonly registry?: CanonicalToolRegistry } = {}
): DocumentAtomicToolBinding {
  const registry = options.registry ?? createCanonicalToolRegistry();
  const contract = registry.get('add_element');
  if (!contract) throw new TypeError('tool_not_registered');
  return {
    contract,
    authorize: async (_args, context) => authorized(context, 'add_element') && await dependencies.revalidateAuthorization(context, 'before'),
    execute: async (input, context) => {
      if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
      let args;
      try { args = validateCanonicalToolArguments(contract, input); } catch { return failed('invalid_arguments'); }
      const authorize = async (): Promise<boolean> => authorized(context, 'add_element') && await dependencies.revalidateAuthorization(context, 'before');
      if (!await authorize()) return failed(context.abortSignal.aborted ? 'cancelled' : 'authorization_denied', context.abortSignal.aborted ? 'cancelled' : 'failed');
      let expectedPin: DocumentVersionPin;
      try { expectedPin = await dependencies.resolveVersionPin(context); } catch { return failed('identity_stale'); }
      if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
      if (expectedPin.headWorkId !== context.currentDocumentId || expectedPin.runtimeRevision !== context.revision) return failed('revision_conflict');
      const elementId = await opaqueElementId(context);
      let patch;
      try { patch = addTextPatch(String(args.pageId), elementId, String(args.text), String(args.placement ?? 'default') as 'default'); } catch { return failed('invalid_arguments'); }
      const stableCallKey = await mutationId(context);
      const result = await dependencies.coordinator.mutate({
        mutationId: stableCallKey, idempotencyKey: stableCallKey,
        expectedPin, patch, signal: context.abortSignal, authorize
      });
      if (result.status === 'cancelled') return failed('cancelled', 'cancelled');
      if (result.status === 'revision_conflict') return failed('revision_conflict');
      if (result.status === 'committed_pending_refresh' || result.status === 'committed') return {
        schemaVersion: 1, status: 'unknown',
        observation: { elementId, pageId: String(args.pageId), operation: 'added', mutationState: 'committed_pending_refresh' },
        diagnostics: [{ code: 'committed_pending_refresh', severity: 'warning' as const, message: 'committed_pending_refresh' }]
      };
      if (result.status === 'reconciliation_required') return failed('reconciliation_required', 'unknown');
      if (result.status !== 'session_refreshed') return failed(result.record.diagnostic ?? 'commit_failed');
      const stillAuthorized = await dependencies.revalidateAuthorization(context, 'after').catch(() => false);
      return {
        schemaVersion: 1, status: 'success',
        irPatch: patch as unknown as Readonly<Record<string, unknown>>,
        observation: { elementId, pageId: String(args.pageId), operation: 'added' },
        ...(!stillAuthorized ? { diagnostics: [{ code: 'authorization_denied', severity: 'warning' as const, message: 'authorization_denied' }] } : {})
      };
    }
  };
}

function authorized(context: DocumentAtomicExecutionContext, toolId: 'add_element'): boolean {
  return context.authorization.canWrite && context.authorization.allowedToolIds.includes(toolId) &&
    Boolean(context.currentDocumentId && context.currentDocumentIR && Number.isSafeInteger(context.revision)) &&
    !context.abortSignal.aborted && (context.taskContext.deadlineAt === undefined || Date.now() < context.taskContext.deadlineAt);
}

async function mutationId(context: DocumentAtomicExecutionContext): Promise<string> {
  const bytes = new TextEncoder().encode(context.idempotencyKey);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `mutation-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function opaqueElementId(context: DocumentAtomicExecutionContext): Promise<string> {
  const bytes = new TextEncoder().encode(context.idempotencyKey);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `element-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 48)}`;
}

function failed(code: string, status: 'failed' | 'cancelled' | 'unknown' = 'failed'): DocumentToolResult {
  return { schemaVersion: 1, status, diagnostics: [{ code, severity: 'error', message: code }] };
}
