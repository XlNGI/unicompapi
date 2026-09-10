import { describe, expect, it } from 'vitest';
import type { MessageDto } from '../../src/shared/chat-context-ipc';
import { failedResponseNotice } from '../../src/ui/chat-response-failure-notice';

function failedMessage(
  failureReason: MessageDto['failureReason'],
  content = ''
): MessageDto {
  return {
    messageId: 'assistant-failure-notice',
    conversationId: 'conversation-failure-notice',
    revision: 1,
    role: 'assistant',
    state: 'failed',
    content,
    attachments: [],
    failureReason,
    createdAt: '2026-09-10T08:27:41.000Z',
    updatedAt: '2026-09-10T08:27:41.000Z'
  };
}

describe('chat response failure notices', () => {
  it.each(['', '已收到的部分回答'])('explains HTTP 400 request rejection despite the legacy invalid-response projection (%s)', (content) => {
    const notice = failedResponseNotice(failedMessage('invalid_response', content), 'newapi.invalid_request');

    expect(notice).toContain('请求被服务商拒绝');
    expect(notice).toContain('newapi.invalid_request');
    expect(notice).toContain('核对模型参数');
    expect(notice).toContain('如附带图片');
    expect(notice).toContain('确认当前模型支持图片输入');
    expect(notice).not.toMatch(/数据格式异常|模型不支持图片|连接超时/);
    expect(notice.includes('已保留接收到的内容')).toBe(Boolean(content));
  });

  it.each(['', '已收到的部分回答'])('explains HTTP 403 permission rejection despite the legacy unavailable projection (%s)', (content) => {
    const notice = failedResponseNotice(failedMessage('unavailable', content), 'newapi.permission_denied');

    expect(notice).toContain('当前凭证没有调用权限');
    expect(notice).toContain('newapi.permission_denied');
    expect(notice).toContain('当前模型调用权限');
    expect(notice).not.toMatch(/数据格式异常|连接超时/);
    expect(notice.includes('已保留接收到的内容')).toBe(Boolean(content));
  });

  it.each(['', 'newapi.', 'deepseek.'])('recognizes controlled rejection codes from any supported provider prefix (%s)', (prefix) => {
    for (const [code, expected] of [
      ['invalid_request', '请求被服务商拒绝'],
      ['invalid_parameters', '请求被服务商拒绝'],
      ['upstream_rejected', '服务商网关调用上游模型失败'],
      ['model_not_found', '当前接口未找到所选模型'],
      ['permission_denied', '当前凭证没有调用权限'],
      ['rate_limited', '请求被服务商限流'],
      ['insufficient_balance', '服务商余额或调用额度不足'],
      ['insufficient_quota', '服务商余额或调用额度不足'],
      ['credit_insufficient', '服务商余额或调用额度不足']
    ]) {
      const notice = failedResponseNotice(failedMessage('invalid_response'), `${prefix}${code}`);
      expect(notice).toContain(expected);
      expect(notice).not.toContain('数据格式异常');
    }
  });

  it.each(['request_rejected', 'access_denied'] as const)('retains the rejection explanation when a persisted %s message has no stream code', (reason) => {
    const notice = failedResponseNotice(failedMessage(reason, '部分内容'));

    expect(notice).toContain(reason === 'request_rejected' ? '请求被服务商拒绝' : '服务商拒绝访问');
    expect(notice).toContain('已保留接收到的内容');
    expect(notice).not.toMatch(/数据格式异常|连接超时/);
  });

  it('keeps authentication failures distinct from permission failures', () => {
    const notice = failedResponseNotice(failedMessage('access_denied'), 'newapi.authentication_failed');
    expect(notice).toContain('服务商鉴权失败');
    expect(notice).not.toContain('当前凭证没有调用权限');
  });

  it.each([
    ['upstream_rejected', '服务商网关调用上游模型失败'],
    ['model_unavailable', '当前接口未找到所选模型'],
    ['local_write_failed', '本地保存回答失败']
  ] as const)('keeps the saved %s reason without stream events', (reason, expected) => {
    expect(failedResponseNotice(failedMessage(reason))).toContain(expected);
  });

  it('includes a controlled stream diagnostic while preserving received text', () => {
    const notice = failedResponseNotice(failedMessage('invalid_response', '部分回答'), 'newapi.invalid_response.missing_terminal');
    expect(notice).toContain('newapi.invalid_response.missing_terminal');
    expect(notice).toContain('已保留接收到的内容');
  });

  it('identifies local persistence errors without blaming provider JSON', () => {
    const notice = failedResponseNotice(failedMessage('unavailable', '部分回答'), 'newapi.local_response_write_failed');
    expect(notice).toContain('本地保存回答失败');
    expect(notice).not.toMatch(/数据格式异常|连接超时/);
  });

  it('preserves accepted content for rate and quota failures', () => {
    for (const code of ['rate_limited', 'insufficient_quota', 'insufficient_balance']) {
      expect(failedResponseNotice(failedMessage('unavailable', '部分内容'), `newapi.${code}`))
        .toContain('已保留接收到的内容');
    }
  });

  it('does not display a raw upstream error passed in place of a controlled code', () => {
    const rawError = 'newapi.invalid_request: Authorization Bearer synthetic-test-secret; https://upstream.example.test/private';
    const notice = failedResponseNotice(undefined, rawError);

    expect(notice).toBe('模型请求未正常完成，请重试。');
    expect(notice).not.toMatch(/Authorization|synthetic-test-secret|upstream\.example|invalid_request/);
  });

  it('does not treat whitespace-only content as a retained answer', () => {
    expect(failedResponseNotice(failedMessage('invalid_response', ' \n '), 'newapi.invalid_request'))
      .not.toContain('已保留接收到的内容');
  });

  it.each([
    ['invalid_response', '模型返回的数据格式异常'],
    ['truncated', '回答达到当前输出长度上限'],
    ['interrupted', '模型连接中断'],
    ['unavailable', '模型连接超时或服务暂时不可用'],
    ['unknown', '本地等待模型响应超时']
  ] as const)('preserves the existing %s fallback', (reason, expected) => {
    expect(failedResponseNotice(failedMessage(reason))).toContain(expected);
  });
});
