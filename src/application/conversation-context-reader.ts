import type {
  ConversationAgentRunRepository,
  ConversationResponseExecutionRepository,
  DocumentTaskRuntimeRepository,
  WorkRepository,
  ProjectId,
  ConversationId,
  ThreadId,
  ItemV1,
  ConversationAgentRunV1,
  ConversationResponseExecutionV1,
  DocumentTaskRuntime,
  Work
} from '../domain';
import type { ThreadFileRepository } from '../platform/repositories/thread-file-repository';

export interface ConversationContextReadModel {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly items: readonly ItemV1[];
  readonly agentRuns: readonly ConversationAgentRunV1[];
  readonly executions: readonly ConversationResponseExecutionV1[];
  readonly documentTasks: readonly DocumentTaskRuntime[];
  readonly works: readonly Work[];
}

/** Composes the authoritative Thread transcript with execution/document facts. */
export class ConversationContextReader {
  constructor(
    private readonly threads: ThreadFileRepository,
    private readonly agentRuns: ConversationAgentRunRepository,
    private readonly executions: ConversationResponseExecutionRepository,
    private readonly documentTasks: DocumentTaskRuntimeRepository,
    private readonly works: WorkRepository
  ) {}

  async read(threadId: ThreadId | string): Promise<ConversationContextReadModel> {
    const thread = await this.threads.getThread(threadId as ThreadId);
    if (!thread) throw new Error('thread_not_found');
    const conversationId = thread.threadId as unknown as ConversationId;
    const [items, agentRuns, executions, documentTasks, works] = await Promise.all([
      this.threads.readItems(thread.threadId),
      this.agentRuns.list(conversationId),
      this.executions.list(conversationId),
      this.documentTasks.list(conversationId),
      this.works.list(thread.projectId as ProjectId)
    ]);
    const taskIds = new Set(documentTasks.map(task => String(task.id)));
    const relatedWorks = works.filter(work => taskIds.has(String(work.sourceTaskId)) || executions.some(execution => String(execution.id) === String(work.sourceExecutionId)));
    return { threadId: thread.threadId, projectId: thread.projectId, items, agentRuns, executions, documentTasks, works: relatedWorks };
  }
}
