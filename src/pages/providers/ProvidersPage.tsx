import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type {
  CredentialActionResult,
  ProviderConnectionSummaryDto,
  ProviderManagementResult,
  ProviderRegistryDto,
  ViduLiveValidationApprovalDto,
  ViduLiveValidationStatusDto
} from '../../shared/provider-ipc';
import '../../styles/pages.css';

type DetailTab = 'models' | 'connection' | 'credential' | 'history' | 'defaults';
type ActionResult = ProviderManagementResult | CredentialActionResult;

const emptyRegistry: ProviderRegistryDto = {
  providers: [],
  connections: [],
  protocolBindings: [],
  models: [],
  capabilities: [],
  routingPreferences: []
};

const emptyLiveApproval: ViduLiveValidationApprovalDto = {
  confirmLiveNetwork: false,
  confirmCredentialUse: false,
  confirmImageBillableAttempt: false,
  confirmVideoBillableAttempt: false
};

const liveValidationStatusLabels: Record<
  ViduLiveValidationStatusDto['status'],
  string
> = {
  not_started: '尚未启动',
  active: '验证进行中',
  passed: '最小闭环已通过',
  failed: '验证已失败',
  blocked: '验证已阻断'
};

const liveStageLabels: Record<
  ViduLiveValidationStatusDto['events'][number]['stage'],
  string
> = {
  readiness: '准入检查',
  credits_validation: '账户与鉴权',
  image_submission: '真实生图提交',
  image_local_result: '图片本地作品',
  video_confirmation: '视频提交确认',
  video_submission: '真实视频提交',
  video_polling: '视频任务状态',
  video_local_result: '视频本地作品',
  flow: '流程状态'
};

const connectionLabels: Record<string, string> = {
  unconfigured: '未配置',
  saved: '已保存，待验证',
  validating: '正在验证',
  available: '连接可用',
  unavailable: '连接不可用',
  disabled: '已停用',
  deleted: '已删除'
};

const capabilityLabels: Record<string, string> = {
  verified_supported: '已验证支持',
  declared_supported: '服务声明支持',
  user_confirmed: '用户确认',
  unknown: '状态未知',
  unsupported: '不支持',
  verification_failed: '验证失败',
  restricted: '受限'
};

const credentialLabels: Record<string, string> = {
  not_configured: '未配置凭证',
  saved: '已安全保存（不回显）',
  validating: '正在验证（不回显）',
  valid: '凭证有效（不回显）',
  invalid: '凭证无效',
  deleted: '本地凭证已删除',
  verification_unavailable: '安全存储暂不可验证',
  status_unavailable: '凭证状态读取失败'
};

const tabLabels: Record<DetailTab, string> = {
  models: '模型目录',
  connection: '连接信息',
  credential: '凭证与安全',
  history: '历史验证',
  defaults: '默认设置'
};

function toneForState(state: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (state === 'available' || state === 'valid' || state === 'verified_supported') return 'success';
  if (state === 'unavailable' || state === 'invalid' || state === 'verification_failed' || state === 'status_unavailable') return 'danger';
  if (state === 'saved' || state === 'validating' || state === 'declared_supported') return 'info';
  if (state === 'unconfigured' || state === 'not_configured' || state === 'verification_unavailable' || state === 'user_confirmed' || state === 'restricted') return 'warning';
  return 'neutral';
}

function describeConnection(connection: ProviderConnectionSummaryDto) {
  return connectionLabels[connection.state] ?? '状态未知';
}

function describeError(result: { readonly error: { readonly code: string } }) {
  if (result.error.code === 'adapter_unavailable') return '后台服务契约尚未配置，当前无法在线验证';
  if (result.error.code === 'encryption_unavailable') return '系统安全存储当前不可用';
  if (result.error.code.endsWith('_not_found')) return '目标记录不存在，请刷新后重试';
  if (result.error.code === 'invalid_request') return '输入或当前状态不允许执行该操作';
  return '操作失败，请重试';
}

