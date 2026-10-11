import type { Conversation, ConversationId, Message, MessageId, ThreadId } from '../domain';
import { toConversationId, toThreadId } from '../domain';
import {
  ConversationContextBuilder,
  type ConversationContextEnvelope,
  type ConversationContextReference
} from './conversation-context-builder';
import { AgentContextAssembler, type AgentContextInput } from './agent-context-assembler';

export interface ModelHistorySource {
  /** Complete Conversation read; this is deliberately independent of UI pages. */
  getConversation(conversationId: ConversationId): Promise<Conversation | undefined>;
}

export interface ModelHistoryQuery {
  readonly threadId: ThreadId;
  readonly currentMessageId: MessageId;
  readonly currentUserContent?: string;
  readonly references?: readonly ConversationContextReference[];
}

export class ModelHistoryReader {
  constructor(private readonly source: ModelHistorySource) {}

  async readModelHistory(query: Pick<ModelHistoryQuery, 'threadId'>): Promise<readonly Message[]> {
    const conversation = await this.requireConversation(query.threadId);
    return conversation.messages;
  }

  async readConversation(query: Pick<ModelHistoryQuery, 'threadId'>): Promise<Conversation> {
    return this.requireConversation(query.threadId);
  }

  async buildContext(query: ModelHistoryQuery, builder = new ConversationContextBuilder()): Promise<ConversationContextEnvelope> {
    const conversation = await this.requireConversation(query.threadId);
    return builder.build({ conversation, currentUserMessageId: query.currentMessageId, currentUserContent: query.currentUserContent, references: query.references });
  }

  async assembleAgentContext(query: ModelHistoryQuery, assembler = new AgentContextAssembler()): Promise<ConversationContextEnvelope> {
    const conversation = await this.requireConversation(query.threadId);
    const input: AgentContextInput = { conversation, currentUserMessageId: query.currentMessageId, currentUserContent: query.currentUserContent, references: query.references };
    return assembler.assemble(input);
  }

  private async requireConversation(threadId: ThreadId): Promise<Conversation> {
    const conversation = await this.source.getConversation(toConversationId(threadId));
    if (!conversation) throw new Error('conversation_not_found');
    return conversation;
  }
}

export function createModelHistoryReader(source: ModelHistorySource): ModelHistoryReader {
  return new ModelHistoryReader(source);
}

export function threadIdFromConversationId(conversationId: ConversationId): ThreadId {
  return toThreadId(conversationId);
}
