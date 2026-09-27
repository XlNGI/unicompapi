import type { ConversationSemanticContext } from './conversation-intent-orchestrator';

export const conversationRequestSafetyCodes = [
  'empty_input',
  'input_too_long',
  'control_character',
  'protected_value',
  'context_too_large',
  'attachment_limit_exceeded',
  'project_scope_invalid'
] as const;

export type ConversationRequestSafetyCode = (typeof conversationRequestSafetyCodes)[number];

export class ConversationRequestSafetyError extends Error {
  constructor(readonly code: ConversationRequestSafetyCode) {
    super(code);
    this.name = 'ConversationRequestSafetyError';
  }
}

export interface ConversationRequestSafetyInput {
  readonly rawText: string;
  readonly projectId?: string;
  readonly attachmentFileIds?: readonly string[];
  readonly context?: ConversationSemanticContext;
}

const maxInputLength = 8_000;
const maxAttachmentCount = 16;
const maxRecentMessages = 32;
const maxRecentMessageLength = 8_000;
const maxContextCharacters = 24_000;

/**
 * The gate runs before semantic planning. It only validates local facts and
 * never normalizes user content into a model request.
 */
export function validateConversationRequestSafety(input: ConversationRequestSafetyInput): void {
  if (typeof input.projectId === 'string' && input.projectId.trim().length === 0) {
    throw new ConversationRequestSafetyError('project_scope_invalid');
  }
  const text = input.rawText;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ConversationRequestSafetyError('empty_input');
  }
  if (text.length > maxInputLength) {
    throw new ConversationRequestSafetyError('input_too_long');
  }
  if (hasUnsafeControlCharacter(text) || containsProtectedValue(text)) {
    throw new ConversationRequestSafetyError(
      hasUnsafeControlCharacter(text) ? 'control_character' : 'protected_value'
    );
  }
  if (input.attachmentFileIds && input.attachmentFileIds.length > maxAttachmentCount) {
    throw new ConversationRequestSafetyError('attachment_limit_exceeded');
  }
  validateContext(input.context);
}

function validateContext(context: ConversationSemanticContext | undefined): void {
  if (!context?.recentUserMessages) return;
  if (context.recentUserMessages.length > maxRecentMessages) {
    throw new ConversationRequestSafetyError('context_too_large');
  }
  let characters = 0;
  for (const message of context.recentUserMessages) {
    if (typeof message !== 'string' || message.length > maxRecentMessageLength || hasUnsafeControlCharacter(message)) {
      throw new ConversationRequestSafetyError('context_too_large');
    }
    characters += message.length;
    if (characters > maxContextCharacters) {
      throw new ConversationRequestSafetyError('context_too_large');
    }
  }
}

function hasUnsafeControlCharacter(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
}

function containsProtectedValue(value: string): boolean {
  return /(?:api[_ -]?key|access[_ -]?token|secret|password|凭证|密钥)\s*[:=：]\s*\S+/iu.test(value);
}