export function ProvidersPage() {
  const providersApi = window.unicomp?.providers;
  const [registry, setRegistry] = useState<ProviderRegistryDto>(emptyRegistry);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [activeTab, setActiveTab] = useState<DetailTab>('models');
  const [connectionFilter, setConnectionFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [addingService, setAddingService] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
  const [serviceName, setServiceName] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [accessCategory, setAccessCategory] = useState<'online' | 'local' | 'lan' | 'custom_remote'>('online');
  const [endpoint, setEndpoint] = useState('');
  const [credential, setCredential] = useState('');
  const [modelName, setModelName] = useState('');
  const [modelDisplayName, setModelDisplayName] = useState('');
  const [capabilityName, setCapabilityName] = useState('');
  const [routingPurpose, setRoutingPurpose] = useState('');
  const [routingPriority, setRoutingPriority] = useState('0');
  const [editConnectionName, setEditConnectionName] = useState('');
  const [editEndpoint, setEditEndpoint] = useState('');
  const [credentialStatus, setCredentialStatus] = useState<string>();
  const [liveValidation, setLiveValidation] =
    useState<ViduLiveValidationStatusDto>();
  const [liveApproval, setLiveApproval] =
    useState<ViduLiveValidationApprovalDto>(emptyLiveApproval);

  async function refreshRegistry(preferredConnectionId?: string) {
    if (!providersApi) {
      setMessage('当前运行环境未连接桌面服务商能力');
      setLoading(false);
      return;
    }
    const result = await providersApi.getRegistry();
    if (!result.ok) {
      setMessage('无法读取本地服务商注册表');
      setLoading(false);
      return;
    }
    setRegistry(result.value);
    const preferred = preferredConnectionId ?? selectedConnectionId;
    const next = result.value.connections.find((item) => item.connectionId === preferred)
      ?? result.value.connections.find((item) => item.state !== 'deleted')
      ?? result.value.connections[0];
    setSelectedConnectionId(next?.connectionId ?? '');
    setLoading(false);
  }

  useEffect(() => {
    let active = true;
    if (!providersApi) {
      setMessage('当前运行环境未连接桌面服务商能力');
      setLoading(false);
      return () => {
        active = false;
      };
    }
    void providersApi.getRegistry().then((result) => {
      if (!active) return;
      if (!result.ok) setMessage('无法读取本地服务商注册表');
      else {
        setRegistry(result.value);
        const first = result.value.connections.find((item) => item.state !== 'deleted')
          ?? result.value.connections[0];
        setSelectedConnectionId(first?.connectionId ?? '');
      }
    }).catch(() => {
      if (active) setMessage('读取本地服务商失败，请重试');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [providersApi]);

  useEffect(() => {
    let active = true;
    if (!providersApi) return () => { active = false; };
    void providersApi.getViduLiveValidation().then((result) => {
      if (active && result.ok) setLiveValidation(result.value);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [providersApi]);

  const selectedConnection = registry.connections.find(
    (item) => item.connectionId === selectedConnectionId
  );
  const selectedProvider = registry.providers.find(
    (item) => item.providerId === selectedConnection?.providerId
  );
  const connectionModels = registry.models.filter(
    (item) => item.connectionId === selectedConnectionId
  );
  const selectedModel = connectionModels.find((item) => item.modelId === selectedModelId)
    ?? connectionModels[0];
  const modelCapabilities = registry.capabilities.filter(
    (item) => item.modelId === selectedModel?.modelId
  );

  useEffect(() => {
    let active = true;
    setCredentialStatus(selectedConnection?.credentialState);
    if (!providersApi || !selectedConnection) {
      return () => {
        active = false;
      };
    }

    void providersApi.getCredentialStatus(selectedConnection.connectionId)
      .then((result) => {
        if (!active) return;
        setCredentialStatus(
          result.ok
            ? result.value.state
            : result.error.code === 'encryption_unavailable'
              ? 'verification_unavailable'
              : 'status_unavailable'
        );
      })
      .catch(() => {
        if (active) setCredentialStatus('status_unavailable');
      });

    return () => {
      active = false;
    };
  }, [providersApi, selectedConnection?.connectionId, selectedConnection?.credentialState]);

  useEffect(() => {
    setSelectedModelId(connectionModels[0]?.modelId ?? '');
    setEditConnectionName(selectedConnection?.name ?? '');
    setEditEndpoint('');
  }, [selectedConnectionId]);

  const visibleConnections = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('zh-CN');
    return registry.connections.filter((connection) => {
      const provider = registry.providers.find((item) => item.providerId === connection.providerId);
      const matchesFilter = connectionFilter === 'all'
        || (connectionFilter === 'problem'
          ? ['unavailable', 'unconfigured'].includes(connection.state)
          : connection.state === connectionFilter);
      const matchesSearch = !term
        || connection.name.toLocaleLowerCase('zh-CN').includes(term)
        || provider?.name.toLocaleLowerCase('zh-CN').includes(term);
      return matchesFilter && matchesSearch;
    });
  }, [connectionFilter, registry.connections, registry.providers, search]);

  async function runAction(
    action: () => Promise<ActionResult>,
    successMessage: string,
    preferredConnectionId?: string
  ) {
    if (busy) return false;
    setBusy(true);
    setMessage('');
    try {
      const result = await action();
      if (!result.ok) {
        setMessage(describeError(result));
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

  async function handleAddService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providersApi || !serviceName.trim() || !connectionName.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      const providerResult = await providersApi.createProvider(serviceName.trim(), accessCategory);
      if (!providerResult.ok || !providerResult.value.providerId) {
        setMessage(providerResult.ok ? '服务创建后未返回标识' : describeError(providerResult));
        return;
      }
      const connectionResult = await providersApi.createConnection(
        providerResult.value.providerId,
        connectionName.trim(),
        endpoint.trim() || null
      );
      if (!connectionResult.ok || !connectionResult.value.connectionId) {
        setMessage(connectionResult.ok ? '连接创建后未返回标识' : describeError(connectionResult));
        return;
      }
      setServiceName('');
      setConnectionName('');
      setEndpoint('');
      setAddingService(false);
      setMessage('服务连接已保存；连接和能力仍需分别验证');
      await refreshRegistry(connectionResult.value.connectionId);
    } catch {
      setMessage('添加服务失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  function openAddService(category: 'online' | 'custom_remote') {
    setAccessCategory(category);
    setAddingService(true);
    setServiceName('');
    setConnectionName('');
    setEndpoint('');
  }

  async function handleAddModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providersApi || !selectedConnection || !modelName.trim() || !modelDisplayName.trim()) return;
    const saved = await runAction(
      () => providersApi.registerManualModel(
        selectedConnection.connectionId,
        modelName.trim(),
        modelDisplayName.trim()
      ),
      '模型已登记，能力保持未验证',
      selectedConnection.connectionId
    );
    if (saved) {
      setModelName('');
      setModelDisplayName('');
      setAddingModel(false);
    }
  }

  async function handleSaveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providersApi || !selectedConnection || !credential) return;
    const saved = await runAction(
      () => providersApi.saveCredential(selectedConnection.connectionId, credential),
      '凭证已写入本机安全存储',
      selectedConnection.connectionId
    );
    if (saved) setCredential('');
  }

  async function handleStartLiveValidation() {
    if (
      !providersApi ||
      busy ||
      !Object.values(liveApproval).every(Boolean)
    ) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await providersApi.startViduLiveValidation(liveApproval);
      if (!result.ok) {
        setMessage(
          result.error.code === 'connection_not_ready'
            ? 'Vidu Token 或账户验证未通过；未发生生图或视频收费提交。'
            : result.error.code === 'already_started'
              ? '流程 8 已经启动，不能重复领取收费测试次数。'
              : '流程 8 启动失败，未发生收费提交。'
        );
        await refreshRegistry('connection-vidu-default');
        return;
      }
      setLiveValidation(result.value);
      setLiveApproval(emptyLiveApproval);
      setMessage('Vidu 鉴权已通过；已开放一次参考生图和一次图生视频验证。');
      await refreshRegistry('connection-vidu-default');
    } catch {
      setMessage('流程 8 启动失败，未发生收费提交。');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providersApi || !selectedConnection || !editConnectionName.trim()) return;
    await runAction(
      () => providersApi.updateConnection(
        selectedConnection.connectionId,
        editConnectionName.trim(),
        editEndpoint.trim() || null
      ),
      '连接信息已保存，需要重新验证',
      selectedConnection.connectionId
    );
  }

  async function handleSaveRouting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providersApi || !selectedModel || !routingPurpose.trim()) return;
    await runAction(
      () => providersApi.saveRoutingPreference(
        routingPurpose.trim(),
        selectedModel.modelId,
        Number(routingPriority),
        true
      ),
      '默认用途已保存；提交任务前仍需确认费用与外发范围',
      selectedConnectionId
    );
  }

  async function handleDeleteConnection() {
    if (!providersApi || !selectedConnection || busy) return;
    const confirmed = window.confirm(
      '删除本地连接会删除本机凭证并停用相关模型，但不会删除历史任务、作品或来源记录。此操作不等于撤销服务商侧凭证。继续吗？'
    );
    if (!confirmed) return;
    await runAction(
      () => providersApi.deleteConnection(selectedConnection.connectionId),
      '本地连接已删除；历史任务、作品和来源记录已保留'
    );
  }

  const availableCount = registry.connections.filter((item) => item.state === 'available').length;
  const problemCount = registry.connections.filter(
    (item) => ['unavailable', 'unconfigured'].includes(item.state)
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
          <p className="uc-page-skeleton__description">
            分别管理服务商、连接、模型、能力证据、本机凭证和默认用途。
          </p>
        </div>
        <div className="uc-provider-page__header-actions">
          <Button disabled={!providersApi || busy} onClick={() => openAddService('online')}>
            添加服务
          </Button>
          <Button disabled={!providersApi || busy} onClick={() => openAddService('custom_remote')} variant="secondary">
            自定义兼容接口
          </Button>
          <Button disabled={!providersApi || busy} onClick={() => void refreshRegistry()} variant="ghost">
            刷新状态
          </Button>
        </div>
      </header>

      <Card className="uc-provider-page__notice">
        <strong>真实调用边界</strong>
        <span>凭证只保存在本机安全存储；每次创作仍会单独确认接收方、外发范围、模型和未知费用，失败不会伪造成功。</span>
      </Card>

      <Card className="uc-provider-page__live-validation">
        <div className="uc-provider-page__section-heading">
          <div>
            <h2>Vidu 最小闭环验证</h2>
            <p>Windows 开发态真实鉴权、单图单输出与单视频单输出验证。</p>
          </div>
          <StatusPill
            tone={
              liveValidation?.status === 'passed'
                ? 'success'
                : liveValidation?.status === 'failed'
                  ? 'danger'
                  : liveValidation?.status === 'active'
                    ? 'info'
                    : 'warning'
            }
          >
            {liveValidationStatusLabels[liveValidation?.status ?? 'not_started']}
          </StatusPill>
        </div>
        {(liveValidation?.status ?? 'not_started') === 'not_started' ? (
          <div className="uc-provider-page__live-start">
            <div className="uc-provider-page__live-approvals">
              <Approval
                checked={liveApproval.confirmLiveNetwork}
                label="允许本次验证连接 Vidu 官方服务"
                onChange={(checked) => setLiveApproval((current) => ({ ...current, confirmLiveNetwork: checked }))}
              />
              <Approval
                checked={liveApproval.confirmCredentialUse}
                label="允许主进程使用本机安全存储中的 Token"
                onChange={(checked) => setLiveApproval((current) => ({ ...current, confirmCredentialUse: checked }))}
              />
              <Approval
                checked={liveApproval.confirmImageBillableAttempt}
                label="批准最多一次真实图片收费提交"
                onChange={(checked) => setLiveApproval((current) => ({ ...current, confirmImageBillableAttempt: checked }))}
              />
              <Approval
                checked={liveApproval.confirmVideoBillableAttempt}
                label="批准最多一次真实视频收费提交"
                onChange={(checked) => setLiveApproval((current) => ({ ...current, confirmVideoBillableAttempt: checked }))}
              />
            </div>
            <Button
              disabled={busy || !providersApi || !Object.values(liveApproval).every(Boolean)}
              onClick={() => void handleStartLiveValidation()}
            >
              验证鉴权并启动
            </Button>
          </div>
        ) : (
          <div className="uc-provider-page__live-facts">
            <span>图片次数：{describeBudget(liveValidation!.budget.image)}</span>
            <span>视频次数：{describeBudget(liveValidation!.budget.video)}</span>
            <span>最后更新：{liveValidation?.updatedAt ? new Date(liveValidation.updatedAt).toLocaleString('zh-CN') : '无'}</span>
          </div>
        )}
        {liveValidation?.events.length ? (
          <ol className="uc-provider-page__live-events">
            {liveValidation.events.slice(-5).map((event) => (
              <li key={event.sequence}>
                <span>{liveStageLabels[event.stage]}</span>
                <StatusPill tone={event.state === 'succeeded' ? 'success' : event.state === 'failed' ? 'danger' : 'info'}>
                  {event.state}
                </StatusPill>
                <time>{new Date(event.recordedAt).toLocaleString('zh-CN')}</time>
              </li>
            ))}
          </ol>
        ) : null}
      </Card>

      {message && <p className="uc-provider-page__message" role="status">{message}</p>}

      {addingService && (
        <Card className="uc-provider-page__form-card" raised>
          <form onSubmit={handleAddService}>
            <div className="uc-provider-page__section-heading">
              <div>
                <h2>{accessCategory === 'custom_remote' ? '添加自定义兼容接口' : '添加服务连接'}</h2>
                <p>只保存本地连接信息，不会自动连接或推断模型能力。</p>
              </div>
              <Button disabled={busy} onClick={() => setAddingService(false)} variant="ghost">取消</Button>
            </div>
            <div className="uc-provider-page__form-grid">
              <label>
                服务名称
                <input maxLength={100} onChange={(event) => setServiceName(event.target.value)} placeholder="由你填写，不预置厂商" required value={serviceName} />
              </label>
              <label>
                接入类别
                <select onChange={(event) => setAccessCategory(event.target.value as typeof accessCategory)} value={accessCategory}>
                  <option value="online">在线服务</option>
                  <option value="local">本机服务</option>
                  <option value="lan">局域网服务</option>
                  <option value="custom_remote">自定义远程接口</option>
                </select>
              </label>
              <label>
                连接名称
                <input maxLength={100} onChange={(event) => setConnectionName(event.target.value)} placeholder="例如：工作连接" required value={connectionName} />
              </label>
              <label>
                接口地址（可选）
                <input maxLength={500} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://…" type="url" value={endpoint} />
              </label>
            </div>
            <Button disabled={busy || !serviceName.trim() || !connectionName.trim()} type="submit">
              {busy ? '正在保存…' : '保存本地连接'}
            </Button>
          </form>
        </Card>
      )}

      {loading ? (
        <EmptyState busy description="正在读取本地服务商、连接和模型注册表。" icon="载" role="status" title="正在读取服务状态" />
      ) : registry.connections.length === 0 ? (
        <EmptyState
          action={<Button disabled={!providersApi} onClick={() => openAddService('online')}>添加第一个服务</Button>}
          description="当前没有服务商或模型数据。添加连接后仍需分别配置凭证、验证连接和登记模型。"
          icon="模"
          title="还没有服务连接"
        />
      ) : (
        <div className="uc-provider-page__workspace">
          <aside className="uc-provider-page__connections" aria-label="服务连接列表">
            <div className="uc-provider-page__panel-heading">
              <div>
                <h2>服务连接</h2>
                <p>{availableCount} 个可用，{problemCount} 个需要处理</p>
              </div>
            </div>
            <input
              aria-label="搜索连接或服务商"
              className="uc-provider-page__search"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索连接或服务商"
              type="search"
              value={search}
            />
            <div className="uc-provider-page__filters" aria-label="连接状态筛选">
              {[
                ['all', '全部'],
                ['available', '可用'],
                ['disabled', '停用'],
                ['problem', '有问题']
              ].map(([value, label]) => (
                <button aria-pressed={connectionFilter === value} key={value} onClick={() => setConnectionFilter(value)} type="button">
                  {label}
                </button>
              ))}
            </div>
            <div className="uc-provider-page__connection-list">
              {visibleConnections.length === 0 ? (
                <p className="uc-provider-page__muted">没有符合当前筛选的连接。</p>
              ) : visibleConnections.map((connection) => {
                const provider = registry.providers.find((item) => item.providerId === connection.providerId);
                return (
                  <button
                    aria-pressed={selectedConnectionId === connection.connectionId}
                    className="uc-provider-page__connection"
                    key={connection.connectionId}
                    onClick={() => setSelectedConnectionId(connection.connectionId)}
                    type="button"
                  >
                    <span className="uc-provider-page__connection-icon" aria-hidden="true">
                      {(provider?.name ?? connection.name).slice(0, 1).toLocaleUpperCase('zh-CN')}
                    </span>
                    <span>
                      <strong>{connection.name}</strong>
                      <small>{provider?.name ?? '未知服务商'} · {provider?.accessCategory ?? '未知类别'}</small>
                      <StatusPill tone={toneForState(connection.state)}>{describeConnection(connection)}</StatusPill>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="uc-provider-page__details" aria-label="服务商连接详情">
            {!selectedConnection ? (
              <EmptyState description="请从左侧选择一个连接。" icon="连" title="未选择连接" />
            ) : (
              <>
                <div className="uc-provider-page__detail-heading">
                  <div>
                    <span className="uc-provider-page__eyebrow">当前连接</span>
                    <h2>{selectedConnection.name}</h2>
                    <p>{selectedProvider?.name ?? '未知服务商'} · {selectedProvider?.accessCategory ?? '未知类别'}</p>
                  </div>
                  <div className="uc-provider-page__header-actions">
                    <StatusPill tone={toneForState(selectedConnection.state)}>{describeConnection(selectedConnection)}</StatusPill>
                    {selectedConnection.state !== 'deleted' && (
                      <Button
                        disabled={busy}
                        onClick={() => providersApi && void runAction(
                          () => providersApi.setConnectionEnabled(
                            selectedConnection.connectionId,
                            selectedConnection.state === 'disabled'
                          ),
                          selectedConnection.state === 'disabled' ? '连接已启用，仍需重新验证' : '连接已停用，不会参与路由',
                          selectedConnection.connectionId
                        )}
                        variant="secondary"
                      >
                        {selectedConnection.state === 'disabled' ? '启用连接' : '停用连接'}
                      </Button>
                    )}
                  </div>
                </div>

                <nav className="uc-provider-page__tabs" aria-label="连接详情区域">
                  {(Object.keys(tabLabels) as DetailTab[]).map((tab) => (
                    <button aria-current={activeTab === tab ? 'page' : undefined} key={tab} onClick={() => setActiveTab(tab)} type="button">
                      {tabLabels[tab]}
                    </button>
                  ))}
                </nav>

                {activeTab === 'models' && (
                  <section className="uc-provider-page__tab-panel" aria-labelledby="models-heading">
                    <div className="uc-provider-page__section-heading">
                      <div>
                        <h3 id="models-heading">模型目录</h3>
                        <p>目录同步、模型启用和具体能力验证是三个独立状态。</p>
                      </div>
                      <div className="uc-provider-page__header-actions">
                        <Button disabled={busy || selectedConnection.state === 'deleted'} onClick={() => providersApi && void runAction(
                          () => providersApi.validateConnection(selectedConnection.connectionId),
                          '连接验证已完成',
                          selectedConnection.connectionId
                        )} variant="secondary">验证连接</Button>
                        <Button disabled={busy || selectedConnection.state === 'deleted'} onClick={() => providersApi && void runAction(
                          () => providersApi.syncModelCatalog(selectedConnection.connectionId),
                          '模型目录已同步',
                          selectedConnection.connectionId
                        )} variant="secondary">同步目录</Button>
                        <Button disabled={busy || selectedConnection.state === 'deleted'} onClick={() => setAddingModel(true)}>手工登记模型</Button>
                      </div>
                    </div>

                    {addingModel && (
                      <form className="uc-provider-page__inline-form" onSubmit={handleAddModel}>
                        <label>模型标识<input maxLength={500} onChange={(event) => setModelName(event.target.value)} required value={modelName} /></label>
                        <label>显示名称<input maxLength={500} onChange={(event) => setModelDisplayName(event.target.value)} required value={modelDisplayName} /></label>
                        <Button disabled={busy || !modelName.trim() || !modelDisplayName.trim()} type="submit">保存模型</Button>
                        <Button disabled={busy} onClick={() => setAddingModel(false)} variant="ghost">取消</Button>
                      </form>
                    )}

                    {connectionModels.length === 0 ? (
                      <EmptyState description="同步模型目录或手工登记模型。未登记的能力不会被推断为支持。" icon="型" title="当前连接没有模型" />
                    ) : (
                      <div className="uc-provider-page__model-list">
                        {connectionModels.map((model) => {
                          const capabilities = registry.capabilities.filter((item) => item.modelId === model.modelId);
                          return (
                            <div
                              className="uc-provider-page__model"
                              data-selected={selectedModel?.modelId === model.modelId || undefined}
                              key={model.modelId}
                            >
                              <button
                                aria-pressed={selectedModel?.modelId === model.modelId}
                                className="uc-provider-page__model-select"
                                onClick={() => setSelectedModelId(model.modelId)}
                                type="button"
                              >
                                <span>
                                  <strong>{model.displayName}</strong>
                                  <small>{model.name}</small>
                                </span>
                                <span>{capabilities.length ? `${capabilities.length} 条能力证据` : '能力未知'}</span>
                              </button>
                              <StatusPill tone={model.enabled ? 'success' : 'neutral'}>{model.enabled ? '已启用' : '已停用'}</StatusPill>
                              <label className="uc-provider-page__switch">
                                <input
                                  aria-label={`${model.displayName}启用状态`}
                                  checked={model.enabled}
                                  disabled={busy || ['disabled', 'deleted'].includes(selectedConnection.state)}
                                  onChange={() => providersApi && void runAction(
                                    () => providersApi.setModelEnabled(model.modelId, !model.enabled),
                                    model.enabled ? '模型已停用' : '模型已启用；能力状态没有因此改变',
                                    selectedConnection.connectionId
                                  )}
                                  type="checkbox"
                                />
                                <span aria-hidden="true" />
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                )}

                {activeTab === 'connection' && (
                  <section className="uc-provider-page__tab-panel" aria-labelledby="connection-heading">
                    <div className="uc-provider-page__section-heading">
                      <div><h3 id="connection-heading">连接信息</h3><p>接口地址只显示是否已配置，页面不回显完整值。</p></div>
                    </div>
                    <dl className="uc-provider-page__facts">
                      <div><dt>连接状态</dt><dd>{describeConnection(selectedConnection)}</dd></div>
                      <div><dt>身份状态</dt><dd>{selectedConnection.identityState === 'verified' ? '身份已验证' : selectedConnection.identityState === 'verification_failed' ? '身份验证失败' : '身份未验证'}</dd></div>
                      <div><dt>接口地址</dt><dd>{selectedConnection.endpointConfigured ? '已配置，默认隐藏' : '未配置'}</dd></div>
                      <div><dt>最近连接验证</dt><dd>{selectedConnection.lastConnectionValidationAt ? new Date(selectedConnection.lastConnectionValidationAt).toLocaleString('zh-CN') : '从未验证'}</dd></div>
                    </dl>
                    {selectedConnection.state !== 'deleted' && (
                      <form className="uc-provider-page__stack-form" onSubmit={handleSaveConnection}>
                        <label>连接名称<input maxLength={100} onChange={(event) => setEditConnectionName(event.target.value)} required value={editConnectionName} /></label>
                        <label>重新填写接口地址<input maxLength={500} onChange={(event) => setEditEndpoint(event.target.value)} placeholder="留空将清除已保存地址" type="url" value={editEndpoint} /></label>
                        <div className="uc-provider-page__header-actions">
                          <Button disabled={busy || !editConnectionName.trim()} type="submit">保存并重置验证状态</Button>
                          <Button disabled={busy} onClick={() => void handleDeleteConnection()} variant="ghost">删除本地连接</Button>
                        </div>
                      </form>
                    )}
                  </section>
                )}

                {activeTab === 'credential' && (
                  <section className="uc-provider-page__tab-panel" aria-labelledby="credential-heading">
                    <div className="uc-provider-page__section-heading">
                      <div><h3 id="credential-heading">凭证与安全</h3><p>凭证只写入本机安全存储；页面没有读取、复制或显示明文的能力。</p></div>
                      <StatusPill tone={toneForState(credentialStatus ?? selectedConnection.credentialState)}>
                        {credentialLabels[credentialStatus ?? selectedConnection.credentialState] ?? '凭证状态未知'}
                      </StatusPill>
                    </div>
                    <form className="uc-provider-page__stack-form" onSubmit={handleSaveCredential}>
                      <label>
                        {(credentialStatus ?? selectedConnection.credentialState) === 'not_configured' ? '输入新凭证' : '替换凭证'}
                        <input autoComplete="new-password" maxLength={65536} onChange={(event) => setCredential(event.target.value)} placeholder="保存后不会再次显示" type="password" value={credential} />
                      </label>
                      <div className="uc-provider-page__header-actions">
                        <Button disabled={busy || !credential || selectedConnection.state === 'deleted'} type="submit">写入本机安全存储</Button>
                        <Button disabled={busy || selectedConnection.state === 'deleted'} onClick={() => providersApi && void runAction(
                          () => providersApi.checkCredentialStorage(selectedConnection.connectionId),
                          '已检查本机密文可读性；这不等于远端鉴权成功',
                          selectedConnection.connectionId
                        )} variant="secondary">检查本机存储</Button>
                        <Button disabled={busy || selectedConnection.state === 'deleted'} onClick={() => providersApi && void runAction(
                          () => providersApi.deleteLocalCredential(selectedConnection.connectionId),
                          '本地凭证已删除；服务商侧凭证未撤销',
                          selectedConnection.connectionId
                        )} variant="ghost">删除本地凭证</Button>
                      </div>
                    </form>
                    <p className="uc-provider-page__warning">删除本地凭证不等于撤销服务商侧 Key 或 Token。</p>
                  </section>
                )}

                {activeTab === 'history' && (
                  <section className="uc-provider-page__tab-panel" aria-labelledby="history-heading">
                    <div className="uc-provider-page__section-heading"><div><h3 id="history-heading">历史验证</h3><p>连接验证与具体模型能力验证分别记录。</p></div></div>
                    <dl className="uc-provider-page__facts">
                      <div><dt>连接</dt><dd>{describeConnection(selectedConnection)}</dd></div>
                      <div><dt>身份</dt><dd>{selectedConnection.identityState}</dd></div>
                      <div><dt>凭证</dt><dd>{selectedConnection.credentialState}</dd></div>
                      <div><dt>最近验证</dt><dd>{selectedConnection.lastConnectionValidationAt ? new Date(selectedConnection.lastConnectionValidationAt).toLocaleString('zh-CN') : '无记录'}</dd></div>
                    </dl>
                    {registry.capabilities.filter((item) => connectionModels.some((model) => model.modelId === item.modelId)).length === 0 ? (
                      <p className="uc-provider-page__muted">当前连接没有能力验证记录。</p>
                    ) : (
                      <ul className="uc-provider-page__evidence-list">
                        {registry.capabilities.filter((item) => connectionModels.some((model) => model.modelId === item.modelId)).map((item) => (
                          <li key={item.evidenceId}>
                            <strong>{connectionModels.find((model) => model.modelId === item.modelId)?.displayName}</strong>
                            <span>{item.capability}</span>
                            <StatusPill tone={toneForState(item.state)}>{capabilityLabels[item.state] ?? '状态未知'}</StatusPill>
                            <small>{item.observedAt ? new Date(item.observedAt).toLocaleString('zh-CN') : '未提供验证时间'}</small>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}

                {activeTab === 'defaults' && (
                  <section className="uc-provider-page__tab-panel" aria-labelledby="defaults-heading">
                    <div className="uc-provider-page__section-heading"><div><h3 id="defaults-heading">默认用途与路由</h3><p>自动路由不会提交任务，费用、隐私和地区未知时必须再次确认。</p></div></div>
                    {selectedModel ? (
                      <form className="uc-provider-page__inline-form" onSubmit={handleSaveRouting}>
                        <label>用途<input maxLength={500} onChange={(event) => setRoutingPurpose(event.target.value)} placeholder="由真实创作用途填写" required value={routingPurpose} /></label>
                        <label>备用顺序<input min="0" onChange={(event) => setRoutingPriority(event.target.value)} required type="number" value={routingPriority} /></label>
                        <Button disabled={busy || !routingPurpose.trim()} type="submit">保存当前模型为候选</Button>
                      </form>
                    ) : <p className="uc-provider-page__muted">请先登记并选择模型。</p>}
                    <ul className="uc-provider-page__evidence-list">
                      {registry.routingPreferences.filter((item) => connectionModels.some((model) => model.modelId === item.modelId)).map((item) => (
                        <li key={item.preferenceId}>
                          <strong>{item.purpose}</strong>
                          <span>{connectionModels.find((model) => model.modelId === item.modelId)?.displayName}</span>
                          <StatusPill tone={item.enabled ? 'info' : 'neutral'}>{item.enabled ? `顺序 ${item.priority}` : '已停用'}</StatusPill>
                        </li>
                      ))}
                    </ul>
                    <Card className="uc-provider-page__privacy">
                      <strong>费用与隐私</strong>
                      <span>费用：未知</span><span>处理地区：未知</span><span>外发范围：按任务提交时确认</span>
                    </Card>
                  </section>
                )}
              </>
            )}
          </section>

          <aside className="uc-provider-page__capabilities" aria-label="模型能力与路由">
            <div className="uc-provider-page__panel-heading">
              <div><h2>模型能力与路由</h2><p>选中模型的独立事实</p></div>
            </div>
            {!selectedModel ? (
              <EmptyState description="从模型目录选择或登记一个模型。" icon="能" title="未选择模型" />
            ) : (
              <>
                <Card className="uc-provider-page__selected-model">
                  <div><strong>{selectedModel.displayName}</strong><small>{selectedModel.name}</small></div>
                  <StatusPill tone={selectedModel.enabled ? 'success' : 'neutral'}>{selectedModel.enabled ? '已启用' : '已停用'}</StatusPill>
                </Card>
                <section className="uc-provider-page__capability-section">
                  <h3>能力状态</h3>
                  {modelCapabilities.length === 0 ? <p>尚无能力证据，不能标记为已验证支持。</p> : modelCapabilities.map((capability) => (
                    <div className="uc-provider-page__capability" key={capability.evidenceId}>
                      <span>{capability.capability}</span>
                      <StatusPill tone={toneForState(capability.state)}>{capabilityLabels[capability.state] ?? '状态未知'}</StatusPill>
                      <small>来源：{capability.source}</small>
                    </div>
                  ))}
                  <form className="uc-provider-page__capability-form" onSubmit={(event) => {
                    event.preventDefault();
                    if (!providersApi || !capabilityName.trim()) return;
                    void runAction(
                      () => providersApi.validateCapability(selectedModel.modelId, capabilityName.trim()),
                      '能力验证已完成',
                      selectedConnectionId
                    );
                  }}>
                    <label>具体能力<input maxLength={500} onChange={(event) => setCapabilityName(event.target.value)} placeholder="由真实模型能力填写" value={capabilityName} /></label>
                    <Button disabled={busy || !capabilityName.trim()} type="submit">验证所选能力</Button>
                  </form>
                </section>
                <Card className="uc-provider-page__privacy">
                  <strong>提交前仍需确认</strong>
                  <span>费用：未知</span><span>隐私：未知</span><span>处理地区：未知</span>
                </Card>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function Approval({
  checked,
  label,
  onChange
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="uc-provider-page__live-approval">
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}

function describeBudget(
  budget: ViduLiveValidationStatusDto['budget']['image']
): string {
  if (budget.billingFact === 'accepted_or_completed') return '已使用';
  if (budget.billingFact === 'submission_outcome_unknown') return '结果未知，不可重试';
  if (budget.claimState === 'claimed') return '已领取';
  if (budget.claimState === 'available') return '可用 1 次';
  return '不可用';
}
