import {
  assertConversationBelongsToProject, parseConversation, toThreadId,
  type Conversation, type ConversationId, type ConversationListOptions, type ProjectConversationRepository, type ProjectId
} from '../../domain';
import type { ConversationTurnCoordinator } from '../../application/conversation-turn-coordinator';
import type { ThreadLegacyProjectionWorker } from '../../application/thread-legacy-projection-worker';
import { ConversationRepositoryDataError, ConversationRevisionConflictError } from './json-conversation-repository';
import { ThreadModelHistorySource } from './thread-model-history-source';
import type { ThreadFileRepository } from './thread-file-repository';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function hasCommittedThreadAuthority(rootDirectory: string): Promise<boolean> {
  let text: string;
  try { text = await readFile(path.join(rootDirectory, 'migration', 'authority-fence.v1.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  const fence = JSON.parse(text) as Record<string, unknown>;
  if (fence.schemaVersion !== 1 || !['legacy_authoritative', 'prepared', 'new_authoritative'].includes(String(fence.state)) ||
      ['generation', 'legacyGeneration', 'targetGeneration'].some(key => !Number.isSafeInteger(fence[key]) || Number(fence[key]) < 0) ||
      typeof fence.preparedAt !== 'string' || !Number.isFinite(Date.parse(fence.preparedAt)) || typeof fence.backupVerified !== 'boolean' ||
      fence.state === 'new_authoritative' && !fence.backupVerified) throw new Error('thread_authority_fence_invalid');
  return fence.state === 'new_authoritative';
}

/** Existing Conversation contracts over the committed Thread transcript. */
export class ThreadConversationRepository implements ProjectConversationRepository {
  readonly transcriptAuthority = true;
  private readonly source: ThreadModelHistorySource;
  constructor(private readonly threads: ThreadFileRepository, readonly projectId: ProjectId,
    private readonly coordinator: Pick<ConversationTurnCoordinator, 'createThread' | 'saveConversation' | 'projectDocumentArtifact'>,
    private readonly options: { readonly ready?: () => Promise<void>; readonly projection?: Pick<ThreadLegacyProjectionWorker, 'drain'>; readonly onError?: (error: unknown) => void } = {}) {
    this.source = new ThreadModelHistorySource(threads, projectId);
  }

  async get(id: ConversationId): Promise<Conversation | undefined> {
    await this.options.ready?.();
    return this.source.getConversation(id);
  }

  async list(options: ConversationListOptions = {}): Promise<readonly Conversation[]> {
    await this.options.ready?.();
    if (options.projectId !== undefined && options.projectId !== this.projectId) throw new ConversationRepositoryDataError('Thread project scope mismatch');
    const statuses = new Set(options.statuses ?? ['active']);
    if ([...statuses].some(status => !['active', 'archived', 'deleted'].includes(status))) throw new TypeError('Invalid conversation status');
    const results: Conversation[] = [];
    for (const summary of await this.threads.listThreadSummaries()) {
      if (summary.projectId !== this.projectId) continue;
      const conversation = await this.get(summary.threadId as unknown as ConversationId);
      if (conversation && statuses.has(conversation.status)) results.push(conversation);
    }
    return results.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  }

  async create(input: Conversation): Promise<void> {
    const conversation = this.validate(input);
    if (conversation.revision !== 0 || conversation.messages.length || conversation.status !== 'active') throw new ConversationRepositoryDataError('New Thread conversation must be empty and active');
    const existing = await this.get(conversation.id);
    if (existing) throw new ConversationRevisionConflictError(conversation.id, null, existing.revision);
    await this.coordinator.createThread({ threadId: conversation.id, projectId: this.projectId, title: conversation.title, createdAt: conversation.createdAt });
  }

  async createImportedSnapshot(input: Conversation): Promise<void> {
    const conversation = this.validate(input);
    if (conversation.status !== 'active' || conversation.messages.some(message => message.state !== 'completed' || message.attachments.length)) throw new ConversationRepositoryDataError('Imported Thread requires completed text messages');
    await this.create({ ...conversation, revision: 0, updatedAt: conversation.createdAt, messages: [] });
    if (conversation.messages.length) await this.save({ ...conversation, revision: 1 }, 0);
  }

  async save(input: Conversation, expectedRevision: number): Promise<void> {
    const next = this.validate(input);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || next.revision !== expectedRevision + 1) throw new ConversationRepositoryDataError('Saved Thread revision must increment exactly once');
    const previous = await this.get(next.id);
    if (!previous || previous.revision !== expectedRevision) throw new ConversationRevisionConflictError(next.id, expectedRevision, previous?.revision ?? null);
    try { await this.coordinator.saveConversation({ previous, next }); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'generation_conflict') throw error;
      throw new ConversationRevisionConflictError(next.id, expectedRevision, (await this.get(next.id))?.revision ?? null);
    }
    await this.options.projection?.drain(next.id).catch(error => this.options.onError?.(error));
  }

  async projectDocumentArtifact(input: Parameters<ConversationTurnCoordinator['projectDocumentArtifact']>[0]): Promise<void> {
    const conversation = await this.get(input.threadId as ConversationId);
    if (!conversation || conversation.projectId !== this.projectId) throw new ConversationRepositoryDataError('Thread artifact scope mismatch');
    await this.coordinator.projectDocumentArtifact(input);
  }

  private validate(input: Conversation): Conversation {
    const conversation = parseConversation(input);
    assertConversationBelongsToProject(conversation, this.projectId);
    toThreadId(conversation.id);
    return conversation;
  }
}
