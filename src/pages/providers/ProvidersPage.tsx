import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { LuRefreshCw, LuShieldCheck } from 'react-icons/lu';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type {
  ProviderFrameworkResult,
  ProviderRegistryDto,
  ProviderTemplateSummaryDto
} from '../../shared/provider-ipc';
import { ProviderGalleryView } from './ProviderGalleryView';
import { ProviderManageView } from './ProviderManageView';
import { describeError, templateKeyOf, type DetailTab } from './provider-page-shared';
import '../../styles/pages.css';

const emptyRegistry: ProviderRegistryDto = {
  providers: [],
  connections: [],
  protocolBindings: [],
  models: [],
  capabilities: [],
  routingPreferences: []
};

type ProviderPageView = 'gallery' | 'manage';

function describeValidationSafeCode(safeCode: string): string {
  const normalized = safeCode.replace(/^(?:newapi|deepseek|kling|volcengine|vidu)\./u, '');
  const labels: Record<string, string> = {
    authentication_failed: '凭证无效或已过期',
    endpoint_not_allowed: '接口地址不被允许',
    network: '网络连接失败',
    network_error: '网络连接失败',
    timeout: '连接超时',
    proxy_unavailable: '代理不可用',
    response_too_large: '远程响应过大',
    invalid_response: '远程响应格式无效',
    protocol_mismatch: '协议不匹配',
    operation_failed: '远程验证失败',
    unavailable: '远程服务不可用'
  };
  return labels[normalized] ?? labels[safeCode] ?? safeCode;
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
  const [view, setView] = useState<ProviderPageView>('gallery');
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [activeTab, setActiveTab] = useState<DetailTab>('models');
  const [connectionFilter, setConnectionFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
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

  const createTemplate = templates.find(
    (template) => templateKeyOf(template) === selectedTemplateKey
  );

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

  function openCreateForTemplate(templateKey: string) {
    setSelectedTemplateKey(templateKey);
    setConnectionName('');
    setEndpoint('');
    setNewCredentials({});
    setMessage('');
    setAddingConnection(true);
    setView('gallery');
  }

  function leaveAddConnection() {
    setAddingConnection(false);
    setMessage('');
  }

  function openManageForTemplate(templateKey: string) {
    const template = templates.find((item) => templateKeyOf(item) === templateKey);
    const connection = template && registry.connections.find((item) =>
      item.packageId === template.packageId &&
      item.templateId === template.templateId &&
      item.state !== 'deleted'
    );
    if (connection) setSelectedConnectionId(connection.connectionId);
    setAddingConnection(false);
    setView('manage');
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
            leaveAddConnection();
            return;
          }
          setMessage(describeError(result.error.code));
          return;
        }
        setMessage(describeAddOutcome(result.value));
        await refreshRegistry(result.value.connectionId);
        setAddingConnection(false);
        setNewCredentials({});
        setView('manage');
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
    if (!providersApi || !selectedConnectionId) return;
    const rotated = await runAction(
      () => providersApi.rotateCredential(selectedConnectionId, replacementCredentials),
      '凭证已替换，连接状态保持独立',
      selectedConnectionId
    );
    if (rotated) setReplacementCredentials({});
  }

  async function handleRegisterModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providersApi || !selectedConnectionId) return;
    const registered = await runAction(
      () => providersApi.registerExactModel(selectedConnectionId, modelKey.trim(), modelDisplayName.trim()),
      '模型已精确登记；未创建 Profile',
      selectedConnectionId
    );
    if (registered) {
      setModelKey('');
      setModelDisplayName('');
    }
  }

  async function handleDeleteConnection() {
    if (!providersApi) return;
    const selectedConnection = registry.connections.find(
      (item) => item.connectionId === selectedConnectionId
    );
    if (!selectedConnection || busy) return;
    setBusy(true);
    setMessage('');
    try {
      let result = await providersApi.deleteConnection(selectedConnection.connectionId, false);
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
          <p className="uc-page-skeleton__description">画廊添加连接，管理视图维护目录、凭证与状态</p>
        </div>
        <div className="uc-provider-page__header-actions">
          <div className="uc-provider-page__view-switch" aria-label="页面视图">
            <button aria-pressed={view === 'gallery' && !addingConnection} onClick={() => { leaveAddConnection(); setView('gallery'); }} type="button">供应商画廊</button>
            <button aria-pressed={view === 'manage' && !addingConnection} onClick={() => { leaveAddConnection(); setView('manage'); }} type="button">连接管理</button>
          </div>
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

      {addingConnection && createTemplate ? (
        <Card className="uc-provider-page__form-card" raised>
          <form onSubmit={handleCreateConnection}>
            <div className="uc-provider-page__section-heading">
              <div>
                <h2>添加服务连接</h2>
                <p>{createTemplate.providerName} · {createTemplate.displayName}</p>
              </div>
              <Button onClick={leaveAddConnection} variant="ghost">返回画廊</Button>
            </div>
            <div className="uc-provider-page__form-grid">
              <div className="uc-provider-page__form-template">
                <span>接入模板</span>
                <strong>{createTemplate.providerName} · {createTemplate.displayName}</strong>
                <small>{createTemplate.kind === 'official' ? '官方模板' : '兼容协议模板'}</small>
              </div>
              <label>
                连接名称
                <input maxLength={200} onChange={(event) => setConnectionName(event.target.value)} required value={connectionName} />
              </label>
              {createTemplate.baseUrlMode !== 'fixed' && (
                <label>
                  接口地址{createTemplate.baseUrlMode === 'required' ? '' : '（可选）'}
                  <input onChange={(event) => setEndpoint(event.target.value)} required={createTemplate.baseUrlMode === 'required'} type="url" value={endpoint} />
                </label>
              )}
              {createTemplate.credentialFields.map((field) => (
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
            <Button disabled={busy || !connectionName.trim()} type="submit">
              {busy ? '正在保存…' : '保存连接'}
            </Button>
          </form>
        </Card>
      ) : loading ? (
        <EmptyState busy description="正在读取本地服务商配置。" icon="载" role="status" title="正在读取" />
      ) : view === 'gallery' ? (
        <ProviderGalleryView
          busy={busy}
          connections={registry.connections}
          onAddConnection={openCreateForTemplate}
          onManageTemplate={openManageForTemplate}
          onRequestAdapter={() => setMessage('求适配通道即将开放；当前可先使用「兼容协议」卡片接入符合主流对话协议的自建或网关服务。')}
          templates={templates}
        />
      ) : (
        <ProviderManageView
          activeTab={activeTab}
          busy={busy}
          connectionFilter={connectionFilter}
          modelDisplayName={modelDisplayName}
          modelKey={modelKey}
          onConnectionFilterChange={setConnectionFilter}
          onDeleteConnection={() => void handleDeleteConnection()}
          onGoGallery={() => setView('gallery')}
          onModelDisplayNameChange={setModelDisplayName}
          onModelKeyChange={setModelKey}
          onRegisterModel={(event) => void handleRegisterModel(event)}
          onReplacementCredentialChange={(fieldKey, value) =>
            setReplacementCredentials((current) => ({ ...current, [fieldKey]: value }))}
          onResetReplacementCredentials={() => setReplacementCredentials({})}
          onRotateCredential={(event) => void handleRotateCredential(event)}
          onSearchChange={setSearch}
          onSelectConnection={setSelectedConnectionId}
          onSelectModel={setSelectedModelId}
          onSelectTab={setActiveTab}
          onShowDeletedChange={setShowDeleted}
          providersApi={providersApi}
          registry={registry}
          replacementCredentials={replacementCredentials}
          runAction={runAction}
          search={search}
          selectedConnectionId={selectedConnectionId}
          selectedModelId={selectedModelId}
          showDeleted={showDeleted}
          templates={templates}
        />
      )}
    </section>
  );
}
