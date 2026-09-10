import type { MessageDto } from '../shared/chat-context-ipc';

export function failedResponseNotice(
  message?: MessageDto,
  safeCode?: string
): string {
  const partial = Boolean(message?.content.trim());
  const preserved = partial ? '，已保留接收到的内容' : '';
  const controlledCode = safeCode && safeCode.length <= 120 &&
    /^(?:[a-z][a-z0-9_]*\.){0,3}[a-z][a-z0-9_]*$/.test(safeCode)
    ? safeCode
    : undefined;
  const reasonCode = controlledCode?.split('.').at(-1);
  const diagnostic = controlledCode ? `（${controlledCode}）` : '';

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
