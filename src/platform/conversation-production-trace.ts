import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { NodeProjectStorage } from './storage/node-project-storage';
import { toProjectRelativePath } from './storage/project-paths';
import type { ProjectStorageAdapter } from './storage/storage-adapter';
import {
  parseProductionTraceEvent, productionTraceIdentifier,
  type ProductionTraceEventDto, type ProductionTraceIssueDto,
  type ProductionEventCode, type ProductionEventStatus, type ProductionEventFacts
} from '../shared/conversation-production-ipc';

export interface ProductionTraceScope {
  readonly rootDirectory: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly sourceMessageId: string;
  readonly traceId: string;
  assistantMessageId?: string;
  readonly clientCommandId?: string;
  /** Host-only bridge. Provider plans and renderer requests cannot set this scope. */
  canonicalEvents?: CanonicalProductionTraceEvents;
}
export interface ProductionEventInput {
  readonly code: ProductionEventCode;
  readonly status: ProductionEventStatus;
  readonly operationId?: string;
  readonly facts?: ProductionEventFacts;
}
export interface CanonicalProductionTraceEvent {
  readonly runId: string;
  readonly runEventId: string;
  readonly runSequence: number;
  readonly occurredAt: string;
  readonly publicEvent: ProductionEventInput & { readonly assistantMessageId?: string; readonly traceId?: string; readonly clientCommandId?: string };
}
export interface CanonicalProductionTraceEvents {
  record(input: CanonicalProductionTraceEvent['publicEvent'] & { readonly occurredAt: string }): Promise<CanonicalProductionTraceEvent>;
  markProjected(runEventId: string): Promise<void>;
  replayPending?(): Promise<readonly CanonicalProductionTraceEvent[]>;
}
interface CanonicalProjectionEntry {
  readonly runId: string;
  readonly runEventId: string;
  readonly runSequence: number;
  readonly sequence: number;
  readonly digest: string;
}
interface TraceDocument {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly sequence: number;
  readonly events: readonly ProductionTraceEventDto[];
  readonly issues?: readonly ProductionTraceIssueDto[];
  /** Retained independently from bounded display history so an unacknowledged replay cannot create a new row. */
  readonly canonicalProjections?: readonly CanonicalProjectionEntry[];
}
export interface ProductionTraceFilter { readonly conversationId?: string; readonly clientCommandId?: string; readonly afterSequence?: number }
const tracePath = toProjectRelativePath('entities/conversation-production-trace.json');
const traceContext = new AsyncLocalStorage<ProductionTraceScope>();
const stores = new Map<string, ConversationProductionTraceStore>();

export function getProductionTraceScope(): ProductionTraceScope | undefined { return traceContext.getStore(); }
export function withProductionTrace<T>(scope: ProductionTraceScope, operation: () => Promise<T>): Promise<T> {
  return traceContext.run({ ...scope }, operation);
}
export function bindProductionTraceAssistant(assistantMessageId: string): void {
  const scope = traceContext.getStore();
  if (scope) scope.assistantMessageId = productionTraceIdentifier(assistantMessageId);
}

export function bindProductionTraceCanonicalEvents(bridge: CanonicalProductionTraceEvents): void {
  const scope = traceContext.getStore();
  if (!scope || !bridge || typeof bridge.record !== 'function' || typeof bridge.markProjected !== 'function' ||
    (bridge.replayPending !== undefined && typeof bridge.replayPending !== 'function')) throw new Error('Invalid canonical production bridge');
  if (scope.canonicalEvents && scope.canonicalEvents !== bridge) throw new Error('Canonical production bridge already bound');
  scope.canonicalEvents = bridge;
}

