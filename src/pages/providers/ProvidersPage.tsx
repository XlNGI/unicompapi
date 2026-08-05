import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  LuCirclePlus,
  LuKeyRound,
  LuRefreshCw,
  LuShieldCheck,
  LuTrash2
} from 'react-icons/lu';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type {
  ProviderFrameworkResult,
  ProviderRegistryDto,
  ProviderTemplateSummaryDto
} from '../../shared/provider-ipc';
import '../../styles/pages.css';

type DetailTab = 'models' | 'connection' | 'credential';

const emptyRegistry: ProviderRegistryDto = {
  providers: [],
  connections: [],
  protocolBindings: [],
  models: [],
  capabilities: [],
  routingPreferences: []
};

const tabLabels: Record<DetailTab, string> = {
  models: '模型',
  connection: '连接',
  credential: '凭证'
};

const connectionLabels: Record<string, string> = {
  unconfigured: '未配置',
  saved: '待验证',
  validating: '验证中',
  available: '可用',
  unavailable: '不可用',
  disabled: '已停用',
  deleted: '已删除'
};

const credentialLabels: Record<string, string> = {
  not_configured: '未配置',
  saved: '已安全保存',
  validating: '验证中',
  valid: '有效',
  invalid: '无效',
  deleted: '已删除',
  verification_unavailable: '无法验证'
};

const profileLabels: Record<string, string> = {
  declared: '已声明，待验证',
  verified: '已验证',
  restricted: '受限',
  disabled: '已禁用'
};

function toneForState(state: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (['available', 'valid', 'verified'].includes(state)) return 'success';
  if (['unavailable', 'invalid'].includes(state)) return 'danger';
  if (['saved', 'validating', 'declared'].includes(state)) return 'info';
  if (['unconfigured', 'not_configured', 'restricted'].includes(state)) return 'warning';
  return 'neutral';
}

function describeError(code: string): string {
  const labels: Record<string, string> = {
    adapter_unavailable: '在线管理适配器尚未获得专项批准',
    free_validation_unavailable: '此连接没有获批的免费验证操作',
    connection_validation_failed: '远程连通性验证未通过',
    catalog_sync_unavailable: '此连接不支持目录同步',
    manual_registration_unavailable: '此连接不支持精确手工登记',
    connection_not_available: '连接验证通过后才能管理模型',
    model_not_routable: '只有精确 Profile 已验证的当前模型才能启用',
    active_operations_present: '仍有调用使用此连接',
    credential_invalid: '凭证字段不完整或格式无效',
    provider_registry_conflict: '注册表已变化，请刷新后重试',
    invalid_request: '当前输入或状态不允许执行此操作'
  };
  if (code.endsWith('_not_found')) return '目标记录不存在，请刷新后重试';
  return labels[code] ?? '操作失败，请重试';
}

function describeValidationSafeCode(safeCode: string): string {
  const labels: Record<string, string> = {
    authentication_failed: '凭证无效或已过期',
    endpoint_not_allowed: '接口地址不被允许',
    network: '网络连接失败',
    timeout: '连接超时',
    proxy_unavailable: '代理不可用',
    response_too_large: '远程响应过大',
    invalid_response: '远程响应格式无效',
    protocol_mismatch: '协议不匹配',
    unavailable: '远程服务不可用'
  };
  return labels[safeCode] ?? safeCode;
}

const addProgressLabels: Record<string, string> = {
  validating: '正在测试远程连通性…',
  saving: '正在保存连接与凭证…',
  syncing: '正在获取模型目录…'
};

function describeAddOutcome(value: {
  readonly validated: boolean;
  readonly state: string;
  readonly catalog: 'synced' | 'skipped' | 'failed';
  readonly catalogCount?: number;
}): string {
  if (!value.validated) return '连接和凭证已安全保存，尚未发起在线验证';
  if (value.state === 'unavailable') return '连接已保存为不可用状态；可修正凭证后重新验证';
  if (value.catalog === 'synced') return `连接已验证并保存；已同步 ${value.catalogCount ?? 0} 个模型`;
  if (value.catalog === 'failed') return '连接已验证并保存；模型目录获取失败，可稍后在管理页重试';
  return '连接已验证并保存';
}

