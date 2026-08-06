import { useEffect, useMemo } from 'react';
import type { FormEvent } from 'react';
import { LuKeyRound, LuRefreshCw, LuShieldCheck, LuTrash2 } from 'react-icons/lu';
import { Input, Toggle } from 'rsuite';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type {
  ProviderApi,
  ProviderFrameworkResult,
  ProviderRegistryDto,
  ProviderTemplateSummaryDto
} from '../../shared/provider-ipc';
import {
  connectionLabels,
  credentialLabels,
  profileLabels,
  tabLabels,
  toneForState,
  type DetailTab
} from './provider-page-shared';

export interface ProviderManageViewProps {
  readonly providersApi: ProviderApi | undefined;
  readonly registry: ProviderRegistryDto;
  readonly templates: readonly ProviderTemplateSummaryDto[];
  readonly busy: boolean;
  readonly selectedConnectionId: string;
  readonly onSelectConnection: (connectionId: string) => void;
  readonly selectedModelId: string;
  readonly onSelectModel: (modelId: string) => void;
  readonly activeTab: DetailTab;
  readonly onSelectTab: (tab: DetailTab) => void;
  readonly connectionFilter: string;
  readonly onConnectionFilterChange: (value: string) => void;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly modelKey: string;
  readonly onModelKeyChange: (value: string) => void;
  readonly modelDisplayName: string;
  readonly onModelDisplayNameChange: (value: string) => void;
  readonly replacementCredentials: Record<string, string>;
  readonly onReplacementCredentialChange: (fieldKey: string, value: string) => void;
  readonly onResetReplacementCredentials: () => void;
  readonly runAction: <T>(
    action: () => Promise<ProviderFrameworkResult<T>>,
    successMessage: string,
    preferredConnectionId?: string
  ) => Promise<boolean>;
  readonly onRegisterModel: (event: FormEvent<HTMLFormElement>) => void;
  readonly onRotateCredential: (event: FormEvent<HTMLFormElement>) => void;
  readonly onDeleteModel: (modelId: string) => void;
  readonly onDeleteConnection: () => void;
  readonly onGoGallery: () => void;
}

