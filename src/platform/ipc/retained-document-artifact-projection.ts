import { toConversationId, toConversationResponseExecutionId, toWorkId, type ProjectId } from '../../domain';
import type { ConversationDto } from '../../shared/chat-context-ipc';
import { RegisteredPresentationReader } from '../documents/registered-presentation-reader';
import { JsonDocumentTaskRuntimeRepository } from '../repositories/json-document-task-runtime-repository';
import { JsonConversationResponseExecutionRepository } from '../repositories/json-conversation-response-execution-repository';
import { NodeProjectStorage } from '../storage';

/** A persisted display receipt never grants file access or supplies a revision target. */
export async function verifyRetainedDocumentArtifacts(conversation: ConversationDto, scope: {
  readonly rootDirectory: string;
  readonly projectId: ProjectId;
  readonly isCurrent: () => boolean;
}): Promise<ConversationDto> {
  if (!conversation.messages.some(message => message.retainedDocumentResult)) return conversation;
  const storage = new NodeProjectStorage(scope.rootDirectory);
  const tasks = new JsonDocumentTaskRuntimeRepository(storage, scope.projectId);
  const responses = new JsonConversationResponseExecutionRepository(storage, scope.projectId);
  const reader = new RegisteredPresentationReader(scope);
  const messages = [];
  for (const message of conversation.messages) {
    const retained = message.retainedDocumentResult;
    if (!retained) { messages.push(message); continue; }
    try {
      if (!scope.isCurrent() || conversation.projectId !== scope.projectId || conversation.storageScope !== 'current_project') throw new Error('retained_scope_changed');
      const document = await reader.read(toWorkId(retained.workId));
      const matchingTasks = (await tasks.list(toConversationId(conversation.conversationId))).filter(task =>
        task.observations.some(observation => observation.ok && observation.data?.registeredWorkId === retained.workId));
      if (matchingTasks.length !== 1) throw new Error('retained_artifact_changed');
      const task = matchingTasks[0];
      const response = task ? await responses.get(toConversationResponseExecutionId(task.executionId)) : undefined;
      const receipt = task?.observations.find(observation => observation.ok && observation.data?.registeredWorkId === retained.workId);
      if (!task || !response || !receipt || !['failed', 'cancelled', 'interrupted'].includes(response.state) ||
        !['failed', 'cancelled'].includes(message.state) || task.projectId !== scope.projectId || task.conversationId !== conversation.conversationId ||
        response.snapshot.conversationId !== conversation.conversationId || response.snapshot.assistantMessageId !== message.messageId ||
        response.snapshot.userMessageId !== task.sourceMessageId || document.work.sourceExecutionId !== document.file.sourceExecutionId ||
        document.pages.length !== retained.actualPageCount || document.fileName !== retained.fileName || document.file.sizeBytes !== retained.sizeBytes ||
        (retained.planningTargetTotalPages !== undefined && receipt.data?.planningTargetTotalPages !== retained.planningTargetTotalPages) || !scope.isCurrent()) {
        throw new Error('retained_artifact_changed');
      }
      messages.push(message);
    } catch {
      // Keep the historical record intact; only the current display capability is withheld.
      const { retainedDocumentResult: _receipt, ...withoutRetained } = message;
      void _receipt;
      messages.push(withoutRetained);
    }
  }
  return { ...conversation, messages };
}
