import type { MessageDto } from '../shared/chat-context-ipc';
import { executionStopReasons, executionTimeoutScopes, type ProductionEventFacts,
  type ProductionTraceEventDto } from '../shared/conversation-production-ipc';

export interface ResponseFailureFacts {
  readonly stopReason?: ProductionEventFacts['stopReason'];
  readonly timeoutScope?: ProductionEventFacts['timeoutScope'];
  readonly registeredWork: boolean;
}

/** This receipt concerns the verified file, not the stopped response outcome. */
export function retainedDocumentSummary(result: NonNullable<MessageDto['retainedDocumentResult']>): string {
  const actual = `已保留 ${result.actualPageCount} 页 PPT`;
  const goal = result.planningTargetTotalPages;
  if (goal === undefined) return `${actual}。`;
  if (result.actualPageCount < goal) return `${actual}，${goal} 页规划目标尚未达到。`;
  if (result.actualPageCount > goal) return `${actual}，与 ${goal} 页规划目标有偏差。`;
  return `${actual}，达到 ${goal} 页规划目标。`;
}

/** Reopening a conversation uses saved execution facts, never guesses from an old generic error. */
export function responseFailureFactsFromTrace(events: readonly ProductionTraceEventDto[]): ResponseFailureFacts {
  const cycleStart = events.filter(event => event.code === 'request_received' && event.status === 'started')
    .reduce((sequence, event) => Math.max(sequence, event.sequence), 0);
  events = events.filter(event => event.sequence >= cycleStart);
  const stopped = events.filter(event => (event.status === 'failed' || event.status === 'cancelled') &&
    event.facts?.stopReason !== undefined && executionStopReasons.includes(event.facts.stopReason))
    .reduce<ProductionTraceEventDto | undefined>((latest, event) => !latest || event.sequence > latest.sequence ? event : latest, undefined);
  const completedAfterStop = stopped && events.some(event => event.sequence > stopped.sequence && event.status === 'completed' &&
    event.code === 'model_response' && event.facts?.purpose === 'content');
  const registeredWork = events.some(event => event.code === 'document_register' && event.status === 'completed');
  if (!stopped || completedAfterStop) return { registeredWork };
  return { registeredWork, stopReason: stopped.facts!.stopReason,
    ...(stopped.facts?.timeoutScope && executionTimeoutScopes.includes(stopped.facts.timeoutScope)
      ? { timeoutScope: stopped.facts.timeoutScope } : {}) };
}

export function executionStopLabel(reason: NonNullable<ProductionEventFacts['stopReason']>,
  scope?: ProductionEventFacts['timeoutScope']): string {
  if (reason === 'timeout') {
    const stages = { execution: '任务执行达到总时限', prepare: '执行准备达到时限', model: '本轮模型响应达到时限',
      tool: '受控工具执行达到时限', design: '文档设计达到时限', repair: '文档修正达到时限',
      render: '文档渲染达到时限', check: '结果检查达到时限', publish: '文件发布达到时限', register: '作品登记达到时限' };
    return scope ? stages[scope] : '执行达到时限';
  }
  return { cancelled: '任务执行已停止', tool_call_limit: '执行调用次数已达上限', budget_exceeded: '执行调度预算已耗尽',
    failure_limit: '连续执行失败已达上限', no_progress: '执行未产生新的进展', unknown_result: '执行结果需要核对' }[reason];
}

function stopFromSafeCode(code: string | undefined): Pick<ResponseFailureFacts, 'stopReason' | 'timeoutScope'> | undefined {
  const suffix = code?.split('.').at(-1);
  if (!suffix) return undefined;
  if (suffix.startsWith('tool_loop_')) {
    const reason = suffix.slice('tool_loop_'.length) as NonNullable<ProductionEventFacts['stopReason']>;
    return executionStopReasons.includes(reason) ? { stopReason: reason,
      ...(reason === 'timeout' ? { timeoutScope: 'execution' as const } : {}) } : undefined;
  }
  if (suffix.endsWith('_timeout')) {
    const scope = suffix.slice(0, -'_timeout'.length) as NonNullable<ProductionEventFacts['timeoutScope']>;
    return executionTimeoutScopes.includes(scope) ? { stopReason: 'timeout', timeoutScope: scope } : undefined;
  }
  return undefined;
}

