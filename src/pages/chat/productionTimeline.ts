import type { ConversationDto, MessageDto } from '../../shared/chat-context-ipc';
import type { ProductionTraceEventDto } from '../../shared/conversation-production-ipc';

export function mergeProductionEvents(current: readonly ProductionTraceEventDto[], incoming: readonly ProductionTraceEventDto[]) {
  const bySequence = new Map(current.map((event) => [`${event.conversationId}:${event.sequence}`, event]));
  for (const event of incoming) bySequence.set(`${event.conversationId}:${event.sequence}`, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

export interface PendingProductionInput {
  readonly clientCommandId: string;
  readonly content: string;
  readonly conversationId?: string;
  readonly sourceMessageId?: string;
}

/** Bind events to their actual assistant, keeping a temporary message before that assistant exists. */
export function projectProductionMessages(conversation: ConversationDto | undefined,
  events: readonly ProductionTraceEventDto[], pending?: PendingProductionInput) {
  const messages = [...(conversation?.messages ?? [])];
  const timelineByMessage = new Map<string, readonly ProductionTraceEventDto[]>();
  const groups = new Map<string, ProductionTraceEventDto[]>();
  for (const event of events) {
    const group = groups.get(event.sourceMessageId) ?? [];
    group.push(event);
    groups.set(event.sourceMessageId, group);
  }
  for (const [sourceMessageId, group] of groups) {
    const latest = group[group.length - 1];
    let sourceIndex = messages.findIndex((message) => message.messageId === sourceMessageId);
    if (sourceIndex < 0 && pending?.sourceMessageId === sourceMessageId) {
      messages.push({ messageId: sourceMessageId, conversationId: latest.conversationId, revision: 0,
        role: 'user', state: 'completed', content: pending.content, attachments: [],
        createdAt: latest.occurredAt, updatedAt: latest.occurredAt });
      sourceIndex = messages.length - 1;
    }
    const explicitAssistantId = [...group].reverse().find((event) => event.assistantMessageId)?.assistantMessageId;
    const explicit = explicitAssistantId && messages.find((message) => message.messageId === explicitAssistantId && message.role === 'assistant');
    const following = sourceIndex >= 0 ? messages[sourceIndex + 1] : undefined;
    const assistant = explicit || (!explicitAssistantId && following?.role === 'assistant' ? following : undefined);
    if (assistant) {
      timelineByMessage.set(assistant.messageId, mergeProductionEvents(timelineByMessage.get(assistant.messageId) ?? [], group));
      continue;
    }
    const virtual: MessageDto = { messageId: `production-${sourceMessageId}`, conversationId: latest.conversationId,
      revision: 0, role: 'assistant', state: 'pending', content: '', attachments: [],
      createdAt: group[0].occurredAt, updatedAt: latest.occurredAt };
    messages.splice(sourceIndex < 0 ? messages.length : sourceIndex + 1, 0, virtual);
    timelineByMessage.set(virtual.messageId, mergeProductionEvents([], group));
  }
  const requestBySource = new Map(messages.filter((message) => message.role === 'user')
    .map((message) => [message.messageId, message.content]));
  return { messages, timelineByMessage, requestBySource };
}
