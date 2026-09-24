import { AsyncLocalStorage } from 'node:async_hooks';
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
}
interface TraceDocument {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly sequence: number;
  readonly events: readonly ProductionTraceEventDto[];
  readonly issues?: readonly ProductionTraceIssueDto[];
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
    return { schemaVersion: 1, projectId: this.projectId, sequence: record.sequence, events, issues };
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
  append(scope: ProductionTraceScope, input: { readonly code: ProductionEventCode; readonly status: ProductionEventStatus;
    readonly operationId?: string; readonly facts?: ProductionEventFacts }): Promise<ProductionTraceEventDto> {
    return this.serialize(async () => {
      let written: ProductionTraceEventDto | undefined;
      const truncations = new Map<string, ProductionTraceIssueDto>();
      await this.storage.mutateJsonAtomically(tracePath, (raw) => {
        const document = this.parse(raw);
        written = parseProductionTraceEvent({ schemaVersion: 1, projectId: scope.projectId, conversationId: scope.conversationId,
          sourceMessageId: scope.sourceMessageId, traceId: scope.traceId,
          ...(scope.assistantMessageId ? { assistantMessageId: scope.assistantMessageId } : {}),
          ...(scope.clientCommandId ? { clientCommandId: scope.clientCommandId } : {}),
          sequence: document.sequence + 1, ...input, occurredAt: new Date().toISOString() });
        if (written.projectId !== this.projectId) throw new Error('Production trace project mismatch');
        const sameTrace = document.events.filter((item) => item.traceId === scope.traceId);
        if (sameTrace.some((item) => item.conversationId !== scope.conversationId || item.sourceMessageId !== scope.sourceMessageId)) {
          throw new Error('Production trace identity mismatch');
        }
        const oldestRetained = sameTrace.length >= 2048 ? sameTrace[sameTrace.length - 2047].sequence : 0;
        const retained = [...document.events.filter((item) => item.traceId !== scope.traceId || item.sequence >= oldestRetained), written].slice(-32768);
        const retainedSequences = new Set(retained.map((item) => item.sequence));
        for (const item of document.events) if (!retainedSequences.has(item.sequence)) {
          truncations.set(item.traceId, issueForScope(item, 'history_truncated'));
        }
        const recordedIssues = new Map((document.issues ?? []).map((item) => [`${item.traceId}:${item.code}`, item]));
        for (const [key, item] of this.issues) recordedIssues.set(key, item);
        for (const item of truncations.values()) recordedIssues.set(`${item.traceId}:history_truncated`, item);
        return { schemaVersion: 1, projectId: this.projectId, sequence: written.sequence,
          events: retained,
          issues: [...recordedIssues.values()].slice(-1024) };
      });
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
/** Diagnostics must never turn a completed side effect into a failed business operation. */
export async function emitProductionEvent(input: { readonly code: ProductionEventCode; readonly status: ProductionEventStatus;
  readonly operationId?: string; readonly facts?: ProductionEventFacts }): Promise<{ readonly recorded: boolean }> {
  const scope = traceContext.getStore();
  if (!scope) return { recorded: false };
  let store: ConversationProductionTraceStore | undefined;
  try { store = getProductionTraceStore(scope); await store.append(scope, input); return { recorded: true }; }
  catch { store?.reportIssue(scope, 'recording_unavailable'); return { recorded: false }; }
}