export function ProviderManageView({
  providersApi,
  registry,
  templates,
  busy,
  selectedConnectionId,
  onSelectConnection,
  selectedModelId,
  onSelectModel,
  activeTab,
  onSelectTab,
  connectionFilter,
  onConnectionFilterChange,
  search,
  onSearchChange,
  modelKey,
  onModelKeyChange,
  modelDisplayName,
  onModelDisplayNameChange,
  replacementCredentials,
  onReplacementCredentialChange,
  onResetReplacementCredentials,
  runAction,
  onRegisterModel,
  onRotateCredential,
  onDeleteModel,
  onDeleteConnection,
  onGoGallery
}: ProviderManageViewProps) {
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

  useEffect(() => {
    onSelectModel(connectionModels[0]?.modelId ?? '');
    onResetReplacementCredentials();
    // connectionModels derived from registry; selection resets follow the connection id
  }, [selectedConnectionId]);

  const visibleConnections = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('zh-CN');
    return registry.connections.filter((connection) => {
      if (connection.state === 'deleted') return false;
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

  const availableCount = registry.connections.filter((item) => item.state === 'available').length;
  const problemCount = registry.connections.filter(
    (item) => ['unavailable', 'unconfigured', 'saved'].includes(item.state)
  ).length;

  if (registry.connections.every((connection) => connection.state === 'deleted')) {
    return (
      <EmptyState
        action={<Button disabled={!providersApi} onClick={onGoGallery} variant="secondary">去画廊添加</Button>}
        description="当前没有服务连接。"
        icon="模"
        title="还没有服务连接"
      />
    );
  }

  return (
    <div className="uc-provider-page__workspace">
      <aside className="uc-provider-page__connections" aria-label="服务连接列表">
        <div className="uc-provider-page__panel-heading">
          <div><h2>服务连接</h2><p>{availableCount} 可用 · {problemCount} 待处理</p></div>
        </div>
        <Input aria-label="搜索连接或服务商" className="uc-provider-page__search" onChange={(value) => onSearchChange(value)} placeholder="搜索" type="search" value={search} />
        <div className="uc-provider-page__filters" aria-label="连接状态筛选">
          {[
            ['all', '全部'],
            ['available', '可用'],
            ['disabled', '停用'],
            ['problem', '待处理']
          ].map(([value, label]) => (
            <button aria-pressed={connectionFilter === value} key={value} onClick={() => onConnectionFilterChange(value)} type="button">{label}</button>
          ))}
        </div>
        <div className="uc-provider-page__connection-list">
          {visibleConnections.length === 0 ? (
            <p className="uc-provider-page__muted">当前筛选下没有连接。</p>
          ) : visibleConnections.map((connection) => {
            const provider = registry.providers.find((item) => item.providerId === connection.providerId);
            return (
              <button
                aria-pressed={selectedConnectionId === connection.connectionId}
                className="uc-provider-page__connection"
                key={connection.connectionId}
                onClick={() => onSelectConnection(connection.connectionId)}
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
                {selectedConnection.state !== 'deleted' && (
                  <Button disabled={busy} onClick={onDeleteConnection} variant="ghost">
                    <LuTrash2 aria-hidden="true" /> 删除
                  </Button>
                )}
              </div>
            </div>

            <nav className="uc-provider-page__tabs" aria-label="连接详情区域">
              {(Object.keys(tabLabels) as DetailTab[]).map((tab) => (
                <button aria-current={activeTab === tab ? 'page' : undefined} key={tab} onClick={() => onSelectTab(tab)} type="button">{tabLabels[tab]}</button>
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
                  <form className="uc-provider-page__inline-form" onSubmit={onRegisterModel}>
                    <div className="uc-provider-page__manual-model-copy">
                      <strong>手动登记模型</strong>
                      <small>目录同步失败或没有自动列出时，可填写远端模型标识直接登记。</small>
                    </div>
                    <label>精确模型标识<Input maxLength={500} onChange={(value) => onModelKeyChange(value)} placeholder="例如 gpt-4o" required value={modelKey} /></label>
                    <label>显示名称<Input maxLength={200} onChange={(value) => onModelDisplayNameChange(value)} placeholder="界面显示名" required value={modelDisplayName} /></label>
                    <Button disabled={busy || !modelKey.trim() || !modelDisplayName.trim()} type="submit">登记模型</Button>
                  </form>
                )}

                {connectionModels.length === 0 ? (
                  <EmptyState
                    description={selectedConnection.state === 'available'
                      ? '自动目录为空时可在上方手动登记精确模型标识。'
                      : '当前连接没有已登记模型。'}
                    icon="型"
                    title="模型目录为空"
                  />
                ) : (
                  <div className="uc-provider-page__model-list">
                    {connectionModels.map((model) => (
                      <div className="uc-provider-page__model" data-selected={selectedModel?.modelId === model.modelId || undefined} key={model.modelId}>
                        <button aria-pressed={selectedModel?.modelId === model.modelId} className="uc-provider-page__model-select" onClick={() => onSelectModel(model.modelId)} type="button">
                          <span><strong>{model.displayName}</strong><small>{model.providerModelKey}</small></span>
                          <span>{model.profileStatus ? profileLabels[model.profileStatus] : '无 Profile'}</span>
                        </button>
                        <StatusPill tone={model.enabled ? 'success' : 'neutral'}>{model.enabled ? '已启用' : '已停用'}</StatusPill>
                        <Toggle
                          aria-label={`${model.displayName}启用状态`}
                          checked={model.enabled}
                          disabled={busy || selectedConnection.state === 'deleted'}
                          onChange={() => providersApi && void runAction(
                            () => providersApi.setModelEnabled(model.modelId, !model.enabled),
                            model.enabled ? '模型已停用' : '模型已启用',
                            selectedConnection.connectionId
                          )}
                        />
                        <Button
                          aria-label={`删除模型 ${model.displayName}`}
                          disabled={busy || selectedConnection.state === 'deleted'}
                          onClick={() => onDeleteModel(model.modelId)}
                          variant="ghost"
                        >
                          <LuTrash2 aria-hidden="true" /> 删除
                        </Button>
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
              </section>
            )}

            {activeTab === 'credential' && (
              <section className="uc-provider-page__tab-panel" aria-labelledby="credential-heading">
                <div className="uc-provider-page__section-heading">
                  <div><h3 id="credential-heading">凭证</h3><p>本机安全存储，不提供明文读取</p></div>
                  <StatusPill tone={toneForState(selectedConnection.credentialState)}>{credentialLabels[selectedConnection.credentialState] ?? '未知'}</StatusPill>
                </div>
                {selectedTemplate ? (
                  <form className="uc-provider-page__stack-form" onSubmit={onRotateCredential}>
                    {selectedTemplate.credentialFields.map((field) => (
                      <label key={field.key}>
                        {field.label}
                        <Input
                          autoComplete="new-password"
                          maxLength={65536}
                          onChange={(value) => onReplacementCredentialChange(field.key, value)}
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
          <EmptyState description="从模型目录选择模型。" icon="模" title="未选择模型" />
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
  );
}
