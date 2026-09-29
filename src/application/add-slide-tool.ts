import {
  createCanonicalToolRegistry,
  validateCanonicalToolArguments,
  type CanonicalToolRegistry,
  type DocumentToolResult
} from '../domain/entities/canonical-tool-contract';
import { addSlidePatch } from '../domain/entities/document-ir-patch';
import type { DocumentVersionPin } from '../domain/entities/document-version-pin';
import type { DocumentMutationCoordinator } from './document-mutation-coordinator';
import type { DocumentAtomicExecutionContext, DocumentAtomicToolBinding } from './document-atomic-tools';

export interface AddSlideToolDependencies {
  readonly coordinator: DocumentMutationCoordinator;
  readonly resolveVersionPin: (context: DocumentAtomicExecutionContext) => Promise<DocumentVersionPin>;
  readonly revalidateAuthorization: (context: DocumentAtomicExecutionContext, phase: 'before' | 'after') => Promise<boolean>;
}

/** Adds one controlled blank page. Page and optional title identities belong to the host. */
export function createAddSlideBinding(
  dependencies: AddSlideToolDependencies,
  options: { readonly registry?: CanonicalToolRegistry } = {}
): DocumentAtomicToolBinding {
  const registry = options.registry ?? createCanonicalToolRegistry();
  const contract = registry.get('add_slide');
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
      const position = String(args.position ?? 'end') as 'before' | 'after' | 'end';
      const referencePageId = args.referencePageId === undefined ? undefined : String(args.referencePageId);
      const title = args.title === undefined ? undefined : String(args.title);
      let expectedPin: DocumentVersionPin;
      try { expectedPin = await dependencies.resolveVersionPin(context); } catch { return failed('identity_stale'); }
      if (context.abortSignal.aborted) return failed('cancelled', 'cancelled');
      if (expectedPin.headWorkId !== context.currentDocumentId || expectedPin.runtimeRevision !== context.revision) return failed('revision_conflict');
      const pageId = await opaqueId('page', context.idempotencyKey);
      const titleElementId = title === undefined ? undefined : await opaqueId('element', 'title\n' + context.idempotencyKey);
      let patch;
      try { patch = addSlidePatch({ pageId, mode: position, referencePageId, title, titleElementId }); } catch { return failed('invalid_arguments'); }
      const stableCallKey = await mutationId(context);
      const result = await dependencies.coordinator.mutate({
        mutationId: stableCallKey, idempotencyKey: stableCallKey,
        expectedPin, patch, signal: context.abortSignal, authorize
      });
      if (result.status === 'cancelled') return failed('cancelled', 'cancelled');
      if (result.status === 'revision_conflict') return failed('revision_conflict');
      if (result.status === 'committed_pending_refresh' || result.status === 'committed') return {
        schemaVersion: 1, status: 'unknown',
        observation: { operation: 'slide_added', pageId, ...(position === 'after' ? { insertedAfterPageId: referencePageId } : position === 'before' ? { insertedBeforePageId: referencePageId } : {}), mutationState: 'committed_pending_refresh' },
        diagnostics: [{ code: 'committed_pending_refresh', severity: 'warning' as const, message: 'committed_pending_refresh' }]
      };
      if (result.status === 'reconciliation_required') return failed('reconciliation_required', 'unknown');
      if (result.status !== 'session_refreshed') return failed(result.record.diagnostic ?? 'commit_failed');
      const stillAuthorized = await dependencies.revalidateAuthorization(context, 'after').catch(() => false);
      const page = result.candidate?.identity.pages.find(item => item.pageId === pageId);
      const pageCount = result.candidate?.identity.pages.length;
      return {
        schemaVersion: 1, status: 'success',
        irPatch: patch as unknown as Readonly<Record<string, unknown>>,
        observation: { operation: 'slide_added', pageId, ...(page?.physicalPageNumber === undefined ? {} : { pageNumber: page.physicalPageNumber }), ...(title === undefined ? {} : { title }), ...(position === 'after' ? { insertedAfterPageId: referencePageId } : position === 'before' ? { insertedBeforePageId: referencePageId } : {}), ...(pageCount === undefined ? {} : { pageCount }) },
        ...(!stillAuthorized ? { diagnostics: [{ code: 'authorization_denied', severity: 'warning' as const, message: 'authorization_denied' }] } : {})
      };
    }
  };
}

function authorized(context: DocumentAtomicExecutionContext): boolean {
  return context.authorization.canWrite && context.authorization.allowedToolIds.includes('add_slide') &&
    Boolean(context.currentDocumentId && context.currentDocumentIR && Number.isSafeInteger(context.revision)) &&
    !context.abortSignal.aborted && (context.taskContext.deadlineAt === undefined || Date.now() < context.taskContext.deadlineAt);
}

async function mutationId(context: DocumentAtomicExecutionContext): Promise<string> {
  return `mutation-${await digest(context.idempotencyKey)}`;
}

async function opaqueId(prefix: 'page' | 'element', value: string): Promise<string> {
  return `${prefix}-${(await digest(value)).slice(0, 48)}`;
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function failed(code: string, status: 'failed' | 'cancelled' | 'unknown' = 'failed'): DocumentToolResult {
  return { schemaVersion: 1, status, diagnostics: [{ code, severity: 'error', message: code }] };
}