/** Durable log and atomic replay/live handoff, independent from the text response lifecycle. */
export class ConversationProductionTraceStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly issues = new Map<string, ProductionTraceIssueDto>();
  private readonly subscribers = new Set<{
    filter: ProductionTraceFilter; event: (event: ProductionTraceEventDto) => void;
    issue?: (issue: ProductionTraceIssueDto) => void;
  }>();
  constructor(private readonly storage: ProjectStorageAdapter, readonly projectId: string) {}
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(work, work);
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  private parse(value: unknown): TraceDocument {
    if (value === undefined) return { schemaVersion: 1, projectId: this.projectId, sequence: 0, events: [] };
    const record = value as TraceDocument;
    if (!record || record.schemaVersion !== 1 || record.projectId !== this.projectId ||
      !Number.isSafeInteger(record.sequence) || record.sequence < 0 || !Array.isArray(record.events) || record.events.length > 32768) throw new Error('Invalid production trace store');
    const events = record.events.map(parseProductionTraceEvent);
    let previous = 0;
    for (const event of events) {
      if (event.projectId !== this.projectId || event.sequence <= previous || event.sequence > record.sequence) throw new Error('Invalid production trace sequence');
      previous = event.sequence;
    }
    const issues = (record.issues ?? []).map((issue) => {
      if (!issue || !['history_truncated', 'recording_unavailable'].includes(issue.code) || issue.projectId !== this.projectId) throw new Error('Invalid production trace issue');
      return { projectId: this.projectId, conversationId: productionTraceIdentifier(issue.conversationId),
        sourceMessageId: productionTraceIdentifier(issue.sourceMessageId), traceId: productionTraceIdentifier(issue.traceId),
        ...(issue.clientCommandId ? { clientCommandId: productionTraceIdentifier(issue.clientCommandId) } : {}), code: issue.code };
    });
    if (issues.length > 1024) throw new Error('Invalid production trace issues');
    const canonicalProjections = record.canonicalProjections ?? [];
    if (!Array.isArray(canonicalProjections) || canonicalProjections.length > 65536) throw new Error('Invalid canonical projection index');
    const canonicalKeys = new Set<string>();
    const canonicalSequences = new Set<string>();
    for (const entry of canonicalProjections) {
      if (!entry || Object.keys(entry).some((key) => !['runId', 'runEventId', 'runSequence', 'sequence', 'digest'].includes(key)) ||
        !Number.isSafeInteger(entry.runSequence) || entry.runSequence < 1 || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 ||
        entry.sequence > record.sequence || !/^sha256:[a-f0-9]{64}$/u.test(entry.digest)) throw new Error('Invalid canonical projection index');
      const key = JSON.stringify([productionTraceIdentifier(entry.runId), productionTraceIdentifier(entry.runEventId)]);
      const sequenceKey = JSON.stringify([entry.runId, entry.runSequence]);
      if (canonicalKeys.has(key) || canonicalSequences.has(sequenceKey)) throw new Error('Duplicate canonical projection identity');
      canonicalKeys.add(key); canonicalSequences.add(sequenceKey);
    }
    return { schemaVersion: 1, projectId: this.projectId, sequence: record.sequence, events, issues, canonicalProjections };
  }
  list(filter: ProductionTraceFilter): Promise<readonly ProductionTraceEventDto[]> {
    return this.serialize(async () => this.parse(await this.storage.readJson(tracePath)).events.filter((event) => matches(filter, event)));
  }
  subscribe(filter: ProductionTraceFilter, event: (event: ProductionTraceEventDto) => void,
    issue?: (issue: ProductionTraceIssueDto) => void): Promise<() => void> {
    return this.serialize(async () => {
      const document = this.parse(await this.storage.readJson(tracePath));
      const subscriber = { filter, event, issue };
      this.subscribers.add(subscriber);
      try {
        for (const item of document.events) if (matches(filter, item)) event(item);
        const recordedIssues = new Map((document.issues ?? []).map((item) => [`${item.traceId}:${item.code}`, item]));
        for (const [key, item] of this.issues) recordedIssues.set(key, item);
        for (const item of recordedIssues.values()) if (matches(filter, { ...item, sequence: Number.MAX_SAFE_INTEGER })) issue?.(item);
      } catch { this.subscribers.delete(subscriber); }
      return () => { this.subscribers.delete(subscriber); };
    });
  }
  append(scope: ProductionTraceScope, input: ProductionEventInput): Promise<ProductionTraceEventDto> {
    return this.appendRecord(scope, input).then((event) => event!);
  }
  appendCanonical(scope: ProductionTraceScope, canonical: CanonicalProductionTraceEvent): Promise<ProductionTraceEventDto | undefined> {
    return this.appendRecord(scope, canonical.publicEvent, canonical);
  }
  private appendRecord(scope: ProductionTraceScope, input: ProductionEventInput,
    canonical?: CanonicalProductionTraceEvent): Promise<ProductionTraceEventDto | undefined> {
    return this.serialize(async () => {
      const publicKeys = ['code', 'status', 'operationId', 'facts', ...(canonical ? ['assistantMessageId', 'traceId', 'clientCommandId'] : [])];
      if (Object.keys(input).some((key) => !publicKeys.includes(key)) || (canonical &&
        Object.keys(canonical).some((key) => !['runId', 'runEventId', 'runSequence', 'occurredAt', 'publicEvent'].includes(key)))) {
        throw new Error('Invalid canonical production payload');
      }
      let written: ProductionTraceEventDto | undefined;
      let duplicated = false;
      const truncations = new Map<string, ProductionTraceIssueDto>();
      await this.storage.mutateJsonAtomically(tracePath, (raw) => {
        const document = this.parse(raw);
        // A replay uses the original Host envelope, including an absent command/assistant.
        // The startup scope supplies storage and ownership, not a new public identity.
        const traceId = canonical?.publicEvent.traceId ?? scope.traceId;
        const clientCommandId = canonical?.publicEvent.traceId !== undefined
          ? canonical.publicEvent.clientCommandId : scope.clientCommandId;
        written = parseProductionTraceEvent({ schemaVersion: 1, projectId: scope.projectId, conversationId: scope.conversationId,
          sourceMessageId: scope.sourceMessageId, traceId,
          ...((canonical ? canonical.publicEvent.assistantMessageId : scope.assistantMessageId)
            ? { assistantMessageId: canonical ? canonical.publicEvent.assistantMessageId : scope.assistantMessageId } : {}),
          ...(clientCommandId ? { clientCommandId } : {}),
          sequence: document.sequence + 1, code: input.code, status: input.status,
          ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
          ...(input.facts !== undefined ? { facts: input.facts } : {}),
          ...(canonical ? { runId: canonical.runId, runEventId: canonical.runEventId, runSequence: canonical.runSequence } : {}),
          occurredAt: canonical?.occurredAt ?? new Date().toISOString() });
        if (written.projectId !== this.projectId) throw new Error('Production trace project mismatch');
        const canonicalProjections = [...(document.canonicalProjections ?? [])];
        if (canonical) {
          const digest = projectionDigest(written);
          const existing = canonicalProjections.find((entry) => entry.runId === canonical.runId && entry.runEventId === canonical.runEventId);
          if (existing) {
            if (existing.runSequence !== canonical.runSequence || existing.digest !== digest) throw new Error('Canonical projection identity conflict');
            written = document.events.find((event) => event.sequence === existing.sequence);
            duplicated = true;
            return document;
          }
          if (canonicalProjections.some((entry) => entry.runId === canonical.runId && entry.runSequence === canonical.runSequence)) {
            throw new Error('Canonical projection sequence conflict');
          }
          if (canonicalProjections.length >= 65536) throw new Error('Canonical projection index exhausted');
          canonicalProjections.push({ runId: canonical.runId, runEventId: canonical.runEventId, runSequence: canonical.runSequence,
            sequence: written.sequence, digest });
        }
        const sameTrace = document.events.filter((item) => item.traceId === traceId);
        if (sameTrace.some((item) => item.conversationId !== scope.conversationId || item.sourceMessageId !== scope.sourceMessageId)) {
          throw new Error('Production trace identity mismatch');
        }
        const oldestRetained = sameTrace.length >= 2048 ? sameTrace[sameTrace.length - 2047].sequence : 0;
        const retained = [...document.events.filter((item) => item.traceId !== traceId || item.sequence >= oldestRetained), written].slice(-32768);
        const retainedSequences = new Set(retained.map((item) => item.sequence));
        for (const item of document.events) if (!retainedSequences.has(item.sequence)) {
          truncations.set(item.traceId, issueForScope(item, 'history_truncated'));
        }
        const recordedIssues = new Map((document.issues ?? []).map((item) => [`${item.traceId}:${item.code}`, item]));
        for (const [key, item] of this.issues) recordedIssues.set(key, item);
        for (const item of truncations.values()) recordedIssues.set(`${item.traceId}:history_truncated`, item);
        return { schemaVersion: 1, projectId: this.projectId, sequence: written.sequence,
          events: retained,
          ...(canonicalProjections.length ? { canonicalProjections } : {}),
          issues: [...recordedIssues.values()].slice(-1024) };
      });
      if (duplicated) return written;
      const event = written!;
      for (const subscriber of this.subscribers) if (matches(subscriber.filter, event)) {
        try { subscriber.event(event); } catch { this.subscribers.delete(subscriber); }
      }
      for (const issue of truncations.values()) this.reportIssue(issue, 'history_truncated');
      return event;
    });
  }
  reportIssue(scope: Pick<ProductionTraceScope, 'projectId' | 'conversationId' | 'sourceMessageId' | 'traceId' | 'clientCommandId'>, code: ProductionTraceIssueDto['code']): void {
    const issue = issueForScope(scope, code);
    this.issues.set(`${scope.traceId}:${code}`, issue);
    if (this.issues.size > 1024) this.issues.delete(this.issues.keys().next().value!);
    for (const subscriber of this.subscribers) if (matches(subscriber.filter, { ...issue, sequence: Number.MAX_SAFE_INTEGER })) {
      try { subscriber.issue?.(issue); } catch { this.subscribers.delete(subscriber); }
    }
  }
}

