import { describe, expect, it } from 'vitest';
import {
  ConversationRequestSafetyError,
  validateConversationRequestSafety
} from '../../src/application';

describe('conversation request safety gate', () => {
  it('accepts a bounded local request before semantic planning', () => {
    expect(() => validateConversationRequestSafety({
      projectId: 'project-1',
      rawText: '制作一份关于季度经营情况的 PPT',
      attachmentFileIds: ['file-1'],
      context: { recentUserMessages: ['请使用简洁商务风格'] }
    })).not.toThrow();
  });

  it.each([
    ['empty_input', '   '],
    ['input_too_long', 'x'.repeat(8_001)],
    ['control_character', '正常请求\u0000'],
    ['protected_value', '请使用 api_key: sk-test-value']
  ] as const)('rejects %s before model execution', (code, rawText) => {
    expect(() => validateConversationRequestSafety({ rawText })).toThrowError(
      new ConversationRequestSafetyError(code)
    );
  });

  it('rejects oversized context and attachment batches', () => {
    expect(() => validateConversationRequestSafety({
      rawText: '制作 PPT',
      context: { recentUserMessages: Array.from({ length: 33 }, () => '历史消息') }
    })).toThrowError(new ConversationRequestSafetyError('context_too_large'));
    expect(() => validateConversationRequestSafety({
      rawText: '制作 PPT',
      attachmentFileIds: Array.from({ length: 17 }, (_, index) => `file-${index}`)
    })).toThrowError(new ConversationRequestSafetyError('attachment_limit_exceeded'));
  });
});
