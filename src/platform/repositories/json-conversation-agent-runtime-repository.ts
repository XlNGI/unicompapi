import {
  assertConversationAgentRuntimeUpdate, parseConversationAgentRuntime, parseConversationAgentRuntimeEvent,
  parseConversationAgentRuntimeSnapshot,
  type ConversationAgentRunId, type ConversationResponseExecutionId, type ProjectId,
  type ConversationAgentRuntimeRepository, type ConversationAgentRuntimeV1,
  type ConversationAgentRuntimeEventV1, type ConversationAgentRuntimeSnapshotV1,
  type ConversationAgentRuntimeOutboxEntryV1
} from '../../domain';
import { ProjectMetadataUnitOfWork } from '../storage/project-metadata-unit-of-work';
import { JsonRevisionConflictError, type JsonValue } from '../storage/json-document';
import type { ProjectStorageAdapter } from '../storage/storage-adapter';

const metadataKey = 'conversation-agent-runtimes-v1';
interface RuntimeCollectionV1 {
  readonly schemaVersion: 1;
  readonly projectId: ProjectId;
  readonly snapshots: readonly ConversationAgentRuntimeSnapshotV1[];
}

export class ConversationAgentRuntimeRevisionConflictError extends Error {
  constructor(readonly runId: ConversationAgentRunId, readonly expectedRevision: number | null, readonly actualRevision: number | null) {
    super('conversation_agent_runtime_revision_conflict');
    this.name = 'ConversationAgentRuntimeRevisionConflictError';
  }
}
export class ConversationAgentRuntimeStorageReconciliationError extends Error {
  constructor() { super('conversation_agent_runtime_storage_reconciliation_required'); this.name = 'ConversationAgentRuntimeStorageReconciliationError'; }
}