function projectionDigest(event: ProductionTraceEventDto): string {
  const payload = { ...event, sequence: 0, ...(event.facts ? { facts: Object.fromEntries(Object.entries(event.facts).sort(([left], [right]) => left.localeCompare(right))) } : {}) };
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function issueForScope(scope: Pick<ProductionTraceScope, 'projectId' | 'conversationId' | 'sourceMessageId' | 'traceId' | 'clientCommandId'>, code: ProductionTraceIssueDto['code']): ProductionTraceIssueDto {
  return { projectId: scope.projectId, conversationId: scope.conversationId, sourceMessageId: scope.sourceMessageId,
    traceId: scope.traceId, ...(scope.clientCommandId ? { clientCommandId: scope.clientCommandId } : {}), code };
}

function matches(filter: ProductionTraceFilter, event: { conversationId: string; clientCommandId?: string; sequence: number }): boolean {
  return (!filter.conversationId || filter.conversationId === event.conversationId) &&
    (!filter.clientCommandId || filter.clientCommandId === event.clientCommandId) && event.sequence > (filter.afterSequence ?? 0);
}
export function getProductionTraceStore(scope: Pick<ProductionTraceScope, 'rootDirectory' | 'projectId'>): ConversationProductionTraceStore {
  const key = `${path.resolve(scope.rootDirectory)}\0${scope.projectId}`;
  let store = stores.get(key);
  if (!store) { store = new ConversationProductionTraceStore(new NodeProjectStorage(scope.rootDirectory), scope.projectId); stores.set(key, store); }
  return store;
}
/** Canonical intent persistence is required before dispatch; projection can be retried separately. */
export async function emitProductionEvent(input: { readonly code: ProductionEventCode; readonly status: ProductionEventStatus;
  readonly operationId?: string; readonly facts?: ProductionEventFacts }): Promise<{ readonly recorded: boolean }> {
  const scope = traceContext.getStore();
  if (!scope) return { recorded: false };
  if (scope.canonicalEvents) {
    // Canonical intent persistence is an execution prerequisite; its failure must stop dispatch.
    if (Object.keys(input).some(key => !['code', 'status', 'operationId', 'facts'].includes(key))) {
      throw new Error('Invalid canonical production payload');
    }
    const safe = parseProductionTraceEvent({ schemaVersion: 1, projectId: scope.projectId, conversationId: scope.conversationId,
      sourceMessageId: scope.sourceMessageId, traceId: scope.traceId, sequence: 1, ...input, occurredAt: new Date().toISOString() });
    const entry = await scope.canonicalEvents.record({ code: safe.code, status: safe.status,
      traceId: productionTraceIdentifier(scope.traceId),
      ...(scope.clientCommandId ? { clientCommandId: productionTraceIdentifier(scope.clientCommandId) } : {}),
      ...(safe.operationId ? { operationId: safe.operationId } : {}), ...(safe.facts ? { facts: safe.facts } : {}),
      ...(scope.assistantMessageId ? { assistantMessageId: productionTraceIdentifier(scope.assistantMessageId) } : {}), occurredAt: safe.occurredAt });
    try {
      await projectCanonicalProductionEvent(scope, entry, scope.canonicalEvents);
      return { recorded: true };
    } catch {
      // A committed intent stays in the outbox. Retrying projection must never retry its side effect.
      getProductionTraceStore(scope).reportIssue(scope, 'recording_unavailable');
      return { recorded: false };
    }
  }
  let store: ConversationProductionTraceStore | undefined;
  try {
    store = getProductionTraceStore(scope);
    await store.append(scope, input);
    return { recorded: true };
  }
  catch { store?.reportIssue(scope, 'recording_unavailable'); return { recorded: false }; }
}

/** Supplemental probes never authorize execution and must observe their own persistence failures. */
export async function emitProductionDiagnostic(input: ProductionEventInput): Promise<{ readonly recorded: boolean }> {
  try { return await emitProductionEvent(input); }
  catch {
    const scope = traceContext.getStore();
    if (scope) {
      try { getProductionTraceStore(scope).reportIssue(scope, 'recording_unavailable'); }
      catch { /* Reporting a diagnostic failure cannot create an unhandled rejection. */ }
    }
    return { recorded: false };
  }
}

/** Projection and acknowledgment are replayable; neither operation dispatches a model or a tool. */
export async function projectCanonicalProductionEvent(scope: ProductionTraceScope, entry: CanonicalProductionTraceEvent,
  bridge: Pick<CanonicalProductionTraceEvents, 'markProjected'> = scope.canonicalEvents!): Promise<void> {
  if (!bridge) throw new Error('Canonical production bridge missing');
  await getProductionTraceStore(scope).appendCanonical(scope, entry);
  await bridge.markProjected(entry.runEventId);
}

export async function replayCanonicalProductionEvents(scope: ProductionTraceScope,
  bridge: CanonicalProductionTraceEvents = scope.canonicalEvents!): Promise<{ readonly projected: number; readonly pending: number }> {
  if (!bridge?.replayPending) return { projected: 0, pending: 0 };
  const pending = [...await bridge.replayPending()].sort((left, right) => left.runSequence - right.runSequence);
  let projected = 0;
  for (const entry of pending) {
    try { await projectCanonicalProductionEvent(scope, entry, bridge); projected++; }
    catch { getProductionTraceStore(scope).reportIssue(scope, 'recording_unavailable'); break; }
  }
  return { projected, pending: pending.length - projected };
}
