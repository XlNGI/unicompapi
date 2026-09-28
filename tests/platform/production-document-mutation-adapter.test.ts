import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toConversationId, toMessageId, toProjectId, toWorkId } from '../../src/domain';
import type { DocumentVersionPin } from '../../src/domain/entities/document-version-pin';
import { updateTextPatch } from '../../src/domain/entities/document-ir-patch';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { parseDocumentOutline } from '../../src/platform/documents/document-outline-parser';
import { DocumentIdentityIndexStore } from '../../src/platform/documents/document-identity-index-store';
import { DocumentMutationHeadStore } from '../../src/platform/documents/document-mutation-head-store';
import { createProductionDocumentMutationHost } from '../../src/platform/documents/production-document-mutation-adapter';
import { buildPresentationIdentityManifest, readIdentityElementTexts, verifyPresentationIdentityManifest } from '../../src/platform/documents/presentation-identity-manifest';
import * as presentationIdentity from '../../src/platform/documents/presentation-identity-manifest';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import type { ConversationDocumentMutationToolSelection } from '../../src/platform/documents/conversation-document-tool-session';
import type { DocumentRenderAdapter } from '../../src/platform/documents/temporary-document-workflow';
import { readPptxDocument } from '../../src/platform/documents/pptx-page-reader';
import { NodeProjectStorage, toProjectRelativePath } from '../../src/platform/storage';
import { JsonExecutionRepository, JsonFileReferenceRepository, JsonWorkRepository } from '../../src/platform/repositories/json-repositories';

const roots: string[] = [];
const projectId = toProjectId('project-production-mutation');
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })));
});
const renderer: DocumentRenderAdapter = async temporary => ({ previewCount: (await readPptxDocument(await readFile(temporary))).length, diagnostics: [] });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-production-mutation-'));
  roots.push(rootDirectory);
  const storage = new NodeProjectStorage(rootDirectory);
  const identities = new DocumentIdentityIndexStore(storage);
  const heads = new DocumentMutationHeadStore(storage);
  const works = new JsonWorkRepository(storage, projectId);
  const files = new JsonFileReferenceRepository(storage, projectId);
  const executions = new JsonExecutionRepository(storage);
  const reader = new RegisteredPresentationReader({ rootDirectory, projectId });
  const runner = new DocumentGenerationRunner({ rootDirectory, projectId, renderPreview: renderer, requireRenderForPpt: true });
  let count = 0;
  async function generate(title = '文本事务') {
    const outline = parseDocumentOutline(JSON.stringify({ kind: 'ppt', title, sections: [{ heading: '目标页', level: 1,
      blocks: [{ type: 'paragraph', text: '重复目标' }, { type: 'paragraph', text: '重复目标' }] }] }));
    return runner.run({ kind: 'ppt', title, outline, contentFingerprint: hash(title), draftRevision: 1,
      sourceDraftId: 'fixture-' + ++count, presentationTemplate: 'business_minimal' });
  }
  const original = await generate();
  const actual = await reader.read(original.work.id);
  const lineage = 'lineage-production-mutation';
  const identity = await identities.ensureForWork({ workId: original.work.id, build: () => buildPresentationIdentityManifest({
    buffer: actual.buffer, documentLineageId: lineage, workId: original.work.id, fileId: original.file.id,
    sourceExecutionId: original.work.sourceExecutionId, revision: 1 }) });
  const pin: DocumentVersionPin = { documentLineageId: lineage, headWorkId: original.work.id, fileId: original.file.id,
    sourceExecutionId: original.work.sourceExecutionId, checksumSha256: original.file.checksumSha256!, runtimeRevision: 1, identityIndexVersion: 1 };
  await heads.save(pin);
  const duplicate = identity.elements.filter(element => element.text === '重复目标');
  expect(duplicate).toHaveLength(2);
  const [untouched, target] = duplicate;
  const selection: ConversationDocumentMutationToolSelection = {
    kind: 'mutation', writeAuthorized: true, projectId, conversationId: toConversationId('conversation-mutation'),
    currentUserMessageId: toMessageId('message-update'), userMessageRevision: 0, userMessageHash: hash('修改目标'),
    sourceMessageId: toMessageId('source-document'), revision: 1, workId: original.work.id, fileId: original.file.id,
    checksumSha256: pin.checksumSha256, sizeBytes: original.file.sizeBytes!, fileName: actual.fileName,
    sourceExecutionId: original.work.sourceExecutionId, fileUpdatedAt: original.file.updatedAt,
    scope: 'document', bindingHash: hash('host-only-binding'), documentLineageId: lineage, identity
  };
  const refresh = vi.fn(async () => undefined);
  function host(renderPreview: DocumentRenderAdapter = renderer, refreshSession = refresh) {
    return createProductionDocumentMutationHost({ rootDirectory, projectId, selection, renderPreview, refreshSession });
  }
  const request = (text = '已更新目标', expectedPin = pin, controller = new AbortController()) => ({
    mutationId: 'mutation-stable-call', idempotencyKey: 'idempotency-stable-call', expectedPin,
    patch: updateTextPatch(target.elementId, text), signal: controller.signal, authorize: async () => true
  });
  const sourcePath = original.file.locator.kind === 'project' ? path.join(rootDirectory, original.file.locator.relativePath) : '';
  return { rootDirectory, storage, identities, heads, works, files, executions, reader, generate, original, actual,
    identity, pin, target, untouched, selection, refresh, host, request, sourcePath };
}

