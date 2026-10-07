import { createHash } from 'node:crypto';
import {
  agentRunReconciliationReasons, agentRunStatuses, conversationExecutionCompletionReasons,
  parseConversationAgentRun, toConversationResponseExecutionId, toIsoTimestamp,
  type ConversationResponseExecutionId, type ProjectId
} from '../../domain';
import type { ConversationCompletionIntent, ConversationCompletionJournal } from '../../application/conversation-completion-coordinator';
import {
  JsonRevisionConflictError, ProjectMetadataUnitOfWork, type JsonValue, type ProjectStorageAdapter
} from '../storage';

const prefix = 'conversation.completion.';

export class ConversationCompletionJournalDataError extends Error {
  constructor(message = 'Conversation completion journal requires reconciliation') {
    super(message);
    this.name = 'ConversationCompletionJournalDataError';
  }
}

/** One atomic metadata CAS owns each decision; dependent entity projections use this WAL. */
export class JsonConversationCompletionJournal implements ConversationCompletionJournal {
  private readonly unit: ProjectMetadataUnitOfWork;

  constructor(storage: ProjectStorageAdapter, private readonly projectId: ProjectId,
    now: () => string = () => new Date().toISOString()) {
    this.unit = new ProjectMetadataUnitOfWork(storage, now);
  }

  async get(id: ConversationResponseExecutionId): Promise<ConversationCompletionIntent | undefined> {
    const loaded = await this.requirePrimary();
    const entry = loaded.document.entries.find(entry => entry.key === key(id));
    if (!entry) return undefined;
    const intent = parseCompletionIntent(entry.value, this.projectId);
    if (intent.responseExecutionId !== id) throw new ConversationCompletionJournalDataError();
    return intent;
  }

  async listPending(): Promise<readonly ConversationCompletionIntent[]> {
    const loaded = await this.requirePrimary();
    return loaded.document.entries.filter(entry => entry.key.startsWith(prefix))
      .map(entry => parseCompletionIntent(entry.value, this.projectId))
      .filter(intent => intent.stage !== 'applied' && intent.stage !== 'acknowledged')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.responseExecutionId.localeCompare(right.responseExecutionId));
  }

  async save(intent: ConversationCompletionIntent, expectedRevision: number | null): Promise<void> {
    const validated = parseCompletionIntent(intent, this.projectId);
    if (validated.revision !== (expectedRevision ?? -1) + 1) throw new ConversationCompletionJournalDataError();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const loaded = await this.requirePrimary();
      try {
        await this.unit.transact(loaded.document.revision, draft => {
          const raw = draft.get(key(validated.responseExecutionId));
          const previous = raw === undefined ? undefined : parseCompletionIntent(raw, this.projectId);
          if ((previous?.revision ?? null) !== expectedRevision) throw new ConversationCompletionJournalDataError();
          if (previous && (previous.targetRun.id !== validated.targetRun.id ||
            previous.createdAt !== validated.createdAt || validated.updatedAt < previous.updatedAt)) {
            throw new ConversationCompletionJournalDataError();
          }
          if (previous && (previous.freezeOrigin === 'unknown_result' ||
            previous.stage === 'needs_reconciliation' && previous.freezeOrigin === undefined) &&
            validated.freezeOrigin === 'local_projection') throw new ConversationCompletionJournalDataError();
          draft.set(key(validated.responseExecutionId), validated as unknown as JsonValue);
        });
        return;
      } catch (error) {
        if (!(error instanceof JsonRevisionConflictError) || attempt === 3) throw error;
      }
    }
  }

  private async requirePrimary() {
    const loaded = await this.unit.load();
    // A backup can predate an acknowledged side effect and must not authorize replay.
    if (loaded.source === 'backup') throw new ConversationCompletionJournalDataError();
    return loaded;
  }
}

