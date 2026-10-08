import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConversationAgentRun,
  toConversationAgentRunId,
  toConversationId,
  toConversationResponseExecutionId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  attachConversationAgentRunExecution,
  transitionConversationAgentRun
} from '../../src/domain';
import { JsonConversationAgentRunRepository, ConversationAgentRunRevisionConflictError } from '../../src/platform';
import { NodeProjectStorage, projectStoragePaths } from '../../src/platform/storage';
import { chatContextFailure } from '../../src/platform/ipc/chat-context-errors';

const roots: string[] = [];
const projectId = toProjectId('project-agent-run-repository');
const conversationId = toConversationId('conversation-agent-run-repository');
const sourceMessageId = toMessageId('message-agent-run-repository');
const t0 = toIsoTimestamp('2026-09-30T11:00:00.000Z');
const t1 = toIsoTimestamp('2026-09-30T11:01:00.000Z');
const t2 = toIsoTimestamp('2026-09-30T11:02:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('JsonConversationAgentRunRepository', () => {
  const newRun = () => createConversationAgentRun({ id: toConversationAgentRunId('new-run'),
    projectId, conversationId, sourceMessageId, createdAt: t2 });
  async function history(override: Record<string, unknown> = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-history-'));
    roots.push(root);
    const storage = new NodeProjectStorage(root);
    const run = { ...transitionConversationAgentRun({ ...newRun(), id: toConversationAgentRunId('old-run') }, 'completed', t2),
      documentTaskIds: ['document-task-1'], ...override };
    const document = { schemaVersion: 1, revision: 1, updatedAt: t2, runs: [run] };
    await storage.writeJsonAtomically(projectStoragePaths.entities.conversationAgentRuns, document);
    return { repository: new JsonConversationAgentRunRepository(storage, projectId, () => t2), storage, run,
      file: path.join(root, 'entities/conversation-agent-runs.json') };
  }

  it('reads completed task manifests without writing and preserves them through unrelated create/save and backup', async () => {
    const { repository, run, file } = await history();
    const original = await readFile(file, 'utf8');
    expect(await repository.list()).toEqual([run]);
    expect(await readFile(file, 'utf8')).toBe(original);
    const created = newRun();
    await repository.create(created);
    expect(await readFile(`${file}.bak`, 'utf8')).toBe(original);
    await repository.save(transitionConversationAgentRun(created, 'completed', t2), 0);
    expect(JSON.parse(await readFile(file, 'utf8')).runs[0]).toEqual(run);
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8')).runs[0]).toEqual(run);
  });

  it.each([
    { status: 'running' }, { status: 'needs_reconciliation' }, { documentTaskIds: null },
    { documentTaskIds: ['duplicate', 'duplicate'] }, { documentTaskIds: [123] },
    { documentTaskIds: ['../outside'] }, { documentTaskIds: Array.from({length: 33}, (_, i) => `task-${i}`) },
    { extra: true }, { projectId: 'other-project' }
  ])('rejects unsupported history without changing the file: %j', async override => {
    const { repository, file } = await history(override);
    const original = await readFile(file, 'utf8');
    const error = await repository.create(newRun()).catch(error => error);
    expect(chatContextFailure(error)).toMatchObject({ok: false, error: {code: 'local_chat_data_invalid'}});
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('does not allow an older writer to strip the completed run task manifest', async () => {
    const { repository, run, file } = await history();
    const { documentTaskIds: _manifest, ...base } = run;
    expect(_manifest).toEqual(['document-task-1']);
    const original = await readFile(file, 'utf8');
    await expect(repository.save({ ...base, revision: run.revision + 1 }, run.revision)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('refuses a corrupt primary even when an older valid backup exists', async () => {
    const { repository, file } = await history();
    await writeFile(`${file}.bak`, await readFile(file));
    await writeFile(file, '{broken');
    const error = await repository.list().catch(error => error);
    expect(chatContextFailure(error)).toMatchObject({ok: false, error: {code: 'local_chat_data_invalid'}});
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });

  it('persists lifecycle revisions and rejects stale writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-runs-'));
    roots.push(root);
    let currentTime = t0;
    const repository = new JsonConversationAgentRunRepository(
      new NodeProjectStorage(root),
      projectId,
      () => currentTime
    );
    const created = createConversationAgentRun({
      id: toConversationAgentRunId('agent-run-repository'),
      projectId,
      conversationId,
      sourceMessageId,
      createdAt: t0
    });
    await repository.create(created);
    currentTime = t1;
    const executing = attachConversationAgentRunExecution(
      created,
      toConversationResponseExecutionId('response-execution-agent-run-repository'),
      t1
    );
    await repository.save(executing, created.revision);
    currentTime = t2;
    const completed = transitionConversationAgentRun(executing, 'completed', t2);
    await repository.save(completed, executing.revision);

    await expect(repository.get(created.id)).resolves.toEqual(completed);
    await expect(repository.findByResponseExecutionId(executing.responseExecutionId!))
      .resolves.toEqual(completed);
    await expect(repository.save(completed, executing.revision)).rejects
      .toBeInstanceOf(ConversationAgentRunRevisionConflictError);
    const document = JSON.parse(await readFile(path.join(root, 'entities/conversation-agent-runs.json'), 'utf8')) as {
      runs: readonly { revision: number; status: string }[]
    };
    expect(document.runs).toEqual([{ ...completed }]);
  });
});
