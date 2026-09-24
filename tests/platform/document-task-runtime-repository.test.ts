import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentTaskRuntime, toConversationId, toDocumentTaskRuntimeId, toIsoTimestamp, toMessageId, toProjectId } from '../../src/domain';
import { DocumentTaskRuntimeService } from '../../src/application';
import { runPersistentDocumentAgent } from '../../src/platform/documents/persistent-document-agent';
import { DocumentTaskRuntimeRevisionConflictError, JsonDocumentTaskRuntimeRepository } from '../../src/platform/repositories';
import { NodeProjectStorage, projectStoragePaths } from '../../src/platform/storage';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-document-runtime-'));
  roots.push(root);
  const projectId = toProjectId('project-runtime');
  const storage = new NodeProjectStorage(root);
  const now = () => new Date().toISOString();
  const repository = new JsonDocumentTaskRuntimeRepository(storage, projectId, now);
  const runtime = createDocumentTaskRuntime({
    id: toDocumentTaskRuntimeId('runtime-1'), projectId,
    conversationId: toConversationId('conversation-1'), sourceMessageId: toMessageId('message-1'),
    executionId: 'execution-1', documentKind: 'ppt',
    pageRefs: [{ pageId: 'page-1', pageRevision: 2 }],
    budget: { maxSteps: 8, budgetUnits: 16, timeoutMs: 120_000 },
    createdAt: toIsoTimestamp(now())
  });
  const service = new DocumentTaskRuntimeService(repository, { now, validateBindings: async () => true });
  return { repository, runtime, projectId, root, storage, service };
}