/** One metadata CAS commits runtime, checkpoint, event and public outbox together. */
export class JsonConversationAgentRuntimeRepository implements ConversationAgentRuntimeRepository {
  private readonly unit: ProjectMetadataUnitOfWork;
  private cachedCollection?: { readonly signature: string; readonly collection: RuntimeCollectionV1 };
  constructor(storage: ProjectStorageAdapter, readonly projectId: ProjectId, now: () => string = () => new Date().toISOString()) {
    this.unit = new ProjectMetadataUnitOfWork(storage, now);
  }
  async get(runId: ConversationAgentRunId): Promise<ConversationAgentRuntimeSnapshotV1 | undefined> {
    return structuredClone((await this.loadAuthoritative()).collection.snapshots.find(item => item.runtime.runId === runId));
  }
  async list(): Promise<readonly ConversationAgentRuntimeSnapshotV1[]> {
    return structuredClone((await this.loadAuthoritative()).collection.snapshots);
  }
  async findByResponseExecutionId(responseExecutionId: ConversationResponseExecutionId): Promise<ConversationAgentRuntimeSnapshotV1 | undefined> {
    return structuredClone((await this.loadAuthoritative()).collection.snapshots.find(item => item.runtime.responseExecutionId === responseExecutionId));
  }
  /** A backup is read-only evidence: it can never authorize a new HTTP request or write. */
  async inspect(runId: ConversationAgentRunId): Promise<{ readonly snapshot?: ConversationAgentRuntimeSnapshotV1; readonly source: 'primary' | 'backup' | 'default'; readonly readOnly: boolean }> {
    const loaded = await this.unit.load();
    const collection = this.parseCollection(loaded.document.entries.find(entry => entry.key === metadataKey)?.value);
    return { snapshot: structuredClone(collection.snapshots.find(item => item.runtime.runId === runId)), source: loaded.source, readOnly: loaded.source === 'backup' };
  }
  async create(runtime: ConversationAgentRuntimeV1, event: ConversationAgentRuntimeEventV1): Promise<ConversationAgentRuntimeSnapshotV1> {
    const initial = this.requireRuntime(runtime), created = parseConversationAgentRuntimeEvent(event);
    if (initial.revision !== 0 || initial.checkpoint.sequence !== 1 || initial.status !== 'running' || initial.modelCalls.length || initial.toolCalls.length || initial.registeredWorkIds.length || initial.budget.toolCallsUsed || initial.budget.costUnitsUsed || created.kind !== 'run_created' || created.sequence !== 1 || created.runId !== initial.runId || created.at !== initial.createdAt || initial.updatedAt !== initial.createdAt) throw new TypeError('Invalid initial canonical runtime');
    return this.mutate(collection => {
      const previous = collection.snapshots.find(snapshot => snapshot.runtime.runId === initial.runId);
      if (previous) {
        if (!sameEventFacts(previous.events[0], created) || !sameScopeAndPolicy(previous.runtime, initial)) throw new ConversationAgentRuntimeRevisionConflictError(initial.runId, null, previous.runtime.revision);
        return { collection, result: previous, changed: false };
      }
      if (collection.snapshots.some(snapshot => snapshot.runtime.responseExecutionId === initial.responseExecutionId)) throw new TypeError('A response execution already has a canonical owner');
      const snapshot = parseConversationAgentRuntimeSnapshot({ runtime: initial, events: [created], outbox: outboxFor(created) ? [outboxFor(created)] : [] });
      return { collection: { ...collection, snapshots: [...collection.snapshots, snapshot] }, result: snapshot, changed: true };
    });
  }
  async commit(input: { readonly runId: ConversationAgentRunId; readonly expectedRevision: number; readonly runtime: ConversationAgentRuntimeV1; readonly event: ConversationAgentRuntimeEventV1 }): Promise<ConversationAgentRuntimeSnapshotV1> {
    const next = this.requireRuntime(input.runtime), event = parseConversationAgentRuntimeEvent(input.event);
    if (input.runId !== next.runId || event.runId !== next.runId || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new TypeError('Canonical runtime commit scope is invalid');
    return this.mutate(collection => {
      const index = collection.snapshots.findIndex(snapshot => snapshot.runtime.runId === input.runId), previous = collection.snapshots[index];
      if (!previous) throw new ConversationAgentRuntimeRevisionConflictError(input.runId, input.expectedRevision, null);
      const replay = previous.events.find(item => item.eventKey === event.eventKey);
      if (replay) {
        if (!sameEventFacts(replay, event) || !sameScopeAndPolicy(previous.runtime, next)) throw new TypeError('Canonical event key was reused with different facts');
        return { collection, result: previous, changed: false };
      }
      if (previous.runtime.revision !== input.expectedRevision) throw new ConversationAgentRuntimeRevisionConflictError(input.runId, input.expectedRevision, previous.runtime.revision);
      assertConversationAgentRuntimeUpdate(previous.runtime, next);
      if (event.kind === 'run_created' || event.sequence !== next.checkpoint.sequence || event.at !== next.updatedAt || previous.events.some(item => item.eventId === event.eventId)) throw new TypeError('Canonical event does not match its checkpoint');
      const outbox = outboxFor(event);
      const snapshot = parseConversationAgentRuntimeSnapshot({ runtime: next, events: [...previous.events, event], outbox: [...previous.outbox, ...(outbox ? [outbox] : [])] });
      const snapshots = [...collection.snapshots]; snapshots[index] = snapshot;
      return { collection: { ...collection, snapshots }, result: snapshot, changed: true };
    });
  }
  async listPendingOutbox(runId?: ConversationAgentRunId): Promise<readonly ConversationAgentRuntimeOutboxEntryV1[]> {
    return (await this.list()).filter(snapshot => runId === undefined || snapshot.runtime.runId === runId).flatMap(snapshot => snapshot.outbox.filter(entry => !entry.projected));
  }
  async acknowledgeOutbox(runId: ConversationAgentRunId, eventId: string): Promise<void> {
    return this.acknowledgeOutboxMany(runId, [eventId]);
  }
  async acknowledgeOutboxMany(runId: ConversationAgentRunId, eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return;
    if (eventIds.length > 4096) throw new TypeError('Unbounded canonical acknowledgement');
    const ids = new Set(eventIds);
    await this.mutate(collection => {
      const index = collection.snapshots.findIndex(snapshot => snapshot.runtime.runId === runId), previous = collection.snapshots[index];
      const entries = previous?.outbox.filter(item => ids.has(item.eventId));
      if (!entries || entries.length !== ids.size) throw new TypeError('Cannot acknowledge an uncommitted canonical event');
      if (entries.every(entry => entry.projected)) return { collection, result: undefined, changed: false };
      const snapshot = { ...previous, outbox: previous.outbox.map(item => ids.has(item.eventId) ? { ...item, projected: true } : item) };
      const snapshots = [...collection.snapshots]; snapshots[index] = snapshot;
      return { collection: { ...collection, snapshots }, result: undefined, changed: true };
    });
  }
  private requireRuntime(runtime: ConversationAgentRuntimeV1): ConversationAgentRuntimeV1 {
    const parsed = parseConversationAgentRuntime(runtime);
    if (parsed.projectId !== this.projectId) throw new TypeError('Canonical runtime belongs to another project');
    return parsed;
  }
  private async loadAuthoritative() {
    const loaded = await this.unit.load();
    if (loaded.source === 'backup') throw new ConversationAgentRuntimeStorageReconciliationError();
    const value = loaded.document.entries.find(entry => entry.key === metadataKey)?.value;
    return { revision: loaded.document.revision, signature: JSON.stringify(value), collection: this.parseCollection(value) };
  }
  private async mutate<T>(operation: (collection: RuntimeCollectionV1) => { readonly collection: RuntimeCollectionV1; readonly result: T; readonly changed: boolean }): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const loaded = await this.loadAuthoritative();
      const prepared = operation(loaded.collection);
      if (!prepared.changed) return structuredClone(prepared.result);
      try {
        await this.unit.transact(loaded.revision, draft => {
          // Revision and payload must both agree. Other metadata entries remain in the UOW draft.
          if (JSON.stringify(draft.get(metadataKey)) !== loaded.signature) throw new ConversationAgentRuntimeStorageReconciliationError();
          draft.set(metadataKey, JSON.parse(JSON.stringify(prepared.collection)) as JsonValue);
        });
        this.cachedCollection = { signature: JSON.stringify(prepared.collection), collection: prepared.collection };
        return structuredClone(prepared.result);
      } catch (error) {
        if (!(error instanceof JsonRevisionConflictError)) throw error;
        if (attempt === 7) throw error;
      }
    }
    throw new TypeError('Canonical metadata CAS did not complete');
  }
  private parseCollection(value: unknown): RuntimeCollectionV1 {
    if (value === undefined) return { schemaVersion: 1, projectId: this.projectId, snapshots: [] };
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid canonical runtime collection');
    const signature = JSON.stringify(value);
    if (this.cachedCollection?.signature === signature) return this.cachedCollection.collection;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== 3 || item.schemaVersion !== 1 || item.projectId !== this.projectId || !Array.isArray(item.snapshots) || item.snapshots.length > 4096) throw new TypeError('Invalid canonical runtime collection');
    const snapshots = item.snapshots.map(parseConversationAgentRuntimeSnapshot);
    if (snapshots.some(snapshot => snapshot.runtime.projectId !== this.projectId) || new Set(snapshots.map(snapshot => snapshot.runtime.runId)).size !== snapshots.length || new Set(snapshots.map(snapshot => snapshot.runtime.responseExecutionId)).size !== snapshots.length || new Set(snapshots.flatMap(snapshot => snapshot.events.map(event => event.eventId))).size !== snapshots.reduce((total, snapshot) => total + snapshot.events.length, 0)) throw new TypeError('Duplicate or foreign canonical runtime owner');
    const collection = { schemaVersion: 1 as const, projectId: this.projectId, snapshots };
    this.cachedCollection = { signature, collection };
    return collection;
  }
}

