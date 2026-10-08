import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Conversation, ConversationAgentRunId, ConversationId, ConversationResponseExecutionId, IsoTimestamp, MessageId, ThreadId } from '../../domain';
import { appendDisplayItems, conversationToThreadProjection, projectArtifactItem } from '../../application/conversation-thread-adapter';
import type { ConversationExecutionLinkInput } from '../../application/conversation-thread-adapter';
import { sha256Hex, toIsoTimestamp, toWorkId } from '../../domain';
import type { ThreadFileRepository } from './thread-file-repository';

export interface LegacyExecutionReference {
  readonly conversationId: ConversationId;
  readonly sourceMessageId: MessageId;
  readonly agentRunId?: ConversationAgentRunId;
  readonly responseExecutionId?: ConversationResponseExecutionId;
  readonly workIds?: readonly string[];
}

export interface LegacyConversationSnapshot {
  readonly conversation: Conversation;
  readonly executionReferences?: readonly LegacyExecutionReference[];
}

export interface MigrationLedgerEntry {
  readonly conversationId: ConversationId;
  readonly threadId: ThreadId;
  readonly sourceChecksum: string;
  readonly status: 'pending' | 'migrated' | 'failed';
  readonly itemCount: number;
  readonly turnCount: number;
  readonly preservedAgentRunIds: readonly string[];
  readonly preservedResponseExecutionIds: readonly string[];
  readonly preservedWorkIds: readonly string[];
  readonly updatedAt: IsoTimestamp;
  readonly error?: string;
}

export interface MigrationLedgerV1 {
  readonly schemaVersion: 1;
  readonly migrationId: string;
  readonly sourceLabel: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly entries: readonly MigrationLedgerEntry[];
}

export interface LegacyScanReport {
  readonly sourceLabel: string;
  readonly conversationCount: number;
  readonly messageCount: number;
  readonly sourceChecksum: string;
  readonly errors: readonly string[];
}

export interface MigrationRunReport {
  readonly migrationId: string;
  readonly status: 'completed' | 'partial' | 'failed';
  readonly migrated: number;
  readonly skipped: number;
  readonly failed: number;
  readonly ledger: MigrationLedgerV1;
  readonly scan: LegacyScanReport;
}

export interface ShadowDifference {
  readonly conversationId: ConversationId;
  readonly kind: 'missing_thread' | 'summary_mismatch' | 'item_count_mismatch' | 'content_hash_mismatch' | 'duplicate_thread' | 'execution_reference_mismatch' | 'model_context_mismatch';
  readonly detail: string;
}

export interface ShadowComparisonReport {
  readonly sourceLabel: string;
  readonly checkedConversations: number;
  readonly differences: readonly ShadowDifference[];
  readonly sourceSummaryHash: string;
  readonly targetSummaryHash: string;
  readonly modelContextCompared: boolean;
}

export interface CutoverReadinessInput {
  readonly legacyGeneration: number;
  readonly targetGeneration: number;
  readonly activeExecutionCount: number;
  readonly backupVerified: boolean;
  readonly shadow: ShadowComparisonReport;
  readonly ledger: MigrationLedgerV1;
}

export interface CutoverReadinessReport {
  readonly status: 'ready_for_separate_approval' | 'blocked';
  readonly reasons: readonly string[];
  readonly legacyGeneration: number;
  readonly targetGeneration: number;
  readonly activeExecutionCount: number;
  readonly backupVerified: boolean;
  readonly oldAuthorityPreserved: true;
  readonly onlineDualWriteSupported: false;
}

interface AuthorityFenceV1 {
  readonly schemaVersion: 1;
  readonly state: 'legacy_authoritative' | 'prepared' | 'new_authoritative' | 'rollback_locked';
  readonly generation: number;
  readonly legacyGeneration: number;
  readonly targetGeneration: number;
  readonly preparedAt: IsoTimestamp;
  readonly backupVerified: boolean;
}

export class LegacyThreadMigration {
  private readonly ledgerPath: string;
  private readonly fencePath: string;
  private readonly now: () => IsoTimestamp;

