import type { DocumentGenerationWorkflowPort } from '../../application/document-generation-service';
import type { ConversationWorkflowService } from '../../application/conversation-workflow-service';
import type { ConversationResponseExecutionRepository, ProjectConversationRepository } from '../../domain';

/** Resolve execution identity from persisted application state, never from model output. */
export function createDocumentWorkflowSettlement(options: {
  readonly workflows: ConversationWorkflowService;
  readonly conversations: ProjectConversationRepository;
  readonly executions: ConversationResponseExecutionRepository;
}): NonNullable<DocumentGenerationWorkflowPort['settleDocumentResult']> {
  return async (input) => {
    const conversation = await options.conversations.get(input.conversationId);
    const message = conversation?.messages.find((item) => item.id === input.messageId);
    if (!conversation || conversation.projectId !== options.conversations.projectId || message?.role !== 'assistant') {
      throw new Error('Document settlement message is unavailable');
    }
    if (input.status === 'completed' && (!input.workId || message.documentResult?.workId !== input.workId ||
      message.documentResult.kind !== input.kind || !message.documentResult.validatedContent)) {
      throw new Error('Document settlement requires the persisted validated Work result');
    }
    const execution = (await options.executions.list(input.conversationId)).find((item) => item.snapshot.assistantMessageId === input.messageId);
    const workflows = await options.workflows.list(input.conversationId);
    const workflow = workflows.find((item) => item.plan.kind === 'document' &&
      item.plan.documentKind === input.kind && item.status === 'executing' &&
      (execution ? item.executionId === execution.id : Boolean(
        (input.localExecutionId && item.executionId === input.localExecutionId) ||
        item.deliveries?.some((delivery) => delivery.executionId === item.executionId && delivery.resultMessageId === input.messageId)
      )));
    if (!workflow?.executionId) return;
    await options.workflows.finishDocumentExecution(workflow.executionId, input.status,
      { messageId: input.messageId, ...(input.status === 'completed' ? { workId: input.workId! } : {}) },
      message.state === 'completed' ? 'execution_failed' : 'outcome_unknown');
  };
}
