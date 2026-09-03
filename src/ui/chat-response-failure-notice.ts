import type { MessageDto } from '../shared/chat-context-ipc';

export function failedResponseNotice(
  message?: MessageDto,
  safeCode?: string
): string {
  const partial = Boolean(message?.content.trim());
  const preserved = partial ? '，已保留接收到的内容' : '';
  const diagnostic = safeCode ? `（${safeCode}）` : '';

  if (safeCode?.includes('authentication_failed')) {
    return `服务商鉴权失败${diagnostic}${preserved}。请检查当前模型凭据与权限，或切换模型后重试。`;
  }
  if (safeCode?.includes('finish.content_filter')) {
    return `回答被模型安全策略提前结束${diagnostic}${preserved}。请调整问题后重试。`;
  }
  if (safeCode?.includes('finish.tool_calls')) {
    return `模型请求调用工具，但当前会话未配置该工具${diagnostic}${preserved}。请调整问题后重试。`;
  }
  if (safeCode?.includes('finish.insufficient_system_resource')) {
    return `模型服务资源不足${diagnostic}${preserved}。请稍后重试或切换模型。`;
  }
  if (safeCode?.includes('timeout') || message?.failureReason === 'unknown') {
    return `本地等待模型响应超时${preserved}。远端状态和费用可能已经产生，请先核对服务商后台，避免立即重复发送。`;
  }
  if (message?.failureReason === 'truncated') {
    return `回答达到当前输出长度上限${preserved}。可以继续追问，或调整输出长度后重试。`;
  }
  if (message?.failureReason === 'interrupted') {
    return `模型连接中断${preserved}，请检查网络后重试。`;
  }
  if (message?.failureReason === 'invalid_response') {
    return `模型返回的数据格式异常${preserved}，请重试或切换模型。`;
  }
  if (message?.failureReason === 'unavailable') {
    return `模型连接超时或服务暂时不可用${preserved}，请稍后重试或切换模型。`;
  }
  return `模型请求未正常完成${diagnostic}${preserved}，请重试。`;
}