  constructor(
    private readonly targetRoot: string,
    private readonly target: ThreadFileRepository,
    private readonly options: { readonly sourceLabel?: string; readonly now?: () => IsoTimestamp; readonly migrationId?: string } = {}
  ) {
    this.ledgerPath = path.join(targetRoot, 'migration', 'migration-ledger.v1.json');
    this.fencePath = path.join(targetRoot, 'migration', 'authority-fence.v1.json');
    this.now = options.now ?? (() => new Date().toISOString() as IsoTimestamp);
  }

  async scan(source: readonly LegacyConversationSnapshot[]): Promise<LegacyScanReport> {
    const errors: string[] = [];
    const conversationIds = new Set<string>();
    let messageCount = 0;
    for (const entry of source) {
      const conversation = entry.conversation;
      if (conversationIds.has(String(conversation.id))) errors.push(`duplicate_conversation:${conversation.id}`);
      conversationIds.add(String(conversation.id));
      const messageIds = new Set<string>();
      for (const message of conversation.messages) {
        messageCount += 1;
        if (messageIds.has(String(message.id))) errors.push(`duplicate_message:${conversation.id}:${message.id}`);
        messageIds.add(String(message.id));
        if (message.conversationId !== conversation.id) errors.push(`message_scope:${message.id}`);
      }
    }
    return { sourceLabel: this.options.sourceLabel ?? 'isolated-legacy-copy', conversationCount: source.length, messageCount, sourceChecksum: sha256Hex(canonicalJson(source)), errors };
  }

  async migrate(source: readonly LegacyConversationSnapshot[]): Promise<MigrationRunReport> {
    await mkdir(path.dirname(this.ledgerPath), { recursive: true });
    const scan = await this.scan(source);
    if (scan.errors.length > 0) throw new Error(`legacy_scan_invalid:${scan.errors.join(',')}`);
    const ledger = await this.loadLedger(scan.sourceLabel);
    const entries = [...ledger.entries];
    let migrated = 0, skipped = 0, failed = 0;
    for (const snapshot of source) {
      const conversation = snapshot.conversation;
      const sourceChecksum = sha256Hex(canonicalJson(snapshot));
      const existing = entries.find(entry => entry.conversationId === conversation.id);
      if (existing?.status === 'migrated' && existing.sourceChecksum === sourceChecksum) { skipped += 1; continue; }
      try {
        const baseProjection = conversationToThreadProjection(conversation, {
          executionLinks: toExecutionLinks(snapshot.executionReferences ?? [], conversation.id)
        });
        let artifactOrdinal = 0;
        const projection = appendDisplayItems(baseProjection, conversation.messages.flatMap(message => {
          const artifact = message.documentResult ?? message.retainedDocumentResult;
          if (!artifact) return [];
          const turn = baseProjection.turns.find(candidate => candidate.userItemId?.value === message.id || candidate.assistantItemIds.some(item => item.value === message.id));
          artifactOrdinal += 1;
          return [projectArtifactItem({ threadId: baseProjection.thread.threadId, ...(turn ? { turnId: turn.turnId } : {}), sequence: baseProjection.items.length + artifactOrdinal, status: message.state, content: artifact.fileName, createdAt: message.createdAt, updatedAt: message.updatedAt, sourceIdentity: `legacy-artifact:${message.id}:${artifact.workId}`, responseExecutionId: snapshot.executionReferences?.find(reference => reference.sourceMessageId === message.id)?.responseExecutionId, workId: toWorkId(artifact.workId) })];
        }));
        if (!(await this.target.getThread(projection.thread.threadId))) {
          await this.target.createThread({ threadId: projection.thread.threadId, projectId: projection.thread.projectId, title: projection.thread.title, createdAt: projection.thread.createdAt });
        }
        await this.target.append({ threadId: projection.thread.threadId, idempotencyKey: `legacy-migration:${conversation.id}:${sourceChecksum}`, occurredAt: conversation.updatedAt, thread: { status: projection.thread.status, generation: projection.thread.generation }, turns: projection.turns, items: projection.items, executionLinks: projection.executionLinks });
        const next: MigrationLedgerEntry = { conversationId: conversation.id, threadId: projection.thread.threadId, sourceChecksum, status: 'migrated', itemCount: projection.items.length, turnCount: projection.turns.length, preservedAgentRunIds: [...new Set((snapshot.executionReferences ?? []).flatMap(reference => reference.agentRunId ? [String(reference.agentRunId)] : []))], preservedResponseExecutionIds: [...new Set((snapshot.executionReferences ?? []).flatMap(reference => reference.responseExecutionId ? [String(reference.responseExecutionId)] : []))], preservedWorkIds: [...new Set((snapshot.executionReferences ?? []).flatMap(reference => reference.workIds ?? []))], updatedAt: this.now() };
        replaceLedgerEntry(entries, next);
        migrated += 1;
      } catch (error) {
        const next: MigrationLedgerEntry = { conversationId: conversation.id, threadId: conversation.id as unknown as ThreadId, sourceChecksum, status: 'failed', itemCount: conversation.messages.length, turnCount: conversation.messages.filter(message => message.role === 'user').length, preservedAgentRunIds: [], preservedResponseExecutionIds: [], preservedWorkIds: [], updatedAt: this.now(), error: error instanceof Error ? error.message : String(error) };
        replaceLedgerEntry(entries, next);
        failed += 1;
      }
      await this.saveLedger({ ...ledger, updatedAt: this.now(), entries });
    }
    const finalLedger = await this.loadLedger(scan.sourceLabel);
    return { migrationId: finalLedger.migrationId, status: failed ? (migrated ? 'partial' : 'failed') : 'completed', migrated, skipped, failed, ledger: finalLedger, scan };
  }