export function ProvidersPage() {
  const providersApi = window.unicomp?.providers;
  const [registry, setRegistry] = useState<ProviderRegistryDto>(emptyRegistry);
  const [templates, setTemplates] = useState<readonly ProviderTemplateSummaryDto[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [activeTab, setActiveTab] = useState<DetailTab>('models');
  const [connectionFilter, setConnectionFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [addingConnection, setAddingConnection] = useState(false);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [newCredentials, setNewCredentials] = useState<Record<string, string>>({});
  const [replacementCredentials, setReplacementCredentials] =
    useState<Record<string, string>>({});
  const [modelKey, setModelKey] = useState('');
  const [modelDisplayName, setModelDisplayName] = useState('');

  async function refreshRegistry(preferredConnectionId?: string) {
    if (!providersApi) return;
    const result = await providersApi.getRegistry();
    if (!result.ok) {
      setMessage('无法读取本地服务商注册表');
      return;
    }
    setRegistry(result.value);
    const preferred = preferredConnectionId ?? selectedConnectionId;
    const next = result.value.connections.find((item) => item.connectionId === preferred)
      ?? result.value.connections.find((item) => item.state !== 'deleted')
      ?? result.value.connections[0];
    setSelectedConnectionId(next?.connectionId ?? '');
  }

  useEffect(() => {
    let active = true;
    if (!providersApi) {
      setMessage('当前运行环境未连接桌面服务商能力');
      setLoading(false);
      return () => { active = false; };
    }
    void Promise.all([providersApi.getRegistry(), providersApi.listTemplates()])
      .then(([registryResult, templateResult]) => {
        if (!active) return;
        if (!registryResult.ok || !templateResult.ok) {
          setMessage('无法读取本地服务商配置');
          return;
        }
        setRegistry(registryResult.value);
        setTemplates(templateResult.value);
        const first = registryResult.value.connections.find((item) => item.state !== 'deleted')
          ?? registryResult.value.connections[0];
        setSelectedConnectionId(first?.connectionId ?? '');
      })
      .catch(() => {
        if (active) setMessage('读取本地服务商配置失败，请重试');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [providersApi]);

  const selectedConnection = registry.connections.find(
    (item) => item.connectionId === selectedConnectionId
  );
  const selectedProvider = registry.providers.find(
    (item) => item.providerId === selectedConnection?.providerId
  );
  const selectedTemplate = templates.find((template) =>
    template.packageId === selectedConnection?.packageId &&
    template.templateId === selectedConnection?.templateId
  );
  const connectionModels = registry.models.filter(
    (item) => item.connectionId === selectedConnectionId
  );
  const selectedModel = connectionModels.find((item) => item.modelId === selectedModelId)
    ?? connectionModels[0];
  const createTemplate = templates.find(
    (template) => `${template.packageId}\u0000${template.templateId}` === selectedTemplateKey
  );

  useEffect(() => {
    setSelectedModelId(connectionModels[0]?.modelId ?? '');
    setReplacementCredentials({});
  }, [selectedConnectionId]);

  const visibleConnections = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('zh-CN');
    return registry.connections.filter((connection) => {
      const provider = registry.providers.find((item) => item.providerId === connection.providerId);
      const matchesFilter = connectionFilter === 'all' ||
        (connectionFilter === 'problem'
          ? ['unavailable', 'unconfigured', 'saved'].includes(connection.state)
          : connection.state === connectionFilter);
      const matchesSearch = !term || connection.name.toLocaleLowerCase('zh-CN').includes(term) ||
        provider?.name.toLocaleLowerCase('zh-CN').includes(term);
      return matchesFilter && matchesSearch;
    });
  }, [connectionFilter, registry.connections, registry.providers, search]);

  async function runAction<T>(
    action: () => Promise<ProviderFrameworkResult<T>>,
    successMessage: string,
    preferredConnectionId?: string
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setMessage('');
    try {
      const result = await action();
      if (!result.ok) {
        setMessage(describeError(result.error.code));
        return false;
      }
      setMessage(successMessage);
      await refreshRegistry(preferredConnectionId);
      return true;
    } catch {
      setMessage('操作失败，请重试');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openCreate(kind: ProviderTemplateSummaryDto['kind']) {
    const template = templates.find((item) => item.kind === kind);
    setSelectedTemplateKey(template ? `${template.packageId}\u0000${template.templateId}` : '');
    setConnectionName('');
    setEndpoint('');
    setNewCredentials({});
    setAddingConnection(true);
  }

  async function handleCreateConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providersApi || !createTemplate || !connectionName.trim() || busy) return;
    const input = {
      packageId: createTemplate.packageId,
      templateId: createTemplate.templateId,
      name: connectionName.trim(),
      ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
      credentials: newCredentials
    };
    setBusy(true);
    try {
      let allowUnavailableSave = false;
      for (;;) {
        setMessage('');
        const unsubscribe = providersApi.onAddConnectionProgress((step) => {
          setMessage(addProgressLabels[step] ?? '正在处理…');
        });
        let result;
        try {
          result = await providersApi.addConnection({ ...input, allowUnavailableSave });
        } finally {
          unsubscribe();
        }
        if (!result.ok) {
          if (result.error.code === 'connection_validation_failed' && !allowUnavailableSave) {
            allowUnavailableSave = window.confirm(
              `远程连通性验证未通过（${describeValidationSafeCode(result.error.message)}）。\n仍要将此连接保存为「不可用」状态吗？`
            );
            if (allowUnavailableSave) continue;
            setMessage('连接未保存');
            return;
          }
          setMessage(describeError(result.error.code));
          return;
        }
        setMessage(describeAddOutcome(result.value));
        await refreshRegistry(result.value.connectionId);
        setAddingConnection(false);
        setNewCredentials({});
        return;
      }
    } catch {
      setMessage('操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  async function handleRotateCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providersApi || !selectedConnection) return;
    const saved = await runAction(
      () => providersApi.rotateCredential(
        selectedConnection.connectionId,
        replacementCredentials
      ),
      '新凭证已写入本机安全存储，连接需要重新验证',
      selectedConnection.connectionId
    );
    if (saved) setReplacementCredentials({});
  }

  async function handleRegisterModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providersApi || !selectedConnection || !modelKey.trim() || !modelDisplayName.trim()) {
      return;
    }
    const saved = await runAction(
      () => providersApi.registerExactModel(
        selectedConnection.connectionId,
        modelKey.trim(),
        modelDisplayName.trim()
      ),
      '模型已精确登记；没有 Profile 前不会进入候选',
      selectedConnection.connectionId
    );
    if (saved) {
      setModelKey('');
      setModelDisplayName('');
    }
  }

  async function handleDeleteConnection() {
    if (!providersApi || !selectedConnection || busy) return;
    if (!window.confirm('删除本地连接及当前凭证，同时保留历史调用与作品记录。继续吗？')) {
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      let result = await providersApi.deleteConnection(selectedConnection.connectionId);
      if (!result.ok && result.error.code === 'active_operations_present') {
        const abandon = window.confirm('此连接仍有活动调用。确认放弃这些调用的继续访问权限吗？');
        if (!abandon) {
          setMessage('连接未删除');
          return;
        }
        result = await providersApi.deleteConnection(selectedConnection.connectionId, true);
      }
      if (!result.ok) {
        setMessage(describeError(result.error.code));
        return;
      }
      setMessage('本地连接已删除；历史调用与作品记录已保留');
      await refreshRegistry();
    } catch {
      setMessage('删除连接失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  const availableCount = registry.connections.filter((item) => item.state === 'available').length;
  const problemCount = registry.connections.filter(
    (item) => ['unavailable', 'unconfigured', 'saved'].includes(item.state)
  ).length;

  return (
    <section className="uc-provider-page" aria-labelledby="providers-page-title">
      <header className="uc-provider-page__header">
        <div>
          <div className="uc-page-skeleton__heading-row">
            <h1 className="uc-page-skeleton__title" id="providers-page-title">模型与服务商</h1>
            <StatusPill tone={providersApi ? 'info' : 'warning'}>
              {providersApi ? '本地管理' : '桌面能力未连接'}
            </StatusPill>
          </div>
          <p className="uc-page-skeleton__description">连接、凭证、目录与模型状态</p>
        </div>
        <div className="uc-provider-page__header-actions">
          <Button disabled={!providersApi || busy} onClick={() => openCreate('official')}>
            <LuCirclePlus aria-hidden="true" /> 官方连接
          </Button>
          <Button disabled={!providersApi || busy} onClick={() => openCreate('compatible_custom')} variant="secondary">
            <LuCirclePlus aria-hidden="true" /> 兼容连接
          </Button>
          <Button aria-label="刷新服务商状态" disabled={!providersApi || busy} onClick={() => void refreshRegistry()} variant="ghost">
            <LuRefreshCw aria-hidden="true" /> 刷新
          </Button>
        </div>
      </header>

      <Card className="uc-provider-page__notice">
        <LuShieldCheck aria-hidden="true" />
        <strong>本机安全存储</strong>
        <span>凭证不回显；保存连接时将自动测试远程连通性，通过后自动获取可用模型目录。</span>
      </Card>

      {message && <p className="uc-provider-page__message" role="status">{message}</p>}

      {addingConnection && (
        <Card className="uc-provider-page__form-card" raised>
          <form onSubmit={handleCreateConnection}>
            <div className="uc-provider-page__section-heading">
              <div>
                <h2>添加服务连接</h2>
                <p>{createTemplate?.kind === 'official' ? '官方模板' : '兼容协议模板'}</p>
              </div>
              <Button disabled={busy} onClick={() => setAddingConnection(false)} variant="ghost">取消</Button>
            </div>
            <div className="uc-provider-page__form-grid">
              <label>
                接入模板
                <select
                  onChange={(event) => {
                    setSelectedTemplateKey(event.target.value);
                    setEndpoint('');
                    setNewCredentials({});
                  }}
                  required
                  value={selectedTemplateKey}
                >
                  {templates
                    .filter((item) => item.kind === createTemplate?.kind)
                    .map((template) => (
                      <option key={`${template.packageId}:${template.templateId}`} value={`${template.packageId}\u0000${template.templateId}`}>
                        {template.providerName} · {template.displayName}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                连接名称
                <input maxLength={200} onChange={(event) => setConnectionName(event.target.value)} required value={connectionName} />
              </label>
              {createTemplate?.baseUrlMode !== 'fixed' && (
                <label>
                  接口地址{createTemplate?.baseUrlMode === 'required' ? '' : '（可选）'}
                  <input onChange={(event) => setEndpoint(event.target.value)} required={createTemplate?.baseUrlMode === 'required'} type="url" value={endpoint} />
                </label>
              )}
              {createTemplate?.credentialFields.map((field) => (
                <label key={field.key}>
                  {field.label}
                  <input
                    autoComplete="new-password"
                    maxLength={65536}
                    onChange={(event) => setNewCredentials((current) => ({ ...current, [field.key]: event.target.value }))}
                    required={field.required}
                    type={field.secret ? 'password' : 'text'}
                    value={newCredentials[field.key] ?? ''}
                  />
                </label>
              ))}
            </div>
            <Button disabled={busy || !createTemplate || !connectionName.trim()} type="submit">
              {busy ? '正在保存…' : '保存连接'}
            </Button>
          </form>
        </Card>
      )}

      {loading ? (
        <EmptyState busy description="正在读取本地服务商配置。" icon="载" role="status" title="正在读取" />
      ) : registry.connections.length === 0 ? (
        <EmptyState
          action={<Button disabled={!providersApi} onClick={() => openCreate('official')} variant="secondary">添加连接</Button>}
          description="当前没有服务连接。"
          icon="模"
          title="还没有服务连接"
        />
      ) : (
        <div className="uc-provider-page__workspace">
          <aside className="uc-provider-page__connections" aria-label="服务连接列表">
            <div className="uc-provider-page__panel-heading">
              <div><h2>服务连接</h2><p>{availableCount} 可用 · {problemCount} 待处理</p></div>
            </div>
            <input aria-label="搜索连接或服务商" className="uc-provider-page__search" onChange={(event) => setSearch(event.target.value)} placeholder="搜索" type="search" value={search} />
            <div className="uc-provider-page__filters" aria-label="连接状态筛选">
              {[
                ['all', '全部'],
                ['available', '可用'],
                ['disabled', '停用'],
                ['problem', '待处理']
              ].map(([value, label]) => (
                <button aria-pressed={connectionFilter === value} key={value} onClick={() => setConnectionFilter(value)} type="button">{label}</button>
              ))}
            </div>
            <div className="uc-provider-page__connection-list">
              {visibleConnections.map((connection) => {
                const provider = registry.providers.find((item) => item.providerId === connection.providerId);
                return (
                  <button
                    aria-pressed={selectedConnectionId === connection.connectionId}
                    className="uc-provider-page__connection"
                    key={connection.connectionId}
                    onClick={() => setSelectedConnectionId(connection.connectionId)}
                    type="button"
                  >
                    <span className="uc-provider-page__connection-icon" aria-hidden="true">{(provider?.name ?? connection.name).slice(0, 1)}</span>
                    <span>
                      <strong>{connection.name}</strong>
                      <small>{provider?.name ?? '未知服务商'}</small>
                      <StatusPill tone={toneForState(connection.state)}>{connectionLabels[connection.state] ?? '未知'}</StatusPill>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="uc-provider-page__details" aria-label="连接详情">
            {!selectedConnection ? (
              <EmptyState description="请从左侧选择连接。" icon="连" title="未选择连接" />
            ) : (
              <>
                <div className="uc-provider-page__detail-heading">
                  <div>
                    <span className="uc-provider-page__eyebrow">{selectedTemplate?.kind === 'compatible_custom' ? '兼容连接' : '官方连接'}</span>
                    <h2>{selectedConnection.name}</h2>
                    <p>{selectedProvider?.name ?? selectedTemplate?.providerName ?? '未知服务商'}</p>
                  </div>
                  <div className="uc-provider-page__header-actions">
                    <StatusPill tone={toneForState(selectedConnection.state)}>{connectionLabels[selectedConnection.state] ?? '未知'}</StatusPill>
                    {selectedConnection.state !== 'deleted' && (
                      <Button
                        disabled={busy}
                        onClick={() => providersApi && void runAction(
                          () => providersApi.setConnectionEnabled(selectedConnection.connectionId, selectedConnection.state === 'disabled'),
                          selectedConnection.state === 'disabled' ? '连接已启用，验证状态保持独立' : '连接已停用',
                          selectedConnection.connectionId
                        )}
                        variant="secondary"
                      >
                        {selectedConnection.state === 'disabled' ? '启用' : '停用'}
                      </Button>
                    )}
                  </div>
                </div>

                <nav className="uc-provider-page__tabs" aria-label="连接详情区域">
                  {(Object.keys(tabLabels) as DetailTab[]).map((tab) => (
                    <button aria-current={activeTab === tab ? 'page' : undefined} key={tab} onClick={() => setActiveTab(tab)} type="button">{tabLabels[tab]}</button>
                  ))}
                </nav>

                {activeTab === 'models' && (
                  <section className="uc-provider-page__tab-panel" aria-labelledby="models-heading">
                    <div className="uc-provider-page__section-heading">
                      <div><h3 id="models-heading">模型目录</h3><p>{selectedTemplate?.displayName ?? '历史连接'}</p></div>
                      <div className="uc-provider-page__header-actions">
                        <Button
                          disabled={busy || selectedTemplate?.validationAction !== 'available'}
                          onClick={() => providersApi && void runAction(
                            () => providersApi.validateConnection(selectedConnection.connectionId),
                            '连接验证已完成',
                            selectedConnection.connectionId
                          )}
                          title={selectedTemplate?.validationAction === 'requires_live_api_approval' ? '等待真实 API 专项批准' : undefined}
                          variant="secondary"
                        >
                          <LuShieldCheck aria-hidden="true" /> 验证连接
                        </Button>
                        <Button
                          disabled={busy || selectedTemplate?.modelDiscoveryAction !== 'catalog_available'}
                          onClick={() => providersApi && void runAction(
                            () => providersApi.syncModelCatalog(selectedConnection.connectionId),
                            '模型目录已同步',
                            selectedConnection.connectionId
                          )}
                          title={selectedTemplate?.modelDiscoveryAction === 'requires_live_api_approval' ? '等待真实 API 专项批准' : undefined}
                          variant="secondary"
                        >
                          <LuRefreshCw aria-hidden="true" /> 同步目录
                        </Button>
                      </div>
                    </div>

                    {selectedConnection.state === 'available' && (
                      <form className="uc-provider-page__inline-form" onSubmit={handleRegisterModel}>
                        <label>精确模型标识<input maxLength={500} onChange={(event) => setModelKey(event.target.value)} required value={modelKey} /></label>
                        <label>显示名称<input maxLength={200} onChange={(event) => setModelDisplayName(event.target.value)} required value={modelDisplayName} /></label>
                        <Button disabled={busy || !modelKey.trim() || !modelDisplayName.trim()} type="submit">登记</Button>
                      </form>
                    )}

                    {connectionModels.length === 0 ? (
                      <EmptyState description="当前连接没有已登记模型。" icon="型" title="模型目录为空" />
                    ) : (
                      <div className="uc-provider-page__model-list">
                        {connectionModels.map((model) => (
                          <div className="uc-provider-page__model" data-selected={selectedModel?.modelId === model.modelId || undefined} key={model.modelId}>
                            <button aria-pressed={selectedModel?.modelId === model.modelId} className="uc-provider-page__model-select" onClick={() => setSelectedModelId(model.modelId)} type="button">
                              <span><strong>{model.displayName}</strong><small>{model.providerModelKey}</small></span>
                              <span>{model.profileStatus ? profileLabels[model.profileStatus] : '无 Profile'}</span>
                            </button>
                            <StatusPill tone={model.enabled ? 'success' : 'neutral'}>{model.enabled ? '已启用' : '已停用'}</StatusPill>
                            <label className="uc-provider-page__switch">
                              <input
                                aria-label={`${model.displayName}启用状态`}
                                checked={model.enabled}
                                disabled={busy || selectedConnection.state === 'deleted'}
                                onChange={() => providersApi && void runAction(
                                  () => providersApi.setModelEnabled(model.modelId, !model.enabled),
                                  model.enabled ? '模型已停用' : '模型已启用',
                                  selectedConnection.connectionId
                                )}
                                type="checkbox"
                              />
                              <span aria-hidden="true" />
                            </label>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )}

                {activeTab === 'connection' && (
                  <section className="uc-provider-page__tab-panel" aria-labelledby="connection-heading">
                    <div className="uc-provider-page__section-heading"><div><h3 id="connection-heading">连接状态</h3><p>{selectedTemplate?.displayName ?? '历史连接'}</p></div></div>
                    <dl className="uc-provider-page__facts">
                      <div><dt>连接</dt><dd>{connectionLabels[selectedConnection.state] ?? '未知'}</dd></div>
                      <div><dt>身份</dt><dd>{selectedConnection.identityState === 'verified' ? '已验证' : '未验证'}</dd></div>
                      <div><dt>接口地址</dt><dd>{selectedConnection.endpointConfigured ? '已配置并隐藏' : '使用模板固定地址'}</dd></div>
                      <div><dt>最近验证</dt><dd>{selectedConnection.lastConnectionValidationAt ? new Date(selectedConnection.lastConnectionValidationAt).toLocaleString('zh-CN') : '无记录'}</dd></div>
                    </dl>
                    {selectedConnection.state !== 'deleted' && (
                      <Button disabled={busy} onClick={() => void handleDeleteConnection()} variant="ghost">
                        <LuTrash2 aria-hidden="true" /> 删除本地连接
                      </Button>
                    )}
                  </section>
                )}

                {activeTab === 'credential' && (
                  <section className="uc-provider-page__tab-panel" aria-labelledby="credential-heading">
                    <div className="uc-provider-page__section-heading">
                      <div><h3 id="credential-heading">凭证</h3><p>本机安全存储，不提供明文读取</p></div>
                      <StatusPill tone={toneForState(selectedConnection.credentialState)}>{credentialLabels[selectedConnection.credentialState] ?? '未知'}</StatusPill>
                    </div>
                    {selectedTemplate ? (
                      <form className="uc-provider-page__stack-form" onSubmit={handleRotateCredential}>
                        {selectedTemplate.credentialFields.map((field) => (
                          <label key={field.key}>
                            {field.label}
                            <input
                              autoComplete="new-password"
                              maxLength={65536}
                              onChange={(event) => setReplacementCredentials((current) => ({ ...current, [field.key]: event.target.value }))}
                              required={field.required}
                              type={field.secret ? 'password' : 'text'}
                              value={replacementCredentials[field.key] ?? ''}
                            />
                          </label>
                        ))}
                        <Button disabled={busy || selectedConnection.state === 'deleted'} type="submit">
                          <LuKeyRound aria-hidden="true" /> 替换凭证
                        </Button>
                      </form>
                    ) : <p className="uc-provider-page__muted">历史连接缺少可用的结构化凭证模板。</p>}
                  </section>
                )}
              </>
            )}
          </section>

          <aside className="uc-provider-page__capabilities" aria-label="模型概要">
            <div className="uc-provider-page__panel-heading"><div><h2>模型概要</h2><p>精确 Profile 投影</p></div></div>
            {!selectedModel ? (
              <EmptyState description="从模型目录选择模型。" icon="能" title="未选择模型" />
            ) : (
              <>
                <Card className="uc-provider-page__selected-model">
                  <div><strong>{selectedModel.displayName}</strong><small>{selectedModel.providerModelKey}</small></div>
                  <StatusPill tone={toneForState(selectedModel.profileStatus ?? 'unknown')}>{selectedModel.profileStatus ? profileLabels[selectedModel.profileStatus] : '无 Profile'}</StatusPill>
                </Card>
                <section className="uc-provider-page__capability-section">
                  <h3>产品功能</h3>
                  {selectedModel.productFeatures?.length ? selectedModel.productFeatures.map((feature) => (
                    <div className="uc-provider-page__capability" key={feature}><span>{feature}</span><StatusPill tone="info">Profile</StatusPill></div>
                  )) : <p>没有可公开的精确功能 Profile。</p>}
                </section>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