export function failedResponseNotice(
  message?: MessageDto,
  safeCode?: string,
  facts?: ResponseFailureFacts
): string {
  const partial = Boolean(message?.content.trim());
  const preserved = partial ? '，已保留接收到的内容' : '';
  const controlledCode = safeCode && safeCode.length <= 120 &&
    /^(?:[a-z][a-z0-9_]*\.){0,3}[a-z][a-z0-9_]*$/.test(safeCode)
    ? safeCode
    : undefined;
  const reasonCode = controlledCode?.split('.').at(-1);
  const diagnostic = controlledCode ? `（${controlledCode}）` : '';
  const stop = stopFromSafeCode(controlledCode) ?? (facts?.stopReason ? facts : undefined);
  const registeredWork = Boolean(message?.documentResult || message?.retainedDocumentResult || facts?.registeredWork);
  if (reasonCode === 'execution_journal_failed') {
    return `执行记录未能确认写入${preserved}，任务已停止以避免重复操作。${registeredWork ? '已有作品保留。' : ''}请先核对执行记录，再决定下一步。`;
  }
  if (stop?.stopReason) {
    const artifact = registeredWork ? '已保存的文件保留，后续回复已停止。' : '';
    const next = stop.stopReason === 'unknown_result'
      ? '请先核对执行记录和已有结果，核对前不要重复生成。'
      : registeredWork ? '请先查看已保存文件和执行记录。' : '请查看执行记录，再决定下一步。';
    return `${executionStopLabel(stop.stopReason, stop.timeoutScope)}${preserved}。${artifact}${next}`;
  }
  if (reasonCode === 'tool_loop_limit') {
    return `执行循环已停止${preserved}。历史记录未保存具体停止原因，请先核对执行记录${registeredWork ? '；已保存的文件保留' : ''}。`;
  }
  const controlFailure = reasonCode === 'tool_loop_tool_bridge_unavailable' ? '当前任务的受控工具不可用'
    : reasonCode === 'tool_loop_invalid_tool_calls' ? '模型返回的工具调用不符合要求'
      : reasonCode === 'tool_loop_tool_loop_limit_exceeded' ? '模型执行轮数已达上限' : undefined;
  if (controlFailure) {
    return `${controlFailure}${preserved}。${registeredWork ? '已保存的文件保留，请先查看文件和执行记录。' : '请查看执行记录，再决定下一步。'}`;
  }

  if (message?.retainedDocumentResult) {
    return `后续回复未正常完成${preserved}。已校验并保存的 PPT 保留，请先查看文件与执行记录。`;
  }

  if (reasonCode === 'authentication_failed') {
    return `服务商鉴权失败${diagnostic}${preserved}。请检查当前模型凭据与权限，或切换模型后重试。`;
  }
  if (reasonCode === 'permission_denied') {
    return `当前凭证没有调用权限${diagnostic}${preserved}。请检查服务商账户权限与当前模型调用权限，或切换模型后重试。`;
  }
  if (reasonCode === 'invalid_request' || reasonCode === 'invalid_parameters') {
    return `请求被服务商拒绝${diagnostic}${preserved}。请核对模型参数；如附带图片，请确认当前模型支持图片输入后重试。`;
  }
  if (reasonCode === 'upstream_rejected' || message?.failureReason === 'upstream_rejected') {
    return `服务商网关调用上游模型失败${diagnostic}${preserved}。请核对服务商的上游通道与错误记录，当前信息不足以判定为输入参数错误。`;
  }
  if (reasonCode === 'model_not_found' || message?.failureReason === 'model_unavailable') {
    return `当前接口未找到所选模型${diagnostic}${preserved}。请核对服务商模型名称及可用通道，或切换可用模型。`;
  }
  if (reasonCode === 'local_response_write_failed' || message?.failureReason === 'local_write_failed') {
    return `本地保存回答失败${diagnostic}${preserved}。请检查本地存储和项目状态，再核对当前回复记录。`;
  }
  if (reasonCode === 'rate_limited') {
    return `请求被服务商限流${diagnostic}${preserved}。请稍后重试。`;
  }
  if (reasonCode === 'insufficient_balance' || reasonCode === 'insufficient_quota' || reasonCode === 'credit_insufficient') {
    return `服务商余额或调用额度不足${diagnostic}${preserved}。请核对服务商账户余额与额度，或切换模型后重试。`;
  }
  if (controlledCode?.includes('finish.content_filter')) {
    return `回答被模型安全策略提前结束${diagnostic}${preserved}。请调整问题后重试。`;
  }
  if (controlledCode?.includes('finish.tool_calls')) {
    return `模型请求调用工具，但当前会话未配置该工具${diagnostic}${preserved}。请调整问题后重试。`;
  }
  if (controlledCode?.includes('finish.insufficient_system_resource')) {
    return `模型服务资源不足${diagnostic}${preserved}。请稍后重试或切换模型。`;
  }
  if (message?.failureReason === 'request_rejected') {
    return `请求被服务商拒绝${preserved}。请核对模型参数；如附带图片，请确认当前模型支持图片输入后重试。`;
  }
  if (message?.failureReason === 'access_denied') {
    return `服务商拒绝访问${preserved}。请检查当前模型凭据与调用权限，或切换模型后重试。`;
  }
  if (controlledCode?.includes('timeout') || message?.failureReason === 'unknown') {
    return `本地等待模型响应超时${preserved}。远端状态和费用可能已经产生，请先核对服务商后台，避免立即重复发送。`;
  }
  if (message?.failureReason === 'truncated') {
    return `回答达到当前输出长度上限${preserved}。可以继续追问，或调整输出长度后重试。`;
  }
  if (message?.failureReason === 'interrupted') {
    return `模型连接中断${preserved}，请检查网络后重试。`;
  }
  if (message?.failureReason === 'invalid_response') {
    return `模型返回的数据格式异常${diagnostic}${preserved}，请重试或切换模型。`;
  }
  if (message?.failureReason === 'unavailable') {
    return `模型连接超时或服务暂时不可用${preserved}，请稍后重试或切换模型。`;
  }
  return `模型请求未正常完成${diagnostic}${preserved}，请重试。`;
}