function outboxFor(event: ConversationAgentRuntimeEventV1): ConversationAgentRuntimeOutboxEntryV1 | undefined {
  return event.publicEvent ? { eventId: event.eventId, eventKey: event.eventKey, runId: event.runId, sequence: event.sequence, at: event.at, payload: event.publicEvent, projected: false } : undefined;
}
function sameEventFacts(left: ConversationAgentRuntimeEventV1, right: ConversationAgentRuntimeEventV1): boolean {
  return JSON.stringify({ runId: left.runId, eventKey: left.eventKey, kind: left.kind, facts: left.facts, publicEvent: left.publicEvent }) === JSON.stringify({ runId: right.runId, eventKey: right.eventKey, kind: right.kind, facts: right.facts, publicEvent: right.publicEvent });
}
function sameScopeAndPolicy(left: ConversationAgentRuntimeV1, right: ConversationAgentRuntimeV1): boolean {
  return ['runId', 'projectId', 'conversationId', 'sourceMessageId', 'responseExecutionId', 'createdAt'].every(field => left[field as keyof ConversationAgentRuntimeV1] === right[field as keyof ConversationAgentRuntimeV1]) &&
    ['startedAt', 'deadlineAt', 'maxToolCalls', 'budgetUnits'].every(field => left.budget[field as keyof typeof left.budget] === right.budget[field as keyof typeof right.budget]);
}
