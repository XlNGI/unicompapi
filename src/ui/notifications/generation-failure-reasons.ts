export interface GenerationSafeReason {
  readonly label: string;
  readonly recognized: boolean;
  readonly technicalCode?: string;
}

const generationSafeReasonLabels: Readonly<Record<string, string>> = {
  authentication_failed: '服务商鉴权失败',
  credential_unavailable: '服务商凭证不可用',
  credit_insufficient: '服务商余额或调用额度不足',
  account_unavailable: '服务商账户不可用',
  permission_denied: '当前凭证没有调用权限',
  rate_limited: '请求被服务商限流',
  provider_unavailable: '服务商暂时不可用',
  unavailable: '服务商暂时不可用',
  timeout: '服务商响应超时',
  network: '网络连接失败',
  network_error: '网络连接失败',
  offline: '网络连接不可用',
  proxy_unavailable: '代理不可用',
  invalid_request: '请求参数被服务商拒绝',
  request_invalid: '请求参数无效',
  parameter_value_invalid: '生成参数无效',
  invalid_image: '输入图片无效',
  content_filtered: '内容未通过服务商审核',
  response_too_large: '服务商响应数据过大',
  invalid_response: '服务商返回了无效响应',
  invalid_result: '服务商返回的生成结果无效',
  result_reference_invalid: '服务商返回的结果地址无效',
  operation_failed: '服务商执行失败',
  protocol_mismatch: '请求协议不匹配',
  route_mismatch: '服务调用配置不匹配',
  route_contract_mismatch: '服务调用配置不匹配',
  dispatch_request_mismatch: '服务调用配置不匹配',
  endpoint_not_allowed: '目标接口不在允许范围内',
  redirect_not_allowed: '服务商返回了不允许的跳转地址',
  connection_snapshot_unavailable: '服务商连接不可用',
  connection_unavailable: '服务商连接不可用',
  route_snapshot_unavailable: '服务调用配置不可用',
  operation_route_unavailable: '服务调用配置不可用',
  parameter_schema_unavailable: '模型参数定义不可用',
  result_route_unavailable: '结果下载通道不可用',
  cancelled: '服务商已取消任务',
  failed_before_submission: '请求发送前失败',
  failed_before_request: '请求发送前失败',
  invalid_failed_before_request: '请求发送前失败',
  submission_outcome_unknown: '服务商是否收到请求暂时无法确认',
  outcome_unknown: '服务商是否收到请求暂时无法确认',
  recovered_unknown_outcome: '服务商结果暂时无法确认',
  recovered_terminal_fact_incomplete: '服务商终态信息不完整',
  no_matching_policy: '当前请求未取得运行授权',
  claim_failed: '当前请求未取得运行授权'
};

const confirmedFailureCodes = new Set([
  'authentication_failed',
  'credential_unavailable',
  'credit_insufficient',
  'account_unavailable',
  'permission_denied',
  'rate_limited',
  'provider_unavailable',
  'unavailable',
  'proxy_unavailable',
  'invalid_request',
  'request_invalid',
  'parameter_value_invalid',
  'invalid_image',
  'content_filtered',
  'response_too_large',
  'invalid_response',
  'invalid_result',
  'result_reference_invalid',
  'operation_failed',
  'protocol_mismatch',
  'route_mismatch',
  'route_contract_mismatch',
  'dispatch_request_mismatch',
  'endpoint_not_allowed',
  'redirect_not_allowed',
  'connection_snapshot_unavailable',
  'connection_unavailable',
  'route_snapshot_unavailable',
  'operation_route_unavailable',
  'parameter_schema_unavailable',
  'result_route_unavailable',
  'failed_before_submission',
  'failed_before_request',
  'invalid_failed_before_request',
  'no_matching_policy',
  'claim_failed'
]);

export function describeGenerationSafeCode(
  safeCode?: string
): GenerationSafeReason | undefined {
  if (!safeCode) return undefined;
  const normalized = safeCode.split('.').at(-1)?.toLowerCase();
  const label = normalized ? generationSafeReasonLabels[normalized] : undefined;
  return label
    ? { label, recognized: true }
    : {
        label: '未识别的服务商错误',
        recognized: false,
        technicalCode: safeCode
      };
}

export function isUnconfirmedGenerationOutcome(
  status: string | undefined,
  safeCode?: string
): boolean {
  if (status !== 'unknown_outcome' &&
      status !== 'submission_outcome_unknown' &&
      status !== 'cancellation_unknown') return false;
  const normalized = safeCode?.split('.').at(-1)?.toLowerCase();
  return !normalized || !confirmedFailureCodes.has(normalized);
}

export function describeUnconfirmedGenerationOutcome(safeCode?: string): string {
  const normalized = safeCode?.split('.').at(-1)?.toLowerCase();
  if (normalized === 'timeout') {
    return '等待上游响应超时，暂未收到可确认结果';
  }
  if (normalized === 'network' || normalized === 'network_error' || normalized === 'offline') {
    return '与上游的连接已中断，暂未收到可确认结果';
  }
  if (normalized === 'cancelled') {
    return '等待上游响应时请求中断，暂未收到可确认结果';
  }
  return '暂未收到可确认的上游结果';
}