export function parseCompletionIntent(value: unknown, projectId: ProjectId): ConversationCompletionIntent {
  const item = exact(value, ['schemaVersion', 'revision', 'responseExecutionId', 'expectedRunRevision',
    'targetRun', 'decision', 'responseState', 'taskRevisions', 'stage', 'freezeOrigin', 'failureStage', 'createdAt', 'updatedAt'],
    ['freezeOrigin', 'failureStage']);
  if (item.schemaVersion !== 1 || !integer(item.revision) || !integer(item.expectedRunRevision)) throw invalid();
  const responseExecutionId = toConversationResponseExecutionId(String(item.responseExecutionId));
  const targetRun = parseConversationAgentRun(item.targetRun);
  if (targetRun.projectId !== projectId || targetRun.responseExecutionId !== responseExecutionId ||
    ![Number(item.expectedRunRevision), Number(item.expectedRunRevision) + 1].includes(targetRun.revision)) throw invalid();
  const decision = exact(item.decision, ['status', 'reconciliationReason', 'reason', 'registeredWorkIds',
    'executionOwner', 'canReplay', 'responseCompleted', 'documentCompleted'], ['reconciliationReason']);
  if (!agentRunStatuses.includes(decision.status as never) || decision.status !== targetRun.status ||
    !Array.isArray(decision.registeredWorkIds) || decision.registeredWorkIds.length > 128 ||
    decision.registeredWorkIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id)) ||
    !conversationExecutionCompletionReasons.includes(decision.reason as never) ||
    (decision.reconciliationReason !== undefined && !agentRunReconciliationReasons.includes(decision.reconciliationReason as never)) ||
    !['response', 'document_task', 'none'].includes(String(decision.executionOwner)) || decision.canReplay !== false ||
    ['responseCompleted', 'documentCompleted'].some(key => typeof decision[key] !== 'boolean')) throw invalid();
  if (!['pending', 'streaming', 'completed', 'failed', 'cancelled', 'interrupted'].includes(String(item.responseState)) ||
    !['prepared', 'run_applied', 'applied', 'needs_reconciliation', 'acknowledged'].includes(String(item.stage)) ||
    !Array.isArray(item.taskRevisions) || item.taskRevisions.length > 128) throw invalid();
  if (item.stage === 'acknowledged' && targetRun.reconciliationAcknowledgement?.kind !== 'closed_without_replay' ||
    new Set(decision.registeredWorkIds as readonly string[]).size !== decision.registeredWorkIds.length) throw invalid();
  if ((item.freezeOrigin === undefined) !== (item.failureStage === undefined) ||
    item.freezeOrigin !== undefined && !['local_projection', 'unknown_result'].includes(String(item.freezeOrigin)) ||
    item.failureStage !== undefined && !['facts', 'wal_prepare', 'evidence', 'projection', 'run_commit', 'wal_commit'].includes(String(item.failureStage)) ||
    item.freezeOrigin === 'local_projection' && (!['completed', 'failed', 'cancelled'].includes(targetRun.status) ||
      !['projection', 'run_commit', 'wal_commit'].includes(String(item.failureStage)))) throw invalid();
  const taskRevisions = item.taskRevisions.map(value => {
    const task = exact(value, ['id', 'revision']);
    if (typeof task.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(task.id) || !integer(task.revision)) throw invalid();
    return { id: task.id, revision: Number(task.revision) };
  });
  if (new Set(taskRevisions.map(task => task.id)).size !== taskRevisions.length) throw invalid();
  const createdAt = toIsoTimestamp(String(item.createdAt));
  const updatedAt = toIsoTimestamp(String(item.updatedAt));
  if (updatedAt < createdAt || targetRun.updatedAt > updatedAt) throw invalid();
  return { ...item, responseExecutionId, targetRun, decision, taskRevisions, createdAt, updatedAt } as unknown as ConversationCompletionIntent;
}

function key(id: ConversationResponseExecutionId): string {
  return prefix + createHash('sha256').update(id).digest('hex');
}
function integer(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0; }
function invalid(): ConversationCompletionJournalDataError { return new ConversationCompletionJournalDataError(); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !keys.includes(key)) || keys.some(key => !(key in item) && !optional.includes(key))) throw invalid();
  return item;
}