describe('production mutation artifact transaction', () => {
  it('rechecks cancellation at the atomic head replacement boundary', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const originalWrite = NodeProjectStorage.prototype.writeJsonAtomically;
    vi.spyOn(NodeProjectStorage.prototype, 'writeJsonAtomically').mockImplementation(async function (this: NodeProjectStorage, target, value, options) {
      if (target.startsWith('entities/document-mutation-head/')) controller.abort();
      return originalWrite.call(this, target, value, options);
    });
    const result = await f.host().coordinator.updateText(f.request('取消的文本', f.pin, controller));
    expect(result.status).toBe('cancelled');
    expect(await f.heads.get(f.pin.documentLineageId)).toEqual(f.pin);
    expect(await readFile(f.sourcePath)).toEqual(f.actual.buffer);
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it('registers a verified immutable manifest and Work before head CAS, then reads the exact changed element from the new file', async () => {
    const f = await fixture();
    const render = vi.fn(renderer);
    const originalCas = DocumentMutationHeadStore.prototype.compareAndSwap;
    let checkedCommitBoundary = false;
    vi.spyOn(DocumentMutationHeadStore.prototype, 'compareAndSwap').mockImplementation(async function (this: DocumentMutationHeadStore, expected, next, options) {
      expect(await f.heads.get(f.pin.documentLineageId)).toEqual(f.pin);
      const work = await f.works.get(toWorkId(next.headWorkId));
      expect(work).toBeDefined();
      const manifest = await f.identities.getForWork(next.headWorkId);
      expect(manifest).toMatchObject({ workId: next.headWorkId, fileId: next.fileId, sourceExecutionId: next.sourceExecutionId,
        revision: next.runtimeRevision, artifactChecksumSha256: next.checksumSha256 });
      const real = await f.reader.read(work!.id);
      await verifyPresentationIdentityManifest(real.buffer, manifest);
      checkedCommitBoundary = true;
      return originalCas.call(this, expected, next, options);
    });
    const result = await f.host(render).coordinator.updateText(f.request());
    expect(result.status).toBe('session_refreshed');
    expect(checkedCommitBoundary).toBe(true);
    expect(render).toHaveBeenCalledOnce();
    expect(f.refresh).toHaveBeenCalledOnce();
    const current = await f.heads.get(f.pin.documentLineageId);
    expect(current).toEqual(result.candidate!.pin);
    expect(current!.checksumSha256).not.toBe(f.pin.checksumSha256);
    expect(current!.runtimeRevision).toBe(2);
    const registered = await f.reader.read(toWorkId(current!.headWorkId));
    expect(registered.file.checksumSha256).toBe(current!.checksumSha256);
    expect(registered.work.sourceExecutionId).toBe(current!.sourceExecutionId);
    expect(registered.work.parentWorkId).toBe(f.pin.headWorkId);
    const manifest = (await f.identities.getForWork(current!.headWorkId))!;
    const text = await readIdentityElementTexts(registered.buffer, manifest);
    expect(text.get(f.target.elementId)).toBe('已更新目标');
    expect(text.get(f.untouched.elementId)).toBe('重复目标');
    expect(manifest.elements.map(element => element.elementId)).toEqual(f.identity.elements.map(element => element.elementId));
    expect((await f.executions.get(registered.work.sourceExecutionId))?.state).toBe('completed');
    expect(await readFile(f.sourcePath)).toEqual(f.actual.buffer);
  });

  it('reopens the durable same-call ledger without creating another candidate or revision', async () => {
    const f = await fixture();
    const render = vi.fn(renderer);
    expect((await f.host(render).coordinator.updateText(f.request())).status).toBe('session_refreshed');
    const head = await f.heads.get(f.pin.documentLineageId);
    const replay = await f.host(render).coordinator.updateText(f.request());
    expect(replay.status).toBe('session_refreshed');
    expect(render).toHaveBeenCalledOnce();
    expect(await f.works.list(projectId)).toHaveLength(2);
    expect(await f.heads.get(f.pin.documentLineageId)).toEqual(head);
    expect((await f.host().readHead()).pin).toEqual(head);
  });

  it('preserves the old authoritative artifact when rendered QA fails', async () => {
    const f = await fixture();
    const result = await f.host(async () => ({ previewCount: 1, diagnostics: [{ code: 'text_overflow', severity: 'error', scope: 'page', message: 'bounded diagnostic' }] })).coordinator.updateText(f.request());
    expect(result).toMatchObject({ status: 'failed', record: { diagnostic: 'qa_failed' } });
    expect(await f.heads.get(f.pin.documentLineageId)).toEqual(f.pin);
    expect(await f.works.list(projectId)).toHaveLength(1);
    expect(await readFile(f.sourcePath)).toEqual(f.actual.buffer);
    expect((await f.reader.read(f.original.work.id)).file.checksumSha256).toBe(f.pin.checksumSha256);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it('propagates cancellation into rendering and never registers or commits a candidate', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const render: DocumentRenderAdapter = async (_path, context) => {
      expect(context.signal).toBe(controller.signal);
      controller.abort();
      return { previewCount: 1, diagnostics: [] };
    };
    const result = await f.host(render).coordinator.updateText(f.request('已更新目标', f.pin, controller));
    expect(result.status).toBe('cancelled');
    expect(await f.heads.get(f.pin.documentLineageId)).toEqual(f.pin);
    expect(await f.works.list(projectId)).toHaveLength(1);
    expect(await readFile(f.sourcePath)).toEqual(f.actual.buffer);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it('rejects a concurrent authoritative version published during rendering and keeps its own candidate detached', async () => {
    const f = await fixture();
    let rivalPin: DocumentVersionPin | undefined;
    const render: DocumentRenderAdapter = async () => {
      const rival = await f.generate('并发版本');
      const actual = await f.reader.read(rival.work.id);
      const identity = await buildPresentationIdentityManifest({ buffer: actual.buffer, documentLineageId: f.pin.documentLineageId,
        workId: rival.work.id, fileId: rival.file.id, sourceExecutionId: rival.work.sourceExecutionId, revision: 2 });
      await f.identities.save(identity);
      rivalPin = { ...f.pin, headWorkId: rival.work.id, fileId: rival.file.id, sourceExecutionId: rival.work.sourceExecutionId,
        checksumSha256: rival.file.checksumSha256!, runtimeRevision: 2 };
      expect(await f.heads.compareAndSwap(f.pin, rivalPin)).toBe(true);
      return { previewCount: actual.pages.length, diagnostics: [] };
    };
    const result = await f.host(render).coordinator.updateText(f.request());
    expect(result.status).toBe('revision_conflict');
    expect(await f.heads.get(f.pin.documentLineageId)).toEqual(rivalPin);
    expect(result.candidate?.pin.headWorkId).not.toBe(rivalPin!.headWorkId);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(await readFile(f.sourcePath)).toEqual(f.actual.buffer);
  });

  it('detects changed source bytes before the final head switch instead of overwriting them', async () => {
    const f = await fixture();
    const changed = Buffer.from('external update while rendering');
    const render: DocumentRenderAdapter = async () => {
      await writeFile(f.sourcePath, changed);
      return { previewCount: 1, diagnostics: [] };
    };
    const result = await f.host(render).coordinator.updateText(f.request());
    expect(result.status).toBe('revision_conflict');
    expect(await f.heads.get(f.pin.documentLineageId)).toEqual(f.pin);
    expect(await readFile(f.sourcePath)).toEqual(changed);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it('reports a committed head honestly when Session refresh fails and replay does not modify again', async () => {
    const f = await fixture();
    const render = vi.fn(renderer);
    const refresh = vi.fn(async () => { throw new Error('refresh_failed'); });
    const result = await f.host(render, refresh).coordinator.updateText(f.request());
    expect(result).toMatchObject({ status: 'committed_pending_refresh', record: { diagnostic: 'committed_pending_refresh' } });
    expect(await f.heads.get(f.pin.documentLineageId)).toEqual(result.candidate!.pin);
    const actual = await f.reader.read(toWorkId(result.candidate!.pin.headWorkId));
    expect((await readIdentityElementTexts(actual.buffer, result.candidate!.identity)).get(f.target.elementId)).toBe('已更新目标');
    expect((await f.host(render).coordinator.updateText(f.request())).status).toBe('committed_pending_refresh');
    expect(render).toHaveBeenCalledOnce();
    expect(await f.works.list(projectId)).toHaveLength(2);
  });

  it.each(['materialized', 'commit_prepared', 'malformed_array', 'malformed_value'])(
    'blocks a reopened Host and a new call for a crash journal in state %s', async state => {
      const f = await fixture();
      const indexPath = toProjectRelativePath('entities/document-mutations/index-' + hash(f.pin.documentLineageId) + '.json');
      const journal: unknown = state === 'malformed_array' ? [] : state === 'malformed_value'
        ? { [hash('abandoned-call')]: { state: 'commit_prepared' } }
        : { [hash('abandoned-call')]: state };
      await f.storage.writeJsonAtomically(indexPath, journal);
      const render = vi.fn(renderer);
      const apply = vi.spyOn(presentationIdentity, 'applyPresentationTextPatch');
      const restarted = f.host(render);
      if (state.startsWith('malformed')) await expect(restarted.isBlocked()).rejects.toThrow('reconciliation_required');
      else expect(await restarted.isBlocked()).toBe(true);
      const result = await restarted.coordinator.updateText({ ...f.request(), mutationId: 'new-task-mutation', idempotencyKey: 'new-task-call' });
      expect(result.status).toBe('reconciliation_required');
      expect(apply).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
      expect(await f.works.list(projectId)).toHaveLength(1);
      expect(await f.heads.get(f.pin.documentLineageId)).toEqual(f.pin);
      expect(await readFile(f.sourcePath)).toEqual(f.actual.buffer);
      expect(await f.storage.readJson(indexPath)).toEqual(journal);
    });

  it('retains the committed version fact when cancellation arrives immediately after CAS and before refresh', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const render = vi.fn(renderer);
    const originalCas = DocumentMutationHeadStore.prototype.compareAndSwap;
    vi.spyOn(DocumentMutationHeadStore.prototype, 'compareAndSwap').mockImplementation(async function (this: DocumentMutationHeadStore, expected, next, options) {
      const switched = await originalCas.call(this, expected, next, options);
      if (switched) controller.abort();
      return switched;
    });
    const host = f.host(render);
    const result = await host.coordinator.updateText(f.request('已更新目标', f.pin, controller));
    expect(result.status).toBe('committed_pending_refresh');
    const committed = await host.committedVersion();
    expect(committed).toEqual(result.candidate!.pin);
    expect(await f.heads.get(f.pin.documentLineageId)).toEqual(committed);
    expect(f.refresh).not.toHaveBeenCalled();
    const recordPath = toProjectRelativePath('entities/document-mutations/call-' + hash('idempotency-stable-call') + '.json');
    expect(await f.storage.readJson(recordPath)).toMatchObject({ state: 'committed_pending_refresh', candidatePin: committed });
    const restarted = f.host(render);
    expect((await restarted.coordinator.updateText(f.request())).status).toBe('committed_pending_refresh');
    expect(await restarted.committedVersion()).toEqual(committed);
    expect(render).toHaveBeenCalledOnce();
    expect(await f.works.list(projectId)).toHaveLength(2);
    const actual = await f.reader.read(toWorkId(committed!.headWorkId));
    expect((await readIdentityElementTexts(actual.buffer, (await f.identities.getForWork(committed!.headWorkId))!)).get(f.target.elementId)).toBe('已更新目标');
  });
});
