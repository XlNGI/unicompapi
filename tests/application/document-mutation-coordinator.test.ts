import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDocumentOutline } from '../../src/platform/documents/document-outline-parser';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';
import { applyPresentationTextPatch, buildPresentationIdentityManifest, carryForwardPresentationIdentityManifest, readIdentityElementText } from '../../src/platform/documents/presentation-identity-manifest';
import { DocumentMutationCoordinator, type DocumentMutationHead, type DocumentMutationPorts, type DocumentMutationRecord, type DocumentMutationResult } from '../../src/application/document-mutation-coordinator';
import { parseDocumentIRPatch, patchFingerprint, updateTextPatch } from '../../src/domain/entities/document-ir-patch';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-mutation-coordinator-'));
  roots.push(root);
  const outline = parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: '事务测试', sections: [{ heading: '目标页', level: 1,
    blocks: [{ type: 'paragraph', text: '原始文本' }, { type: 'paragraph', text: '原始文本' }] }] }));
  const generated = await generateTemporaryDocumentFile({ kind: 'ppt', outline, outputDirectory: root, now: '2026-09-28T12:00:00.000Z' });
  const buffer = await readFile(generated.temporaryPath);
  const identity = await buildPresentationIdentityManifest({ buffer, documentLineageId: 'lineage-coordinator', workId: 'work-head-1', fileId: 'file-head-1', sourceExecutionId: 'execution-head-1', revision: 1 });
  const element = identity.elements.find(item => item.text === '原始文本')!;
  const head: DocumentMutationHead = { buffer, identity, pin: { documentLineageId: identity.documentLineageId, headWorkId: identity.workId,
    fileId: identity.fileId, sourceExecutionId: identity.sourceExecutionId, checksumSha256: identity.artifactChecksumSha256, runtimeRevision: 1, identityIndexVersion: 1 } };
  return { head, element };
}

function ports(initial: DocumentMutationHead) {
  let head = initial;
  const ledger = new Map<string, DocumentMutationRecord>();
  let locked: Promise<unknown> = Promise.resolve();
  const api = {
    readHead: vi.fn(async () => head),
    loadRecord: vi.fn(async (key: string) => ledger.get(key)),
    saveRecord: vi.fn(async (record: DocumentMutationRecord) => { ledger.set(record.idempotencyKey, structuredClone(record)); }),
    runExclusive: vi.fn((_key: string, operation: () => Promise<DocumentMutationResult>) => {
      const operationPromise = locked.then(operation);
      locked = operationPromise.catch(() => undefined);
      return operationPromise;
    }),
    materialize: vi.fn<DocumentMutationPorts['materialize']>(async ({ head: base, patch, mutationId }) => {
      const buffer = await applyPresentationTextPatch({ buffer: base.buffer, manifest: base.identity, patch });
      const carried = await carryForwardPresentationIdentityManifest({ previous: base.identity, buffer, revision: base.pin.runtimeRevision + 1,
        targetElementId: patch.operations[0].target.elementId, targetText: patch.operations[0].text,
        fileId: `file-${mutationId}`, sourceExecutionId: `execution-${mutationId}` });
      const identity = { ...carried, workId: `work-${mutationId}` };
      return { buffer, identity, pin: { ...base.pin, headWorkId: identity.workId, fileId: identity.fileId,
        sourceExecutionId: identity.sourceExecutionId, checksumSha256: identity.artifactChecksumSha256, runtimeRevision: identity.revision } };
    }),
    verifyCandidate: vi.fn<DocumentMutationPorts['verifyCandidate']>(async value => {
      if (createHash('sha256').update(value.buffer).digest('hex') !== value.pin.checksumSha256 ||
          value.identity.artifactChecksumSha256 !== value.pin.checksumSha256 || value.identity.workId !== value.pin.headWorkId) throw new Error('identity_stale');
      for (const element of value.identity.elements) await readIdentityElementText(value.buffer, value.identity, element.elementId);
    }),
    registerCandidate: vi.fn<DocumentMutationPorts['registerCandidate']>(async candidate => ({ ...candidate, workId: candidate.pin.headWorkId })),
    compareAndSwapHead: vi.fn<DocumentMutationPorts['compareAndSwapHead']>(async (expected, candidate, context) => {
      if (context.signal.aborted || !await context.authorize()) throw new Error('authorization_denied');
      if (JSON.stringify(expected) !== JSON.stringify(head.pin)) return false;
      head = candidate;
      return true;
    }),
    cleanupCandidate: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
    refreshSession: vi.fn<DocumentMutationPorts['refreshSession']>(async candidate => {
      for (const element of candidate.identity.elements) await readIdentityElementText(candidate.buffer, candidate.identity, element.elementId);
    }),
    qa: vi.fn(async () => undefined)
  };
  return { api, ledger, getHead: () => head };
}

