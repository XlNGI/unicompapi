import { createHash } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  createFileReference, createDocumentTask, addExecutionToTask, createExecution, transitionExecution, registerWork,
  toExecutionId, toFileReferenceId, toTaskId, toWorkId, toIsoTimestamp, type ProjectId
} from '../../domain';
import { parseDocumentVersionPin, type DocumentVersionPin } from '../../domain/entities/document-version-pin';
import { JsonExecutionRepository, JsonFileReferenceRepository, JsonTaskRepository, JsonWorkRepository } from '../repositories/json-repositories';
import { JsonFileIndexRepository } from '../repositories/json-file-index-repository';
import { NodeProjectStorage, toProjectRelativePath } from '../storage';
import { NodeFileStatusProbe, FileVerificationPersistenceService, resolveFileReferencePathSafely } from '../files';
import { RegisteredPresentationReader } from './registered-presentation-reader';
import { DocumentIdentityIndexStore } from './document-identity-index-store';
import { DocumentMutationHeadStore } from './document-mutation-head-store';
import { DocumentMutationCoordinator, type DocumentMutationCandidate, type DocumentMutationHead, type DocumentMutationRecord } from '../../application/document-mutation-coordinator';
import type { ConversationDocumentMutationToolSelection } from './conversation-document-tool-session';
import { applyPresentationMutationPatch, carryForwardPresentationIdentityManifestForPatch, verifyPresentationIdentityManifest } from './presentation-identity-manifest';
import type { DocumentRenderAdapter } from './temporary-document-workflow';
import { inspectPptxGeometry } from './office-render-adapter';
import { emitProductionEvent } from '../conversation-production-trace';