  async shadowCompare(source: readonly LegacyConversationSnapshot[]): Promise<ShadowComparisonReport> {
    const differences: ShadowDifference[] = [];
    const summaries = await this.target.listThreadSummaries();
    const summaryIds = new Set(summaries.map(summary => String(summary.threadId)));
    const duplicateIds = summaries.map(summary => String(summary.threadId)).filter((id, index, values) => values.indexOf(id) !== index);
    for (const duplicateId of duplicateIds) differences.push({ conversationId: duplicateId as unknown as ConversationId, kind: 'duplicate_thread', detail: `duplicate target thread ${duplicateId}` });
    for (const snapshot of source) {
      const conversation = snapshot.conversation;
      if (!summaryIds.has(String(conversation.id))) { differences.push({ conversationId: conversation.id, kind: 'missing_thread', detail: 'target summary missing' }); continue; }
      const thread = await this.target.getThread(conversation.id as unknown as ThreadId);
      const items = await this.target.readItems(conversation.id as unknown as ThreadId);
      const expected = conversationToThreadProjection(conversation);
      if (!thread || thread.title !== expected.thread.title || thread.status !== expected.thread.status || thread.itemCount !== expected.items.length || thread.turnCount !== expected.turns.length) differences.push({ conversationId: conversation.id, kind: 'summary_mismatch', detail: 'Thread metadata differs from legacy projection' });
      if (items.length !== expected.items.length) differences.push({ conversationId: conversation.id, kind: 'item_count_mismatch', detail: `${items.length} target items vs ${expected.items.length} legacy items` });
      const sourceContentHash = sha256Hex(canonicalJson(expected.items.map(item => [item.itemId, item.content, item.status])));
      const targetContentHash = sha256Hex(canonicalJson(items.map(item => [item.itemId, item.content, item.status])));
      if (sourceContentHash !== targetContentHash) differences.push({ conversationId: conversation.id, kind: 'content_hash_mismatch', detail: `${sourceContentHash} != ${targetContentHash}` });
      const expectedContextHash = sha256Hex(canonicalJson(conversation.messages.filter(message => message.state === 'completed' && !message.workflowReply).map(message => [message.role, message.content])));
      const targetContextHash = sha256Hex(canonicalJson(items.filter(item => item.messageSource && item.status === 'completed' && item.messageSource.messageId !== undefined).map(item => [item.type === 'user_message' ? 'user' : 'assistant', item.content])));
      if (expectedContextHash !== targetContextHash) differences.push({ conversationId: conversation.id, kind: 'model_context_mismatch', detail: `${expectedContextHash} != ${targetContextHash}` });
    }
    return { sourceLabel: this.options.sourceLabel ?? 'isolated-legacy-copy', checkedConversations: source.length, differences, sourceSummaryHash: sha256Hex(canonicalJson(source.map(snapshot => summaryFromConversation(snapshot.conversation)))), targetSummaryHash: sha256Hex(canonicalJson(summaries)), modelContextCompared: true };
  }