describe('document task runtime repository', () => {
  it('persists and reopens a runtime with page revisions', async () => {
    const f = await fixture();
    await f.repository.create(f.runtime);
    const reopened = new JsonDocumentTaskRuntimeRepository(new NodeProjectStorage(f.root), f.projectId);
    expect(await f.repository.get(f.runtime.id)).toMatchObject({ pageRefs: [{ pageId: 'page-1', pageRevision: 2 }] });
    expect(await reopened.list(toConversationId('conversation-1'))).toHaveLength(1);
  });

  it('rejects cross-project writes and stale revisions', async () => {
    const f = await fixture();
    await expect(f.repository.create({ ...f.runtime, projectId: toProjectId('other-project') })).rejects.toThrow('another project');
    await f.repository.create(f.runtime);
    await expect(f.repository.save({ ...f.runtime, revision: 2 }, 1)).rejects.toBeInstanceOf(DocumentTaskRuntimeRevisionConflictError);
  });

  it('rejects unsafe persisted observations and page duplicates', async () => {
    const f = await fixture();
    await expect(f.repository.create({ ...f.runtime, pageRefs: [{ pageId: 'same', pageRevision: 1 }, { pageId: 'same', pageRevision: 2 }] })).rejects.toThrow();
    await expect(f.repository.create({ ...f.runtime, observations: [{ step: 1, toolId: 'read_document_structure', ok: true, data: { filePath: 'C:\\secret.pptx' } }] })).rejects.toThrow();
  });

  it('serializes competing write-ahead claims so only one caller may execute', async () => {
    const f = await fixture();
    await f.repository.create(f.runtime);
    const other = new DocumentTaskRuntimeService(
      new JsonDocumentTaskRuntimeRepository(new NodeProjectStorage(f.root), f.projectId),
      { validateBindings: async () => true });
    const input = { callId: 'call-1', toolId: 'apply_document_patch' as const, inputHash: 'a'.repeat(64) };
    const claims = await Promise.allSettled([f.service.beginToolCall(f.runtime, input), other.beginToolCall(f.runtime, input)]);
    expect(claims.filter(claim => claim.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter(claim => claim.status === 'rejected')).toHaveLength(1);
    expect((await f.repository.get(f.runtime.id))?.checkpoint.costUnits).toBe(4);
  });

  it('never treats an older backup as an executable runtime', async () => {
    const f = await fixture();
    await f.repository.create(f.runtime);
    await f.storage.writeJsonAtomically(projectStoragePaths.entities.documentTaskRuntimes, { malformed: true }, { backup: true });
    await expect(f.repository.get(f.runtime.id)).rejects.toThrow('backup requires explicit reconciliation');
  });

  it('rejects binding mutation and cross-project stored records', async () => {
    const f = await fixture();
    await f.repository.create(f.runtime);
    await expect(f.repository.save({ ...f.runtime, revision: 1, executionId: 'other' }, 0)).rejects.toThrow('binding is immutable');
    const other = new JsonDocumentTaskRuntimeRepository(new NodeProjectStorage(f.root), toProjectId('other'));
    await expect(other.list()).rejects.toThrow();
  });
});

describe('persistent document loop with real local storage', () => {
  const request = { toolId: 'read_document_structure', input: { section: 'summary' }, reason: 'inspect' };

  it('reopens observations, resumes numbering and keeps model completion unpublished', async () => {
    const f = await fixture();
    await f.repository.create(f.runtime);
    let executions = 0;
    const events: string[] = [];
    const first = await runPersistentDocumentAgent({
      service: f.service, scope: f.runtime, allowedTools: ['read_document_structure'],
      onEvent: event => { events.push(event.stage); },
      execute: async () => { executions++; return { sections: 2 }; },
      nextDecision: async observations => observations.length === 0
        ? { kind: 'tool', request } : { kind: 'complete', summary: 'candidate ready' }
    });
    expect(first.agent.state).toBe('completed');
    expect(first.runtime.status).toBe('paused');
    expect(events).not.toContain('completed');
    const reopened = new DocumentTaskRuntimeService(
      new JsonDocumentTaskRuntimeRepository(new NodeProjectStorage(f.root), f.projectId),
      { validateBindings: async () => true });
    const second = await runPersistentDocumentAgent({
      service: reopened, scope: f.runtime, allowedTools: ['read_document_structure'],
      execute: async () => { executions++; return { sections: 3 }; },
      nextDecision: async observations => observations.length === 1
        ? { kind: 'tool', request } : { kind: 'complete', summary: 'candidate ready' }
    });
    expect(executions).toBe(2);
    expect(second.runtime.observations.map(item => item.step)).toEqual([1, 2]);
    expect(second.runtime.checkpoint.costUnits).toBe(2);
    expect(second.runtime.status).toBe('paused');
  });

  it('stops before executing if the write-ahead checkpoint cannot be saved', async () => {
    const f = await fixture();
    await f.repository.create(f.runtime);
    const execute = vi.fn(async () => ({}));
    vi.spyOn(f.repository, 'save').mockRejectedValueOnce(new Error('disk_failed'));
    const result = await runPersistentDocumentAgent({ service: f.service, scope: f.runtime,
      allowedTools: ['read_document_structure'], execute, nextDecision: async () => ({ kind: 'tool', request }) });
    expect(execute).not.toHaveBeenCalled();
    expect(result.runtime.status).toBe('failed');
  });

  it('stops after a failed observation commit and requires reconciliation after reopen', async () => {
    const f = await fixture();
    await f.repository.create(f.runtime);
    const execute = vi.fn(async () => {
      vi.spyOn(f.repository, 'save').mockRejectedValueOnce(new Error('disk_failed'));
      return { changed: true };
    });
    const result = await runPersistentDocumentAgent({ service: f.service, scope: f.runtime,
      allowedTools: ['apply_document_patch'], execute,
      nextDecision: async () => ({ kind: 'tool', request: { ...request, toolId: 'apply_document_patch' } }) });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.runtime.status).toBe('needs_reconciliation');
    const reopened = new DocumentTaskRuntimeService(
      new JsonDocumentTaskRuntimeRepository(new NodeProjectStorage(f.root), f.projectId), { validateBindings: async () => true });
    await expect(runPersistentDocumentAgent({ service: reopened, scope: f.runtime,
      allowedTools: ['apply_document_patch'], execute, nextDecision: async () => ({ kind: 'tool', request }) }))
      .rejects.toThrow('runtime_not_resumable');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight write without accepting its late result', async () => {
    const f = await fixture();
    await f.repository.create(f.runtime);
    const controller = new AbortController();
    let finish!: (value: Readonly<Record<string, unknown>>) => void;
    let toolSignal: AbortSignal | undefined;
    const result = await runPersistentDocumentAgent({ service: f.service, scope: f.runtime,
      signal: controller.signal, allowedTools: ['apply_document_patch'],
      execute: async (_request, context) => {
        toolSignal = context.signal;
        const pending = new Promise<Readonly<Record<string, unknown>>>(resolve => { finish = resolve; });
        setTimeout(() => controller.abort(), 5);
        return pending;
      },
      nextDecision: async () => ({ kind: 'tool', request: { ...request, toolId: 'apply_document_patch' } }) });
    expect(result.agent.state).toBe('cancelled');
    expect(result.runtime.status).toBe('needs_reconciliation');
    expect(toolSignal?.aborted).toBe(true);
    finish({ changed: true });
    await Promise.resolve();
    expect((await f.repository.get(f.runtime.id))?.observations).toHaveLength(0);
  });
});