function request(head: DocumentMutationHead, elementId: string, overrides: Partial<Parameters<DocumentMutationCoordinator['updateText']>[0]> = {}) {
  return { mutationId: 'mutation-1', idempotencyKey: 'call-1', expectedPin: head.pin,
    patch: updateTextPatch(elementId, '修改后的文本'), signal: new AbortController().signal, authorize: async () => true, ...overrides };
}

describe('document mutation coordinator', () => {
  it('preserves element IDs across two real PPTX mutations and leaves duplicate text unchanged', async () => {
    const { head, element } = await fixture();
    const { api, getHead } = ports(head);
    const first = await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId));
    expect(first.status).toBe('session_refreshed');
    const next = getHead();
    expect(await readIdentityElementText(next.buffer, next.identity, element.elementId)).toBe('修改后的文本');
    const second = await new DocumentMutationCoordinator(api).updateText(request(next, element.elementId, {
      mutationId: 'mutation-2', idempotencyKey: 'call-2', patch: updateTextPatch(element.elementId, '再次修改')
    }));
    expect(second.status).toBe('session_refreshed');
    expect(await readIdentityElementText(getHead().buffer, getHead().identity, element.elementId)).toBe('再次修改');
    expect(getHead().identity.elements.map(value => value.elementId)).toEqual(head.identity.elements.map(value => value.elementId));
    const duplicates = head.identity.elements.filter(value => value.text === '原始文本' && value.elementId !== element.elementId);
    expect(duplicates.length).toBeGreaterThan(0);
    for (const duplicate of duplicates) expect(await readIdentityElementText(getHead().buffer, getHead().identity, duplicate.elementId)).toBe('原始文本');
  });

  it('durably replays the same call after coordinator restart without a second mutation', async () => {
    const { head, element } = await fixture();
    const { api } = ports(head);
    const input = request(head, element.elementId);
    expect((await new DocumentMutationCoordinator(api).updateText(input)).status).toBe('session_refreshed');
    expect((await new DocumentMutationCoordinator(api).updateText(input)).status).toBe('session_refreshed');
    expect(api.materialize).toHaveBeenCalledTimes(1);
    expect(api.compareAndSwapHead).toHaveBeenCalledTimes(1);
    const conflict = await new DocumentMutationCoordinator(api).updateText({ ...input, patch: updateTextPatch(element.elementId, '不同参数') });
    expect(conflict.record.diagnostic).toBe('idempotency_conflict');
    expect(api.materialize).toHaveBeenCalledTimes(1);
  });

  it('serializes duplicate calls across two coordinators sharing the durable host lock', async () => {
    const { head, element } = await fixture();
    const { api } = ports(head);
    const results = await Promise.all([new DocumentMutationCoordinator(api).updateText(request(head, element.elementId)),
      new DocumentMutationCoordinator(api).updateText(request(head, element.elementId))]);
    expect(results.map(value => value.status)).toEqual(['session_refreshed', 'session_refreshed']);
    expect(api.materialize).toHaveBeenCalledTimes(1);
  });

  it('rejects an already stale Runtime pin before materialization', async () => {
    const { head, element } = await fixture();
    const { api } = ports(head);
    const result = await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId, { expectedPin: { ...head.pin, runtimeRevision: 0 } }));
    expect(result.status).toBe('revision_conflict');
    expect(api.materialize).not.toHaveBeenCalled();
  });

  it('rechecks authoritative pin before CAS and never changes the old head', async () => {
    const { head, element } = await fixture();
    const { api, getHead } = ports(head);
    api.readHead.mockResolvedValueOnce(head).mockResolvedValue({ ...head, pin: { ...head.pin, runtimeRevision: 2 } });
    const result = await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId));
    expect(result.status).toBe('revision_conflict');
    expect(api.compareAndSwapHead).not.toHaveBeenCalled();
    expect(api.reconcile).toHaveBeenCalledTimes(1);
    expect(getHead()).toBe(head);
  });

  it('retains the old head and reconciles a registered candidate when CAS loses', async () => {
    const { head, element } = await fixture();
    const { api, getHead } = ports(head);
    api.compareAndSwapHead.mockResolvedValue(false);
    expect((await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId))).status).toBe('revision_conflict');
    expect(api.reconcile).toHaveBeenCalledTimes(1);
    expect(api.refreshSession).not.toHaveBeenCalled();
    expect(getHead()).toBe(head);
  });

  it.each(['materialize', 'qa'] as const)('rolls back %s failure without exposing internal error data', async phase => {
    const { head, element } = await fixture();
    const { api, getHead } = ports(head);
    api[phase].mockRejectedValue(new Error('secret C:/private/location.pptx'));
    const result = await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId));
    expect(result.status).toBe('failed');
    expect(result.record.diagnostic).toBe(phase === 'qa' ? 'qa_failed' : 'materialization_failed');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(api.registerCandidate).not.toHaveBeenCalled();
    expect(getHead()).toBe(head);
  });

  it('verifies the manifest before registration and rejects invalid candidate pin', async () => {
    const { head, element } = await fixture();
    const { api } = ports(head);
    api.verifyCandidate.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('identity_stale'));
    const result = await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId));
    expect(result.record.diagnostic).toBe('identity_stale');
    expect(api.registerCandidate).not.toHaveBeenCalled();
  });

  it('does not retry materialization after a lost registration acknowledgment or restart', async () => {
    const { head, element } = await fixture();
    const { api, ledger } = ports(head);
    api.registerCandidate.mockRejectedValue(new Error('storage acknowledgment lost'));
    const input = request(head, element.elementId);
    expect((await new DocumentMutationCoordinator(api).updateText(input)).status).toBe('reconciliation_required');
    expect(ledger.get(input.idempotencyKey)).toMatchObject({ registrationAttempted: true, candidatePin: expect.anything() });
    expect((await new DocumentMutationCoordinator(api).updateText(input)).status).toBe('reconciliation_required');
    expect(api.materialize).toHaveBeenCalledTimes(1);
    expect(api.compareAndSwapHead).not.toHaveBeenCalled();
  });

  it('blocks regeneration of a durable interrupted candidate', async () => {
    const { head, element } = await fixture();
    const { api, ledger } = ports(head);
    const input = request(head, element.elementId);
    ledger.set(input.idempotencyKey, { schemaVersion: 1, mutationId: input.mutationId, idempotencyKey: input.idempotencyKey,
      state: 'materialized', basePin: head.pin, patchFingerprint: await patchFingerprint(parseDocumentIRPatch(input.patch)) });
    expect((await new DocumentMutationCoordinator(api).updateText(input)).status).toBe('reconciliation_required');
    expect(api.materialize).not.toHaveBeenCalled();
  });

  it('denies revoked authorization before starting the adapter', async () => {
    const { head, element } = await fixture();
    const { api } = ports(head);
    const result = await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId, { authorize: async () => false }));
    expect(result.record.diagnostic).toBe('authorization_denied');
    expect(api.materialize).not.toHaveBeenCalled();
  });

  it('rechecks authorization after candidate registration before head commit', async () => {
    const { head, element } = await fixture();
    const { api, getHead } = ports(head);
    const authorize = vi.fn(async () => true);
    api.registerCandidate.mockImplementation(async candidate => { authorize.mockResolvedValue(false); return { ...candidate, workId: candidate.pin.headWorkId }; });
    expect((await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId, { authorize }))).record.diagnostic).toBe('authorization_denied');
    expect(api.compareAndSwapHead).not.toHaveBeenCalled();
    expect(api.cleanupCandidate).toHaveBeenCalledTimes(1);
    expect(getHead()).toBe(head);
  });

  it('cancels before materialization and during QA without candidate registration', async () => {
    const { head, element } = await fixture();
    const first = ports(head);
    const early = new AbortController(); early.abort();
    expect((await new DocumentMutationCoordinator(first.api).updateText(request(head, element.elementId, { signal: early.signal }))).status).toBe('cancelled');
    expect(first.api.materialize).not.toHaveBeenCalled();
    const second = ports(head);
    const running = new AbortController();
    second.api.qa.mockImplementation(async () => { running.abort(); });
    expect((await new DocumentMutationCoordinator(second.api).updateText(request(head, element.elementId, { signal: running.signal }))).status).toBe('cancelled');
    expect(second.api.registerCandidate).not.toHaveBeenCalled();
  });

  it('reports a committed artifact honestly when cancelled after CAS', async () => {
    const { head, element } = await fixture();
    const { api } = ports(head);
    const controller = new AbortController();
    api.compareAndSwapHead.mockImplementation(async () => { controller.abort(); return true; });
    expect((await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId, { signal: controller.signal }))).status).toBe('committed_pending_refresh');
    expect(api.refreshSession).not.toHaveBeenCalled();
  });

  it('cleans up a candidate when cancellation wins after registration but before CAS', async () => {
    const { head, element } = await fixture();
    const { api, getHead } = ports(head);
    const controller = new AbortController();
    api.registerCandidate.mockImplementation(async candidate => { controller.abort(); return { ...candidate, workId: candidate.pin.headWorkId }; });
    expect((await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId, { signal: controller.signal }))).status).toBe('cancelled');
    expect(api.compareAndSwapHead).not.toHaveBeenCalled();
    expect(api.cleanupCandidate).toHaveBeenCalledTimes(1);
    expect(getHead()).toBe(head);
  });

  it('handles an authorization rejection inside the final CAS lock as an uncommitted candidate', async () => {
    const { head, element } = await fixture();
    const { api, getHead } = ports(head);
    api.compareAndSwapHead.mockRejectedValue(new Error('authorization_denied'));
    expect((await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId))).record.diagnostic).toBe('authorization_denied');
    expect(api.cleanupCandidate).toHaveBeenCalledTimes(1);
    expect(api.refreshSession).not.toHaveBeenCalled();
    expect(getHead()).toBe(head);
  });

  it('retains the committed fact if the post-CAS ledger acknowledgment fails', async () => {
    const { head, element } = await fixture();
    const { api, getHead } = ports(head);
    api.saveRecord.mockImplementation(async record => { if (record.state === 'committed') throw new Error('disk acknowledgment lost'); });
    expect((await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId))).status).toBe('committed_pending_refresh');
    expect(getHead().pin.headWorkId).not.toBe(head.pin.headWorkId);
    expect(api.reconcile).toHaveBeenCalledTimes(1);
  });

  it('reports committed_pending_refresh when real-file Session refresh fails', async () => {
    const { head, element } = await fixture();
    const { api, getHead } = ports(head);
    api.refreshSession.mockRejectedValue(new Error('read failure'));
    const result = await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId));
    expect(result.status).toBe('committed_pending_refresh');
    expect(getHead().pin.headWorkId).not.toBe(head.pin.headWorkId);
  });

  it('fails closed if the durable ledger cannot be read without overwriting it', async () => {
    const { head, element } = await fixture();
    const { api } = ports(head);
    api.loadRecord.mockRejectedValue(new Error('corrupt record'));
    const result = await new DocumentMutationCoordinator(api).updateText(request(head, element.elementId));
    expect(result.record.diagnostic).toBe('reconciliation_required');
    expect(api.saveRecord).not.toHaveBeenCalled();
    expect(api.materialize).not.toHaveBeenCalled();
  });
});

describe('minimal DocumentIRPatch', () => {
  it('uses canonical SHA256 and rejects extra keys, unsafe controls and unpaired surrogates', async () => {
    const patch = updateTextPatch('element-safe', 'safe 😃');
    expect(await patchFingerprint(patch)).toBe(createHash('sha256').update(JSON.stringify(patch)).digest('hex'));
    expect(() => parseDocumentIRPatch({ ...patch, rootDirectory: 'private' })).toThrow('invalid_ir_patch');
    expect(() => updateTextPatch('element-safe', 'bad\u0000')).toThrow('invalid_ir_patch');
    expect(() => updateTextPatch('element-safe', 'bad\ud800')).toThrow('invalid_ir_patch');
    expect(() => updateTextPatch('element-safe', 'safe\ntext\t')).not.toThrow();
  });
});