  async prepareCutover(input: CutoverReadinessInput): Promise<CutoverReadinessReport> {
    const reasons: string[] = [];
    if (input.shadow.differences.length) reasons.push(`shadow_differences:${input.shadow.differences.length}`);
    if (input.activeExecutionCount !== 0) reasons.push(`active_executions:${input.activeExecutionCount}`);
    if (!input.backupVerified) reasons.push('backup_not_verified');
    if (input.legacyGeneration !== input.targetGeneration) reasons.push('generation_lag');
    if (input.ledger.entries.some(entry => entry.status !== 'migrated')) reasons.push('ledger_incomplete');
    if (input.legacyGeneration < 0 || input.targetGeneration < 0) reasons.push('invalid_generation');
    const fence: AuthorityFenceV1 = { schemaVersion: 1, state: reasons.length ? 'legacy_authoritative' : 'prepared', generation: Math.max(input.legacyGeneration, input.targetGeneration), legacyGeneration: input.legacyGeneration, targetGeneration: input.targetGeneration, preparedAt: this.now(), backupVerified: input.backupVerified };
    await atomicWrite(this.fencePath, fence);
    return { status: reasons.length ? 'blocked' : 'ready_for_separate_approval', reasons, legacyGeneration: input.legacyGeneration, targetGeneration: input.targetGeneration, activeExecutionCount: input.activeExecutionCount, backupVerified: input.backupVerified, oldAuthorityPreserved: true, onlineDualWriteSupported: false };
  }

  async rollbackReadiness(input: { readonly cutoverStarted: boolean; readonly oldStoreCaughtUp: boolean; readonly newWritesAfterCutover: number }): Promise<{ readonly status: 'safe' | 'blocked'; readonly reasons: readonly string[] }> {
    const reasons: string[] = [];
    if (input.cutoverStarted && !input.oldStoreCaughtUp) reasons.push('legacy_store_not_caught_up');
    if (input.newWritesAfterCutover > 0 && !input.oldStoreCaughtUp) reasons.push('new_writes_would_be_lost');
    return { status: reasons.length ? 'blocked' : 'safe', reasons };
  }

  private async loadLedger(sourceLabel: string): Promise<MigrationLedgerV1> { const value = await readJson<MigrationLedgerV1>(this.ledgerPath); if (value) return value; const now = this.now(); return { schemaVersion: 1, migrationId: this.options.migrationId ?? `migration-${Date.now().toString(36)}`, sourceLabel, createdAt: now, updatedAt: now, entries: [] }; }
  private async saveLedger(ledger: MigrationLedgerV1): Promise<void> { await atomicWrite(this.ledgerPath, ledger); }
}

export class ShadowComparator {
  constructor(private readonly migration: LegacyThreadMigration) {}
  compare(source: readonly LegacyConversationSnapshot[]): Promise<ShadowComparisonReport> { return this.migration.shadowCompare(source); }
}

function toExecutionLinks(references: readonly LegacyExecutionReference[], conversationId: ConversationId): readonly ConversationExecutionLinkInput[] {
  return references.filter(reference => reference.conversationId === conversationId && reference.agentRunId).map(reference => ({ agentRunId: reference.agentRunId!, ...(reference.responseExecutionId ? { responseExecutionId: reference.responseExecutionId } : {}), sourceMessageId: reference.sourceMessageId, createdAt: toIsoTimestamp(new Date(0).toISOString()) }));
}

function replaceLedgerEntry(entries: MigrationLedgerEntry[], next: MigrationLedgerEntry): void { const index = entries.findIndex(entry => entry.conversationId === next.conversationId); if (index < 0) entries.push(next); else entries[index] = next; }
function summaryFromConversation(conversation: Conversation): unknown { return { conversationId: conversation.id, projectId: conversation.projectId, title: conversation.title, status: conversation.status, updatedAt: conversation.updatedAt, messageCount: conversation.messages.length, turnCount: conversation.messages.filter(message => message.role === 'user').length }; }
function canonicalJson(value: unknown): string { return JSON.stringify(sortValue(value)); }
function sortValue(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortValue); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortValue(entry)])); return value; }
async function readJson<T>(file: string): Promise<T | undefined> { try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
async function atomicWrite(file: string, value: unknown): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); const { writeFile, rename } = await import('node:fs/promises'); const temp = `${file}.tmp-${process.pid}-${Date.now()}`; await writeFile(temp, `${canonicalJson(value)}\n`, 'utf8'); await rename(temp, file); }