export interface ProductionDocumentMutationHost {
  readonly coordinator: DocumentMutationCoordinator;
  readHead(): Promise<DocumentMutationHead>;
  isBlocked(): Promise<boolean>;
  committedVersion(): Promise<DocumentVersionPin | undefined>;
}
export function createProductionDocumentMutationHost(input: {
  readonly rootDirectory: string; readonly projectId: ProjectId;
  readonly selection: ConversationDocumentMutationToolSelection;
  readonly renderPreview: DocumentRenderAdapter;
  readonly refreshSession: (candidate: DocumentMutationCandidate) => Promise<void>;
}): ProductionDocumentMutationHost {
  let commitGuard: (() => Promise<void>) | undefined;
  const headPath = path.resolve(input.rootDirectory, 'entities/document-mutation-head', hash(input.selection.documentLineageId) + '.json');
  const storage = new NodeProjectStorage(input.rootDirectory, { onAtomicWriteStage: async event => {
    if (event.stage === 'before_replace' && path.resolve(event.targetPath) === headPath) await commitGuard?.();
  } });
  const identities = new DocumentIdentityIndexStore(storage);
  const heads = new DocumentMutationHeadStore(storage);
  const works = new JsonWorkRepository(storage, input.projectId);
  const files = new JsonFileReferenceRepository(storage, input.projectId);
  const tasks = new JsonTaskRepository(storage, input.projectId);
  const executions = new JsonExecutionRepository(storage);
  const reader = new RegisteredPresentationReader(input);
  const lineage = input.selection.documentLineageId;
  const ownedCandidates = new Map<string, DocumentVersionPin>();
  let committedPin: DocumentVersionPin | undefined;
  const blockedPath = toProjectRelativePath('entities/document-mutations/blocked-' + hash(lineage) + '.json');
  const journalIndexPath = toProjectRelativePath('entities/document-mutations/index-' + hash(lineage) + '.json');
  const recordPath = (key: string) => toProjectRelativePath('entities/document-mutations/call-' + hash(key) + '.json');
  const terminalStates = ['session_refreshed', 'committed', 'committed_pending_refresh', 'cancelled', 'failed', 'revision_conflict'];
  const parseJournal = (value: unknown): Record<string, string> => {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
        Object.entries(value).some(([key, state]) => !/^[a-f0-9]{64}$/u.test(key) || typeof state !== 'string')) throw new Error('reconciliation_required');
    return value as Record<string, string>;
  };
  const blocked = async (exceptKey?: string): Promise<boolean> => {
    if (await storage.readJson(blockedPath)) return true;
    const journal = parseJournal(await storage.readJson(journalIndexPath));
    return Object.entries(journal).some(([key, state]) => key !== exceptKey && !terminalStates.includes(state));
  };
  const stop = (signal: AbortSignal) => { if (signal.aborted) throw new Error('cancelled'); };
  const verify = async (candidate: DocumentMutationHead, signal: AbortSignal) => {
    stop(signal);
    const { pin, identity } = candidate;
    parseDocumentVersionPin(pin);
    if (pin.documentLineageId !== lineage || identity.documentLineageId !== lineage ||
        pin.headWorkId !== identity.workId || pin.fileId !== identity.fileId ||
        pin.sourceExecutionId !== identity.sourceExecutionId || pin.runtimeRevision !== identity.revision ||
        pin.identityIndexVersion !== identity.identityIndexVersion || pin.checksumSha256 !== identity.artifactChecksumSha256) throw new Error('identity_stale');
    await verifyPresentationIdentityManifest(candidate.buffer, identity);
    stop(signal);
  };
  const readVersion = async (pin: DocumentVersionPin): Promise<DocumentMutationHead> => {
    let actual;
    try { actual = await reader.read(toWorkId(pin.headWorkId)); } catch { throw new Error('revision_conflict'); }
    const identity = await identities.getForWork(pin.headWorkId);
    if (!identity) throw new Error('identity_unresolved');
    if (actual.file.id !== pin.fileId || actual.work.sourceExecutionId !== pin.sourceExecutionId ||
        actual.file.checksumSha256 !== pin.checksumSha256) throw new Error('revision_conflict');
    const value = { pin, identity, buffer: actual.buffer };
    await verify(value, new AbortController().signal);
    return value;
  };
  const readHead = async () => {
    const pin = await heads.get(lineage);
    if (!pin) throw new Error('identity_unresolved');
    return readVersion(pin);
  };
  const persistRecord = async (record: DocumentMutationRecord) => {
    await storage.writeJsonAtomically(recordPath(record.idempotencyKey), record);
    // The index mirrors this Coordinator's durable states. After a crash a new
    // task must not step around an unfinished or unknown write using a new call ID.
    await storage.mutateJsonAtomically<Record<string, string>>(journalIndexPath, previous => ({
      ...parseJournal(previous), [hash(record.idempotencyKey)]: record.state
    }));
    await emitProductionEvent({ code: 'plan_validation', status: ['failed', 'revision_conflict', 'reconciliation_required'].includes(record.state) ? 'failed' : 'completed',
      operationId: 'mutation_' + record.state, facts: { tool: 'patch', purpose: 'tool' } });
  };
  const reconcile = async (record: DocumentMutationRecord) => {
    const head = await heads.get(lineage);
    if (record.candidatePin && head && samePin(head, record.candidatePin)) {
      await readVersion(head);
      committedPin = head;
      await persistRecord({ ...record, state: 'committed_pending_refresh', diagnostic: 'committed_pending_refresh' });
      return;
    }
    await persistRecord(record);
    if (!['revision_conflict', 'cancelled', 'failed'].includes(record.state)) {
      await storage.writeJsonAtomically(blockedPath, { schemaVersion: 1, mutationId: record.mutationId, state: 'reconciliation_required' });
    }
  };
  const coordinator = new DocumentMutationCoordinator({
    readHead,
    runExclusive: (key, operation) => storage.withExclusiveAccess([recordPath(key)], operation),
    loadRecord: async key => {
      const value = await storage.readJson<DocumentMutationRecord>(recordPath(key));
      if (value && (value.schemaVersion !== 1 || value.idempotencyKey !== key || !value.basePin || !value.state)) throw new Error('reconciliation_required');
      if (!value && await blocked(hash(key))) throw new Error('reconciliation_required');
      if (value?.candidatePin) ownedCandidates.set(value.candidatePin.headWorkId, value.candidatePin);
      return value;
    },
    saveRecord: persistRecord,
    materialize: async ({ head, patch, mutationId, idempotencyKey, signal }) => {
      stop(signal);
      if (await blocked(hash(idempotencyKey))) throw new Error('reconciliation_required');
      const key = hash(mutationId);
      const workId = 'work-mutation-' + key;
      const fileId = 'file-mutation-' + key;
      const sourceExecutionId = 'execution-mutation-' + key;
      const buffer = await applyPresentationMutationPatch({ buffer: head.buffer, manifest: head.identity, patch });
      stop(signal);
      const identity = await carryForwardPresentationIdentityManifestForPatch({ previous: head.identity, buffer,
        revision: head.pin.runtimeRevision + 1, patch, fileId, sourceExecutionId });
      return { buffer, identity: { ...identity, workId }, pin: { ...head.pin, headWorkId: workId, fileId, sourceExecutionId,
        runtimeRevision: identity.revision, checksumSha256: hash(buffer) } };
    },
    verifyCandidate: verify,
    qa: async (buffer, signal) => {
      stop(signal);
      await storage.ensureDirectory(toProjectRelativePath('files/documents'));
      const name = '.qa-' + hash(buffer) + '.pptx';
      const reference = createFileReference({ id: toFileReferenceId('qa-only'), projectId: input.projectId,
        locator: { kind: 'project', relativePath: 'files/documents/' + name }, createdAt: toIsoTimestamp(new Date().toISOString()) });
      const temporary = await resolveFileReferencePathSafely(input.rootDirectory, reference);
      const handle = await open(temporary, 'wx');
      try { await handle.writeFile(buffer); await handle.sync(); } finally { await handle.close(); }
      try {
        const geometry = await inspectPptxGeometry(temporary);
        if (geometry.some(item => item.severity === 'error')) throw new Error('qa_failed');
        const rendered = await input.renderPreview(temporary, { kind: 'ppt', signal });
        if (rendered.previewCount < 1 || rendered.diagnostics?.some(item => item.severity === 'error')) throw new Error('qa_failed');
        stop(signal);
      } finally { await rm(temporary, { force: true }); }
    },
    registerCandidate: async candidate => {
      stop(candidate.signal);
      ownedCandidates.set(candidate.pin.headWorkId, candidate.pin);
      await verify(candidate, candidate.signal);
      const record = await storage.readJson<DocumentMutationRecord>(recordPath(candidate.idempotencyKey));
      if (!record?.candidatePin || !samePin(record.candidatePin, candidate.pin)) throw new Error('commit_failed');
      const now = toIsoTimestamp(new Date().toISOString());
      const workId = toWorkId(candidate.pin.headWorkId);
      const executionId = toExecutionId(candidate.pin.sourceExecutionId);
      const taskId = toTaskId('task-' + hash(candidate.idempotencyKey));
      const reference = createFileReference({ id: toFileReferenceId(candidate.pin.fileId), projectId: input.projectId,
        sourceExecutionId: executionId, locator: { kind: 'project', relativePath: 'files/documents/update-' + hash(workId) + '.pptx' }, createdAt: now });
      await storage.ensureDirectory(toProjectRelativePath('files/documents'));
      const finalPath = await resolveFileReferencePathSafely(input.rootDirectory, reference);
      const temporaryPath = finalPath + '.tmp';
      const handle = await open(temporaryPath, 'wx');
      try { await handle.writeFile(candidate.buffer); await handle.sync(); } finally { await handle.close(); }
      stop(candidate.signal);
      await rename(temporaryPath, finalPath);
      const probe = new NodeFileStatusProbe(input.rootDirectory);
      const verification = await probe.inspect(reference, { expectedChecksum: candidate.pin.checksumSha256, signal: candidate.signal });
      if (verification.recommendedState !== 'available' || !verification.verification?.matchesExpected) throw new Error('commit_failed');
      const file = await new FileVerificationPersistenceService(files, new JsonFileIndexRepository(storage, input.projectId),
        probe, () => toIsoTimestamp(new Date().toISOString())).persistProbeResult(reference, verification);
      const task = createDocumentTask({ id: taskId, projectId: input.projectId, sourceDraftId: 'mutation-' + hash(candidate.idempotencyKey),
        kind: 'ppt', title: 'PPT 文本修改', contentFingerprint: record.patchFingerprint,
        draftRevision: candidate.pin.runtimeRevision, confirmedAt: now });
      let execution = createExecution({ id: executionId, taskId, createdAt: now });
      await tasks.save(addExecutionToTask(task, execution));
      await executions.save(execution);
      for (const state of ['queued', 'validating_sources', 'preparing_media', 'encoding', 'writing_file', 'verifying_file', 'registering_work'] as const) {
        execution = transitionExecution(execution, state, now, state === 'registering_work' ? { outputFileId: file.id, workId } : {});
        await executions.save(execution);
      }
      await identities.save(candidate.identity);
      await verify(candidate, candidate.signal);
      const work = registerWork({ id: workId, task: addExecutionToTask(task, execution), execution, file,
        mediaKind: 'document', name: path.basename(finalPath), parentWorkId: toWorkId(record.basePin.headWorkId), createdAt: now });
      await works.save(work);
      await executions.save(transitionExecution(execution, 'completed', toIsoTimestamp(new Date().toISOString()), { outputFileId: file.id, workId }));
      await readVersion(candidate.pin);
      return { ...candidate, workId };
    },
    compareAndSwapHead: async (expected, candidate, context) => {
      const guard = async () => {
        stop(context.signal);
        if (!await context.authorize()) throw new Error('authorization_denied');
        stop(context.signal);
      };
      try {
        const switched = await heads.compareAndSwap(expected, candidate.pin, {
          revalidate: async () => {
            commitGuard = guard;
            await guard();
            await readVersion(expected);
            await readVersion(candidate.pin);
            stop(context.signal);
            return true;
          }
        });
        if (switched) committedPin = candidate.pin;
        return switched;
      } finally { if (commitGuard === guard) commitGuard = undefined; }
    },
    // Detached registered artifacts remain recoverable; never delete a Work's file.
    cleanupCandidate: async candidate => {
      await storage.writeJsonAtomically(toProjectRelativePath('entities/document-mutations/detached-' + hash(candidate.workId) + '.json'),
        { schemaVersion: 1, candidatePin: candidate.pin, reason: 'not_committed' });
    },
    reconcile,
    refreshSession: async candidate => {
      const actual = await readHead();
      if (!samePin(candidate.pin, actual.pin)) throw new Error('revision_conflict');
      await input.refreshSession({ ...actual, workId: actual.pin.headWorkId });
    }
  });
  return { coordinator, readHead, isBlocked: () => blocked(), committedVersion: async () => {
    if (committedPin) return committedPin;
    const head = await heads.get(lineage);
    const owned = head && ownedCandidates.get(head.headWorkId);
    if (!head || !owned || !samePin(head, owned)) return undefined;
    await readVersion(head);
    return head;
  } };
}
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function samePin(first: DocumentVersionPin, second: DocumentVersionPin): boolean {
  return JSON.stringify(parseDocumentVersionPin(first)) === JSON.stringify(parseDocumentVersionPin(second));
}
