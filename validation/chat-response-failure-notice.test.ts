import { describe, expect, it } from 'vitest';
import { failedResponseNotice } from '../src/ui/chat-response-failure-notice';
import type { MessageDto } from '../src/shared/chat-context-ipc';

function failedMessage(
  failureReason: NonNullable<MessageDto['failureReason']>,
  content = ''
): MessageDto {
  return {
    messageId: 'message-1',
    conversationId: 'conversation-1',
    revision: 1,
    role: 'assistant',
    state: 'failed',
    content,
    failureReason,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:01.000Z'
  };
}

describe('chat response failure notice', () => {
  it('does not mislabel an authenticated provider rejection as a timeout', () => {
    const notice = failedResponseNotice(
      failedMessage('unavailable'),
      'newapi.authentication_failed'
    );

    expect(notice).toContain('服务商鉴权失败');
    expect(notice).toContain('newapi.authentication_failed');
    expect(notice).not.toContain('超时');
  });

  it('keeps an unknown unavailable cause neutral when no safe code is available', () => {
    const notice = failedResponseNotice(failedMessage('unavailable'));

    expect(notice).toContain('当前回复未能完成');
    expect(notice).toContain('具体原因尚未确认');
    expect(notice).not.toMatch(/模型连接超时|切换模型|请稍后重试/);
  });
});
