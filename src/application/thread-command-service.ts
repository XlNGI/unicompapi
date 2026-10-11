import {
  createItemV1,
  createTurnV1,
  itemIdKey,
  toMessageItemId,
  toMessageId,
  toThreadId,
  toTurnId,
  type ItemV1,
  type IsoTimestamp,
  type ProjectId,
  type ThreadId,
  type ThreadV1,
  type TurnId,
  type TurnV1
} from '../domain';

export interface ThreadCommandRepository {
  getThread(threadId: ThreadId): Promise<ThreadV1 | undefined>;
  createThread(input: { readonly threadId: ThreadId; readonly projectId: ProjectId | null; readonly title: string; readonly createdAt: IsoTimestamp }): Promise<ThreadV1>;
  readTurns(threadId: ThreadId): Promise<readonly TurnV1[]>;
  readItems(threadId: ThreadId): Promise<readonly ItemV1[]>;
  append(input: {
    readonly threadId: ThreadId;
    readonly idempotencyKey: string;
    readonly occurredAt: IsoTimestamp;
    readonly expectedGeneration?: number;
    readonly thread?: Partial<Pick<ThreadV1, 'title' | 'status' | 'lastItemId' | 'lastItemSequence' | 'itemCount' | 'turnCount' | 'generation'>>;
    readonly turns?: readonly TurnV1[];
    readonly items?: readonly ItemV1[];
  }): Promise<{ readonly thread: ThreadV1; readonly alreadyCommitted: boolean }>;
}

export interface AcceptThreadTurnInput {
  readonly threadId: ThreadId | string;
  readonly projectId: ProjectId | string | null;
  readonly title: string;
  readonly turnId?: TurnId | string;
  readonly messageId: string;
  readonly messageRevision?: number;
  readonly content: string;
  readonly createdAt: IsoTimestamp;
  readonly clientCommandId: string;
}

export interface AcceptedThreadTurn {
  readonly thread: ThreadV1;
  readonly turn: TurnV1;
  readonly item: ItemV1;
  readonly alreadyCommitted: boolean;
}

/**
 * Owns transcript acceptance only. Provider dispatch, authorization, budget
 * and execution remain in the existing Agent/Response Runtime.
 */
export class ThreadCommandService {
  constructor(private readonly repository: ThreadCommandRepository) {}

  async acceptUserTurn(input: AcceptThreadTurnInput): Promise<AcceptedThreadTurn> {
    const threadId = toThreadId(String(input.threadId));
    const projectId = input.projectId === null ? null : String(input.projectId) as ProjectId;
    const content = input.content.trim();
    if (!content) throw new TypeError('Thread user content cannot be empty');
    if (!input.clientCommandId.trim()) throw new TypeError('Thread clientCommandId cannot be empty');
    if (input.messageRevision !== undefined && (!Number.isSafeInteger(input.messageRevision) || input.messageRevision < 0)) {
      throw new TypeError('Thread messageRevision is invalid');
    }

    let thread = await this.repository.getThread(threadId);
    if (!thread) {
      try {
        thread = await this.repository.createThread({ threadId, projectId, title: input.title, createdAt: input.createdAt });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'thread_already_exists') throw error;
        thread = await this.repository.getThread(threadId);
      }
    }
    if (!thread) throw new Error('thread_not_found_after_create');
    if (thread.projectId !== projectId) throw new Error('thread_project_scope_mismatch');

    const turnId = toTurnId(String(input.turnId ?? `turn-${input.clientCommandId}`));
    const item = createItemV1({
      itemId: toMessageItemId(input.messageId),
      threadId,
      turnId,
      sequence: thread.lastItemSequence + 1,
      type: 'user_message',
      status: 'completed',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      messageSource: { messageId: toMessageId(input.messageId), messageRevision: input.messageRevision ?? 0 },
      content
    });
    const turn = createTurnV1({
      turnId,
      threadId,
      turnSequence: thread.turnCount + 1,
      createdAt: input.createdAt,
      userItemId: item.itemId,
      provenance: 'native'
    });
    const result = await this.repository.append({
      threadId,
      idempotencyKey: `thread-turn:${input.clientCommandId}`,
      occurredAt: input.createdAt,
      expectedGeneration: thread.generation,
      turns: [turn],
      items: [item]
    });
    if (!result.alreadyCommitted) return { thread: result.thread, turn, item, alreadyCommitted: false };
    const storedTurn = (await this.repository.readTurns(threadId)).find(candidate => candidate.turnId === turnId);
    const storedItem = (await this.repository.readItems(threadId)).find(candidate => itemIdKey(candidate.itemId) === itemIdKey(item.itemId));
    if (!storedTurn || !storedItem) throw new Error('thread_turn_idempotency_record_missing');
    return { thread: result.thread, turn: storedTurn, item: storedItem, alreadyCommitted: true };
  }
}

export function threadItemIdentity(item: ItemV1): string {
  return itemIdKey(item.itemId);
}
