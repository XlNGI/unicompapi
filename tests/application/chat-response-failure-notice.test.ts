import { describe, expect, it } from 'vitest';
import type { MessageDto } from '../../src/shared/chat-context-ipc';
import { failedResponseNotice, responseFailureFactsFromTrace } from '../../src/ui/chat-response-failure-notice';
import type { ProductionTraceEventDto } from '../../src/shared/conversation-production-ipc';

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
  it.each(['newapi', 'deepseek'])('distinguishes %s protocol and round failures from a depleted execution budget', provider => {
    for (const [code, label] of [
      ['tool_bridge_unavailable', '受控工具不可用'], ['invalid_tool_calls', '工具调用不符合要求'],
      ['tool_loop_limit_exceeded', '模型执行轮数已达上限']
    ]) {
      const notice = failedResponseNotice(failedMessage('unavailable', '部分回答'), `${provider}.tool_loop_${code}`);
      expect(notice).toContain(label);
      expect(notice).toContain('已保留接收到的内容');
      expect(notice).not.toMatch(/预算已耗尽|调度预算|余额|费用|请重试/);
    }
  });
  it.each(['newapi', 'deepseek'])('distinguishes precise %s execution stops from network failures', provider => {
    for (const [reason, label] of [
      ['timeout', '任务执行达到总时限'], ['tool_call_limit', '执行调用次数已达上限'],
      ['budget_exceeded', '执行调度预算已耗尽'], ['failure_limit', '连续执行失败已达上限'],
      ['no_progress', '执行未产生新的进展'], ['cancelled', '任务执行已停止']
    ]) {
      const notice = failedResponseNotice(failedMessage('unavailable', '部分回答'), `${provider}.tool_loop_${reason}`);
      expect(notice).toContain(label);
      expect(notice).toContain('已保留接收到的内容');
      expect(notice).not.toMatch(/网络|模型连接超时|费用|请重试|金额/);
    }
    expect(failedResponseNotice(failedMessage('unknown'), `${provider}.execution_timeout`)).toContain('任务执行达到总时限');
    expect(failedResponseNotice(failedMessage('unknown'), `${provider}.prepare_timeout`)).toContain('执行准备达到时限');
    expect(failedResponseNotice(failedMessage('unknown'), `${provider}.tool_timeout`)).toContain('受控工具执行达到时限');
  });

  it.each(['newapi', 'deepseek'])('does not suggest retrying a %s unknown tool result', provider => {
    const notice = failedResponseNotice(failedMessage('unavailable'), `${provider}.tool_loop_unknown_result`);
    expect(notice).toContain('执行结果需要核对');
    expect(notice).toContain('核对前不要重复生成');
    expect(notice).not.toMatch(/请重试|重新生成|连接超时/);
  });

  it('uses persisted stop facts after reopening and preserves a registered artifact on either side of Stop', () => {
    const stopped: ProductionTraceEventDto = { schemaVersion: 1, projectId: 'project', conversationId: 'conversation',
      sourceMessageId: 'user', traceId: 'trace', sequence: 2, code: 'task_complete', status: 'failed',
      operationId: 'execution_budget', facts: { stopReason: 'timeout', timeoutScope: 'execution', parentElapsedMs: 360_000,
        parentRemainingMs: 0, toolCallsUsed: 2, costUnitsUsed: 16 }, occurredAt: '2026-10-03T00:00:00.000Z' };
    for (const sequence of [1, 3]) {
      const registered = { ...stopped, sequence, code: 'document_register' as const, status: 'completed' as const, facts: undefined };
      const localCompleted = { ...registered, sequence: 4, code: 'task_complete' as const };
      const facts = responseFailureFactsFromTrace([registered, stopped, localCompleted]);
      const notice = failedResponseNotice(failedMessage('unavailable'), undefined, facts);
      expect(notice).toContain('任务执行达到总时限');
      expect(notice).toContain('已保存的文件保留，后续回复已停止');
      expect(notice).not.toMatch(/未生成|trace|360000|16|费用|网络|重试/);
    }
  });

  it('does not invent a precise cause for the legacy loop-limit code', () => {
    const notice = failedResponseNotice(failedMessage('unavailable'), 'newapi.tool_loop_limit');
    expect(notice).toContain('历史记录未保存具体停止原因');
    expect(notice).not.toMatch(/超时|预算.*耗尽|轮数.*上限|请重试/);
  });

  it('does not keep an earlier child stop after a later completed response', () => {
    const base: ProductionTraceEventDto = { schemaVersion: 1, projectId: 'project', conversationId: 'conversation',
      sourceMessageId: 'user', traceId: 'trace', sequence: 1, code: 'task_complete', status: 'failed',
      facts: { stopReason: 'timeout', timeoutScope: 'design' }, occurredAt: '2026-10-03T00:00:00.000Z' };
    const facts = responseFailureFactsFromTrace([base, { ...base, sequence: 2, code: 'model_response', status: 'completed',
      facts: { purpose: 'content' } }]);
    expect(facts.stopReason).toBeUndefined();
  });

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
