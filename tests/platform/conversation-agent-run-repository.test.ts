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
  acknowledgeConversationAgentRunReconciliation,
  confirmConversationAgentRunProjectedCompletion,
  markConversationAgentRunNeedsReconciliation,
  transitionConversationAgentRun
} from '../../src/domain';
import { JsonConversationAgentRunRepository, ConversationAgentRunRevisionConflictError } from '../../src/platform';
import { NodeProjectStorage } from '../../src/platform/storage';

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

  it('rejects forged identity or terminal changes at the atomic CAS boundary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-run-cas-'));
    roots.push(root);
    const repository = new JsonConversationAgentRunRepository(new NodeProjectStorage(root), projectId, () => t2);
    const run = createConversationAgentRun({ id: toConversationAgentRunId('run-cas'), projectId, conversationId, sourceMessageId, createdAt: t0 });
    await repository.create(run);
    await expect(repository.save({ ...run, revision: 1, updatedAt: t1, sourceMessageId: toMessageId('other-message') }, 0)).rejects.toThrow(/immutable/);
    const frozen = markConversationAgentRunNeedsReconciliation(run, 'unknown_result', t1);
    await repository.save(frozen, 0);
    await expect(repository.save({ ...frozen, status: 'cancelled', reconciliationReason: undefined, revision: 2, updatedAt: t2 }, 1)).rejects.toThrow();
    expect(await repository.get(run.id)).toEqual(frozen);
  });

  it('does not grant execution or create a new run from a stale backup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-run-backup-'));
    roots.push(root);
    const repository = new JsonConversationAgentRunRepository(new NodeProjectStorage(root), projectId, () => t2);
    const run = createConversationAgentRun({ id: toConversationAgentRunId('run-backup'), projectId, conversationId, sourceMessageId, createdAt: t0 });
    await repository.create(run);
    const executing = attachConversationAgentRunExecution(run, toConversationResponseExecutionId('response-backup'), t1);
    await repository.save(executing, 0);
    const primary = path.join(root, 'entities/conversation-agent-runs.json');
    const backup = `${primary}.bak`;
    const existingBackup = await readFile(backup, 'utf8');
    await rm(primary);
    await expect(repository.get(run.id)).rejects.toThrow('agent_run_storage_reconciliation_required');
    await expect(repository.create({ ...run, id: toConversationAgentRunId('new-run') })).rejects.toThrow('agent_run_storage_reconciliation_required');
    expect(await readFile(backup, 'utf8')).toBe(existingBackup);
    await writeFile(primary, '{invalid', 'utf8');
    await expect(repository.list(conversationId)).rejects.toThrow('agent_run_storage_reconciliation_required');
    await expect(repository.save(transitionConversationAgentRun(executing, 'completed', t2), 1)).rejects.toThrow('agent_run_storage_reconciliation_required');
  });

  it('requires a dedicated revision-checked acknowledgement and preserves the unknown reason', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-run-ack-'));
    roots.push(root);
    const repository = new JsonConversationAgentRunRepository(new NodeProjectStorage(root), projectId, () => t2);
    const run = createConversationAgentRun({ id: toConversationAgentRunId('run-ack'), projectId, conversationId, sourceMessageId, createdAt: t0 });
    await repository.create(run);
    await expect(repository.acknowledgeReconciliation(run.id, 0, t1)).rejects.toThrow();
    const frozen = markConversationAgentRunNeedsReconciliation(run, 'observation_missing', t1);
    await repository.save(frozen, 0);
    const derived = acknowledgeConversationAgentRunReconciliation(frozen, t2);
    await expect(repository.save(derived, 1)).rejects.toThrow();
    await expect(repository.acknowledgeReconciliation(run.id, 0, t2)).rejects.toBeInstanceOf(ConversationAgentRunRevisionConflictError);
    const acknowledged = await repository.acknowledgeReconciliation(run.id, 1, t2, 'unknown_result');
    expect(acknowledged).toMatchObject({ status: 'cancelled', revision: 2, reconciliationReason: 'observation_missing',
      reconciliationAcknowledgement: { kind: 'closed_without_replay', confirmedAt: t2 } });
    expect(await repository.get(run.id)).toEqual(acknowledged);
    expect(await repository.acknowledgeReconciliation(run.id, 2, t2)).toEqual(acknowledged);
    await expect(repository.save({ ...acknowledged, revision: 3, updatedAt: t2, reconciliationReason: undefined }, 2)).rejects.toThrow();
  });

  it('adds only the acknowledgement fact when a WAL freeze follows a historical terminal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-run-terminal-ack-'));
    roots.push(root);
    const repository = new JsonConversationAgentRunRepository(new NodeProjectStorage(root), projectId, () => t2);
    const run = createConversationAgentRun({ id: toConversationAgentRunId('run-terminal-ack'), projectId, conversationId, sourceMessageId, createdAt: t0 });
    await repository.create(run);
    const completed = transitionConversationAgentRun(run, 'completed', t1);
    await repository.save(completed, 0);
    const acknowledged = await repository.acknowledgeReconciliation(run.id, 1, t2, 'entity_conflict');
    expect(acknowledged).toMatchObject({ status: 'completed', reconciliationReason: 'entity_conflict', revision: 2 });
    expect(acknowledged.createdAt).toBe(completed.createdAt);
    expect(acknowledged.sourceMessageId).toBe(completed.sourceMessageId);
  });

  it('uses a dedicated CAS for known local projection completion without accepting ordinary save or a stale revision', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-agent-run-confirm-projection-'));
    roots.push(root);
    const repository = new JsonConversationAgentRunRepository(new NodeProjectStorage(root), projectId, () => t2);
    const run = createConversationAgentRun({ id: toConversationAgentRunId('run-confirm-projection'), projectId, conversationId, sourceMessageId, createdAt: t0 });
    await repository.create(run);
    const frozen = markConversationAgentRunNeedsReconciliation(run, 'unknown_result', t1);
    await repository.save(frozen, 0);
    const confirmed = confirmConversationAgentRunProjectedCompletion(frozen, 'completed', t2);
    await expect(repository.save(confirmed, 1)).rejects.toThrow();
    await expect(repository.confirmProjectedCompletion(run.id, 0, 'completed', t2)).rejects.toBeInstanceOf(ConversationAgentRunRevisionConflictError);
    expect(await repository.confirmProjectedCompletion(run.id, 1, 'completed', t2)).toEqual(confirmed);
    expect((await repository.get(run.id))?.reconciliationReason).toBe('unknown_result');
    await expect(repository.confirmProjectedCompletion(run.id, 2, 'failed', t2)).rejects.toThrow();
  });
});
