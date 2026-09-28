import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDocumentOutline } from '../../src/platform/documents/document-outline-parser';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';
import { buildPresentationIdentityManifest, readIdentityElementText } from '../../src/platform/documents/presentation-identity-manifest';
import { DocumentMutationCoordinator, type DocumentMutationHead } from '../../src/application/document-mutation-coordinator';
import type { DocumentVersionPin } from '../../src/domain/entities/document-version-pin';
import { updateTextPatch } from '../../src/domain/entities/document-ir-patch';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-mutation-coordinator-'));
  roots.push(root);
  const outline = parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: '事务测试', sections: [{ heading: '目标页', level: 1,
    blocks: [{ type: 'paragraph', text: '原始文本' }] }] }));
  const generated = await generateTemporaryDocumentFile({ kind: 'ppt', outline, outputDirectory: root, now: '2026-09-28T12:00:00.000Z' });
  const buffer = await readFile(generated.temporaryPath);
  const identity = await buildPresentationIdentityManifest({ buffer, documentLineageId: 'lineage-coordinator', workId: 'work-head-1', revision: 1 });
  const element = identity.elements.find(item => item.text === '原始文本')!;
  const pin: DocumentVersionPin = { documentLineageId: identity.documentLineageId, headWorkId: identity.workId, fileId: 'file-head-1',
    sourceExecutionId: 'execution-head-1', checksumSha256: identity.artifactChecksumSha256, runtimeRevision: 1, identityIndexVersion: 1 };
  const head: DocumentMutationHead = { pin, buffer, identity };
  return { head, element };
}

function ports(head: DocumentMutationHead) {
  const calls = { register: 0, cas: 0, refresh: 0, reconcile: 0, cleanup: 0 };
  const api = {
    readHead: vi.fn(async () => head),
    registerCandidate: vi.fn(async (candidate: { readonly pin: DocumentVersionPin; readonly buffer: Uint8Array; readonly identity: DocumentMutationHead['identity']; readonly idempotencyKey: string; readonly signal: AbortSignal }) => { calls.register += 1; return { ...candidate, workId: 'work-candidate-2' }; }),
    compareAndSwapHead: vi.fn(async () => { calls.cas += 1; return true; }),
    cleanupCandidate: vi.fn(async () => { calls.cleanup += 1; }),
    reconcile: vi.fn(async () => { calls.reconcile += 1; }),
    refreshSession: vi.fn(async () => { calls.refresh += 1; }),
    qa: vi.fn(async () => undefined)
  };
  return { api, calls };
}

describe('document mutation coordinator', () => {
  it('commits a text patch and keeps the same element identity after read-back', async () => {
    const { head, element } = await fixture();
    const { api, calls } = ports(head);
    const coordinator = new DocumentMutationCoordinator(api);
    const result = await coordinator.updateText({ mutationId: 'mutation-1', idempotencyKey: 'call-1',
      patch: updateTextPatch(element.elementId, '修改后的文本'), signal: new AbortController().signal });
    expect(result.status).toBe('session_refreshed');
    expect(calls).toMatchObject({ register: 1, cas: 1, refresh: 1 });
    expect(result.candidate).toBeDefined();
    expect(await readIdentityElementText(result.candidate!.buffer, result.candidate!.identity, element.elementId)).toBe('修改后的文本');
    expect((await coordinator.updateText({ mutationId: 'mutation-1', idempotencyKey: 'call-1', patch: updateTextPatch(element.elementId, '再次修改'), signal: new AbortController().signal })).status).toBe('session_refreshed');
    expect(calls.register).toBe(1);
  });

  it('rejects a head race before commit and reconciles the candidate', async () => {
    const { head, element } = await fixture();
    const { api, calls } = ports(head);
    api.compareAndSwapHead.mockResolvedValue(false);
    const result = await new DocumentMutationCoordinator(api).updateText({ mutationId: 'mutation-race', idempotencyKey: 'call-race',
      patch: updateTextPatch(element.elementId, '不应覆盖'), signal: new AbortController().signal });
    expect(result.status).toBe('revision_conflict');
    expect(calls.reconcile).toBe(1);
    expect(calls.refresh).toBe(0);
  });

  it('does not register a candidate when cancelled before commit and reports refresh failure honestly', async () => {
    const { head, element } = await fixture();
    const cancelled = new AbortController();
    cancelled.abort();
    const first = ports(head);
    const cancelledResult = await new DocumentMutationCoordinator(first.api).updateText({ mutationId: 'mutation-cancel', idempotencyKey: 'call-cancel',
      patch: updateTextPatch(element.elementId, '不应提交'), signal: cancelled.signal });
    expect(cancelledResult.status).toBe('cancelled');
    expect(first.calls.register).toBe(0);
    const second = ports(head);
    second.api.refreshSession.mockRejectedValue(new Error('refresh_failed'));
    const pending = await new DocumentMutationCoordinator(second.api).updateText({ mutationId: 'mutation-pending', idempotencyKey: 'call-pending',
      patch: updateTextPatch(element.elementId, '已提交待刷新'), signal: new AbortController().signal });
    expect(pending.status).toBe('committed_pending_refresh');
  });

  it('treats an uncertain candidate registration as reconciliation-required', async () => {
    const { head, element } = await fixture();
    const { api, calls } = ports(head);
    api.registerCandidate.mockRejectedValue(new Error('storage acknowledgement lost'));
    const result = await new DocumentMutationCoordinator(api).updateText({ mutationId: 'mutation-unknown', idempotencyKey: 'call-unknown',
      patch: updateTextPatch(element.elementId, '可能已写入'), signal: new AbortController().signal });
    expect(result.status).toBe('reconciliation_required');
    expect(calls.reconcile).toBe(1);
  });
});
