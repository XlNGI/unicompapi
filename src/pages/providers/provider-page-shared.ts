import type { ProviderTemplateSummaryDto } from '../../shared/provider-ipc';

export type DetailTab = 'models' | 'connection' | 'credential';

export const tabLabels: Record<DetailTab, string> = {
  models: '模型',
  connection: '连接',
  credential: '凭证'
};

export const connectionLabels: Record<string, string> = {
  unconfigured: '未配置',
  saved: '待验证',
  validating: '验证中',
  available: '可用',
  unavailable: '不可用',
  disabled: '已停用',
  deleted: '已删除'
};

export const credentialLabels: Record<string, string> = {
  not_configured: '未配置',
  saved: '已安全保存',
  validating: '验证中',
  valid: '有效',
  invalid: '无效',
  deleted: '已删除',
  verification_unavailable: '无法验证'
};

export const profileLabels: Record<string, string> = {
  declared: '已声明，待验证',
  verified: '已验证',
  restricted: '受限',
  disabled: '已禁用'
};

export function toneForState(state: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (['available', 'valid', 'verified'].includes(state)) return 'success';
  if (['unavailable', 'invalid'].includes(state)) return 'danger';
  if (['saved', 'validating', 'declared'].includes(state)) return 'info';
  if (['unconfigured', 'not_configured', 'restricted'].includes(state)) return 'warning';
  return 'neutral';
}

export function describeError(code: string): string {
  const labels: Record<string, string> = {
    adapter_unavailable: '在线管理适配器尚未获得专项批准',
    free_validation_unavailable: '此供应商没有获批的免费验证，不能在保存时探测连通性',
    connection_validation_failed: '远程连通性验证未通过',
    catalog_sync_unavailable: '此连接不支持目录同步',
    adapter_binding_ambiguous: '当前连接适配器绑定不明确，无法登记模型',
    manual_registration_unavailable: '此连接不支持精确手工登记',
    model_already_exists: '该模型标识已登记',
    connection_not_available: '连接验证通过后才能管理模型',
    model_not_routable: '连接可用且模型仍在目录中时才能启用',
    active_operations_present: '仍有调用使用此连接',
    connection_contract_stale: '这是旧版遗留连接，请删除后重新添加',
    credential_invalid: '凭证字段不完整或格式无效',
    provider_registry_conflict: '注册表已变化，请刷新后重试',
    invalid_request: '当前输入或状态不允许执行此操作'
  };
  if (code.endsWith('_not_found')) return '目标记录不存在，请刷新后重试';
  return labels[code] ?? '操作失败，请重试';
}

export function templateKeyOf(template: ProviderTemplateSummaryDto): string {
  return `${template.packageId} ${template.templateId}`;
}
