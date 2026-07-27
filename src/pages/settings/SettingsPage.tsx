import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { IconType } from 'react-icons';
import {
  LuBell,
  LuFileText,
  LuFolderOpen,
  LuGauge,
  LuKeyboard,
  LuMonitorPlay,
  LuRefreshCw,
  LuSearch,
  LuSettings,
  LuShield,
  LuWifi
} from 'react-icons/lu';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill, type StatusTone } from '../../components/StatusPill';
import type {
  GeneralSettings,
  MediaSettings,
  NetworkSettings,
  NotificationSettings,
  PerformanceSettings,
  PrivacySettings,
  ProxyMode,
  SettingsCategory,
  SettingsValues,
  ShortcutBinding,
  ShortcutSettings,
  StorageSettings
} from '../../domain';
import type {
  CleanupScope,
  ControlledDirectoryDto,
  DirectoryPurpose,
  NativeSystemSettingsTarget,
  NotificationTestResultDto,
  ShortcutPlatform,
  SettingsCapabilityDto,
  SettingsIpcErrorCode,
  SettingsOperationPlanDto,
  SettingsOperationRequestDto,
  SettingsSnapshotDto,
  SettingsSystemStatusDto
} from '../../shared/settings-ipc';
import { useTheme } from '../../theme/useTheme';
import '../../styles/pages.css';

type SaveState = 'loading' | 'saved' | 'saving' | 'failed' | 'conflict';

interface OperationCopy {
  readonly title: string;
  readonly description: string;
  readonly success: string;
}

interface SettingsCategoryItem {
  readonly id: SettingsCategory;
  readonly label: string;
  readonly description: string;
  readonly capabilityId: string;
  readonly delivery: string;
  readonly icon: IconType;
  readonly keywords: string;
}

const categories: readonly SettingsCategoryItem[] = [
  {
    id: 'general', label: '常规', icon: LuSettings,
    description: '启动、界面、语言与关闭行为',
    capabilityId: 'platform_capability_detection', delivery: 'A1 当前已接入',
    keywords: '启动 主题 缩放 密度 动画 语言 日期 时间 关闭'
  },
  {
    id: 'storage', label: '存储与文件', icon: LuFolderOpen,
    description: '目录、容量、迁移与清理',
    capabilityId: 'directory_operations', delivery: 'A2 当前已接入',
    keywords: '目录 容量 磁盘 文件 迁移 清理'
  },
  {
    id: 'performance', label: '任务与性能', icon: LuGauge,
    description: '并发、后台运行与设备负载',
    capabilityId: 'task_policy', delivery: 'A2 当前已接入',
    keywords: '任务 性能 并发 后台 CPU GPU 内存'
  },
  {
    id: 'media', label: '本地媒体处理', icon: LuMonitorPlay,
    description: '本机媒体组件与硬件能力',
    capabilityId: 'media_components', delivery: 'A2 当前已接入',
    keywords: '媒体 视频 图片 音频 编码 硬件 代理'
  },
  {
    id: 'privacy', label: '隐私与权限', icon: LuShield,
    description: '文件访问、外发确认与系统权限',
    capabilityId: 'permission_controls', delivery: 'A3 当前已接入',
    keywords: '隐私 权限 文件 外发 剪贴板'
  },
  {
    id: 'network', label: '网络与代理', icon: LuWifi,
    description: '系统代理、连接与超时',
    capabilityId: 'proxy_controls', delivery: 'A3 当前已接入',
    keywords: '网络 代理 连接 DNS 证书 超时'
  },
  {
    id: 'notifications', label: '通知', icon: LuBell,
    description: '应用内、系统与声音提醒',
    capabilityId: 'notification_controls', delivery: 'A3 当前已接入',
    keywords: '通知 提醒 声音 系统'
  },
  {
    id: 'shortcuts', label: '快捷键', icon: LuKeyboard,
    description: 'Windows 与 macOS 按键映射',
    capabilityId: 'shortcut_controls', delivery: 'A3 当前已接入',
    keywords: '快捷键 按键 Windows macOS 冲突'
  },
  {
    id: 'diagnostics', label: '日志与诊断', icon: LuFileText,
    description: '本地日志、脱敏与诊断包',
    capabilityId: 'diagnostics', delivery: '等待 B4 与 A4',
    keywords: '日志 诊断 脱敏 导出'
  },
  {
    id: 'updates', label: '应用更新', icon: LuRefreshCw,
    description: '应用和获批组件更新状态',
    capabilityId: 'updates', delivery: '等待 B4 与 A4',
    keywords: '更新 版本 签名 安装 回退'
  }
];

export function SettingsPage() {
  const settings = window.unicomp?.settings;
  const { setPreference } = useTheme();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('general');
  const [query, setQuery] = useState('');
  const [snapshot, setSnapshot] = useState<SettingsSnapshotDto>();
  const [values, setValues] = useState<SettingsValues>();
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [message, setMessage] = useState('正在读取此设备的本地设置…');
  const [systemStatus, setSystemStatus] = useState<SettingsSystemStatusDto>();
  const [systemStatusError, setSystemStatusError] = useState('');
  const [operationPlan, setOperationPlan] = useState<SettingsOperationPlanDto>();
  const [operationCopy, setOperationCopy] = useState<OperationCopy>();
  const [operationBusy, setOperationBusy] = useState(false);
  const [notificationResult, setNotificationResult] = useState<NotificationTestResultDto>();

  useEffect(() => {
    let active = true;
    if (!settings) {
      setSaveState('failed');
      setMessage('设置端口不可用，请在 Electron 桌面应用中打开。');
      return () => {
        active = false;
      };
    }
    void settings.getSnapshot().then((result) => {
      if (!active) return;
      if (!result.ok) {
        setSaveState('failed');
        setMessage(settingsErrorMessage(result.error.code));
        return;
      }
      acceptSnapshot(result.value);
    }).catch(() => {
      if (active) {
        setSaveState('failed');
        setMessage('读取本地设置失败；当前页面不会用默认值覆盖原文件。');
      }
    });
    void settings.getSystemStatus().then((result) => {
      if (!active) return;
      if (result.ok) {
        setSystemStatus(result.value);
        setSystemStatusError('');
      } else {
        setSystemStatus(undefined);
        setSystemStatusError(settingsErrorMessage(result.error.code));
      }
    }).catch(() => {
      if (active) {
        setSystemStatus(undefined);
        setSystemStatusError('本机动态状态读取失败，可以重新检查。');
      }
    });
    return () => {
      active = false;
    };
  }, [settings]);

  function acceptSnapshot(next: SettingsSnapshotDto) {
    setSnapshot(next);
    setValues(next.values);
    setPreference(next.values.general.theme);
    setSaveState('saved');
    setMessage(snapshotSourceMessage(next));
  }

  async function saveValues(nextValues: SettingsValues) {
    if (!settings || !snapshot || saveState === 'saving') return;
    setValues(nextValues);
    setSaveState('saving');
    setMessage('正在原子保存到此设备…');
    try {
      const result = await settings.updateValues(snapshot.revision, nextValues);
      if (!result.ok) {
        setSaveState(result.error.code === 'revision_conflict' ? 'conflict' : 'failed');
        setMessage(settingsErrorMessage(result.error.code));
        return;
      }
      acceptSnapshot(result.value);
    } catch {
      setSaveState('failed');
      setMessage('保存失败；页面中的待保存值仍保留，可以重试。');
    }
  }

  function updateGeneral(patch: Partial<GeneralSettings>) {
    if (!values) return;
    void saveValues({
      ...values,
      general: { ...values.general, ...patch }
    });
  }

  function updateStorage(patch: Partial<StorageSettings>) {
    if (!values) return;
    void saveValues({
      ...values,
      storage: { ...values.storage, ...patch }
    });
  }

  function updateMedia(patch: Partial<MediaSettings>) {
    if (!values) return;
    void saveValues({
      ...values,
      media: { ...values.media, ...patch }
    });
  }

  function updateNotifications(patch: Partial<NotificationSettings>) {
    if (!values) return;
    void saveValues({
      ...values,
      notifications: { ...values.notifications, ...patch }
    });
  }

  async function refreshSystemStatus() {
    if (!settings) return;
    setSystemStatusError('');
    try {
      const result = await settings.getSystemStatus();
      if (result.ok) setSystemStatus(result.value);
      else {
        setSystemStatus(undefined);
        setSystemStatusError(settingsErrorMessage(result.error.code));
      }
    } catch {
      setSystemStatus(undefined);
      setSystemStatusError('本机动态状态读取失败，可以重新检查。');
    }
  }

  async function reloadSnapshot() {
    if (!settings) return;
    setSaveState('loading');
    setMessage('正在重新读取此设备上的最新设置…');
    try {
      const result = await settings.getSnapshot();
      if (result.ok) acceptSnapshot(result.value);
      else {
        setSaveState('failed');
        setMessage(settingsErrorMessage(result.error.code));
      }
    } catch {
      setSaveState('failed');
      setMessage('重新读取失败；没有覆盖当前设置文件。');
    }
  }

  async function requestOperationPlan(
    operation: SettingsOperationRequestDto,
    copy: OperationCopy
  ) {
    if (!settings || !snapshot) return;
    const result = await settings.planOperation(snapshot.revision, operation);
    if (!result.ok) {
      if (result.error.code === 'revision_conflict') setSaveState('conflict');
      setMessage(settingsErrorMessage(result.error.code));
      return;
    }
    if (operation.kind === 'restore_category_defaults' && result.value.changedValueCount === 0) {
      setMessage('常规设置已经是默认值，没有需要恢复的内容。');
      return;
    }
    setOperationPlan(result.value);
    setOperationCopy(copy);
  }

  async function planOperation(
    operation: SettingsOperationRequestDto,
    copy: OperationCopy
  ) {
    if (operationBusy) return;
    setOperationBusy(true);
    try {
      await requestOperationPlan(operation, copy);
    } catch {
      setMessage('无法生成影响计划，当前设置没有改变。');
    } finally {
      setOperationBusy(false);
    }
  }

  async function chooseDirectory(purpose: DirectoryPurpose, label: string) {
    if (!settings || operationBusy) return;
    setOperationBusy(true);
    setMessage(`正在选择${label}并检查权限…`);
    try {
      const selected = await settings.selectDirectory(purpose);
      if (!selected.ok) {
        setMessage(settingsErrorMessage(selected.error.code));
        return;
      }
      if (!selected.value) {
        setMessage('已取消目录选择，当前目录没有改变。');
        return;
      }
      await requestOperationPlan(
        { kind: 'migrate_directory', purpose, targetDirectoryId: selected.value.id },
        {
          title: `确认迁移${label}`,
          description: `目标为“${selected.value.displayName}”。执行前会重新检查目录、空间和文件状态。`,
          success: `${label}已完成校验并切换；旧位置仍保留。`
        }
      );
      await refreshSystemStatus();
    } catch {
      setMessage('目录选择或迁移预检失败，当前目录没有改变。');
    } finally {
      setOperationBusy(false);
    }
  }

  async function executeOperation() {
    if (!settings || !operationPlan || !operationCopy || operationBusy) return;
    setOperationBusy(true);
    try {
      const result = await settings.executeOperation(operationPlan.confirmationHandle);
      if (!result.ok) {
        if (result.error.code === 'revision_conflict') setSaveState('conflict');
        setMessage(settingsErrorMessage(result.error.code));
        return;
      }
      acceptSnapshot(result.value);
      await refreshSystemStatus();
      setMessage(operationCopy.success);
    } catch {
      setMessage('操作失败；尚未完成的部分不会被标记为成功，请重新生成影响计划。');
    } finally {
      setOperationPlan(undefined);
      setOperationCopy(undefined);
      setOperationBusy(false);
    }
  }

  function planGeneralRestore() {
    void planOperation(
      { kind: 'restore_category_defaults', category: 'general' },
      {
        title: '确认恢复常规默认',
        description: '只恢复常规偏好，不删除项目、作品、任务或本机数据。',
        success: '常规设置已恢复默认并保存到此设备。'
      }
    );
  }

  async function openSystemSettings(target: NativeSystemSettingsTarget) {
    if (!settings) return;
    const result = await settings.openSystemSettings(target);
    setMessage(result.ok ? '已打开系统设置入口；授权结果以系统实际状态为准。' : settingsErrorMessage(result.error.code));
    await refreshSystemStatus();
  }

  async function sendTestNotification(system: boolean, sound: boolean) {
    if (!settings) return;
    const result = await settings.sendTestNotification(system, sound);
    if (!result.ok) {
      setMessage(settingsErrorMessage(result.error.code));
      return;
    }
    setNotificationResult(result.value);
    setMessage('测试通知已执行；应用内提醒保持可用，系统与声音结果按平台事实显示。');
    await refreshSystemStatus();
  }

  async function planProxy(next: ProxyMode, credential?: { readonly username: string; readonly secret: string }) {
    if (!settings) return;
    let credentialHandle: string | undefined;
    if (credential) {
      const staged = await settings.stageProxyCredential(credential.username, credential.secret);
      if (!staged.ok) {
        setMessage(settingsErrorMessage(staged.error.code));
        return;
      }
      credentialHandle = staged.value.credentialHandle;
    }
    void planOperation(
      { kind: 'update_proxy', value: next, credentialHandle },
      {
        title: '确认切换网络代理',
        description: '代理测试只发送最小探测请求，不携带项目内容、提示词或服务商凭证；变更只影响后续请求。',
        success: '网络代理已通过探测并保存；活动请求没有被重试或改写。'
      }
    );
  }

  function planPrivacy(next: PrivacySettings) {
    void planOperation(
      { kind: 'update_privacy_permissions', values: next },
      {
        title: '确认隐私与权限策略',
        description: '外发、费用、任务失败和存储不足等强制确认不会被关闭。',
        success: '隐私与权限策略已保存，强制确认边界仍保留。'
      }
    );
  }

  function planShortcuts(platform: ShortcutPlatform, bindings: readonly ShortcutBinding[]) {
    void planOperation(
      {
        kind: 'update_shortcuts',
        platform,
        bindings: bindings.map((binding) => ({
          actionId: binding.actionId,
          accelerator: platform === 'windows' ? binding.windows : binding.macos
        }))
      },
      {
        title: '确认快捷键变更',
        description: '保存前会检查未知动作、不可修改动作、重复键、系统保留键和真实注册结果。',
        success: '快捷键已保存；另一个平台的按键没有被覆盖。'
      }
    );
  }

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const visibleCategories = categories.filter((category) =>
    `${category.label} ${category.description} ${category.keywords}`
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery)
  );
  const category = categories.find((item) => item.id === activeCategory) ?? categories[0];
  const capability = capabilityFor(snapshot, category.capabilityId);
  const isB2Category = ['storage', 'performance', 'media'].includes(activeCategory);
  const isB3Category = ['privacy', 'network', 'notifications', 'shortcuts'].includes(activeCategory);
  const disabled =
    saveState === 'loading' ||
    saveState === 'saving' ||
    saveState === 'conflict' ||
    operationBusy;

  return (
    <section className="uc-settings" aria-labelledby="settings-page-title">
      <header className="uc-settings__header">
        <div>
          <h1 id="settings-page-title">本地设置</h1>
          <p>设置只保存在当前设备，不进入项目，也不会同步到云端。</p>
        </div>
        <div className="uc-settings__header-actions">
          <label className="uc-settings__search">
            <LuSearch aria-hidden="true" />
            <span className="uc-sr-only">搜索设置分类</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索设置"
              type="search"
              value={query}
            />
          </label>
          {activeCategory === 'general' ? (
            <Button disabled={!snapshot || disabled} onClick={planGeneralRestore} variant="secondary">
              恢复常规默认
            </Button>
          ) : isB2Category || isB3Category ? (
            <Button disabled={operationBusy} onClick={() => void refreshSystemStatus()} variant="secondary">
              重新检查本机状态
            </Button>
          ) : null}
        </div>
      </header>

      <div className="uc-settings__workspace">
        <nav className="uc-settings__categories" aria-label="本地设置分类">
          <strong>设置分类</strong>
          {visibleCategories.map((item) => {
            const Icon = item.icon;
            return (
              <button
                aria-current={activeCategory === item.id ? 'page' : undefined}
                className={activeCategory === item.id ? 'is-active' : ''}
                key={item.id}
                onClick={() => setActiveCategory(item.id)}
                type="button"
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
          {visibleCategories.length === 0 ? (
            <p className="uc-settings__no-match">没有匹配的设置分类。</p>
          ) : null}
        </nav>

        <main className="uc-settings__content" tabIndex={-1}>
          <div className="uc-settings__section-heading">
            <div>
              <h2>{category.label}</h2>
              <p>{category.description}</p>
            </div>
            <StatusPill tone={activeCategory === 'general' ? 'info' : capabilityTone(capability)}>
              {activeCategory === 'general' ? '普通保存可用' : capabilityLabel(capability)}
            </StatusPill>
          </div>

          {activeCategory === 'general' && values ? (
            <GeneralSettingsPanel
              disabled={disabled}
              onChange={updateGeneral}
              platformUnavailable={capabilityFor(snapshot, 'platform_capability_detection')?.state !== 'available'}
              values={values.general}
            />
          ) : activeCategory === 'general' ? (
            <EmptyState
              description={message}
              icon="设"
              readOnly
              title={saveState === 'loading' ? '正在读取本地设置' : '常规设置暂不可用'}
            />
          ) : (isB2Category || isB3Category) && values && systemStatus ? (
            activeCategory === 'storage' ? (
              <StorageSettingsPanel
                directories={systemStatus.storage.directories}
                disabled={disabled}
                onChange={updateStorage}
                onCleanup={(scopes) => void planOperation(
                  { kind: 'cleanup_storage', scopes },
                  {
                    title: '确认清理本机可重建文件',
                    description: '只处理计划列出的缓存、预览代理、临时导出和到期日志；不会删除项目、作品或原始素材。',
                    success: '清理计划已执行；本机统计已重新扫描。'
                  }
                )}
                onMigrate={(purpose, label) => void chooseDirectory(purpose, label)}
                status={systemStatus}
                unit={values.general.fileSizeUnit}
                values={values.storage}
              />
            ) : activeCategory === 'performance' ? (
              <PerformanceSettingsPanel
                disabled={disabled}
                onPlan={(next, title) => void planOperation(
                  { kind: 'update_performance', values: next },
                  {
                    title,
                    description: '新策略只作用于后续任务和新的 attempt；运行中的任务不会被取消、抢占或改写。',
                    success: '任务与性能策略已保存，只对后续任务和新的 attempt 生效。'
                  }
                )}
                status={systemStatus.performance}
                values={values.performance}
              />
            ) : activeCategory === 'media' ? (
              <MediaSettingsPanel
                directories={systemStatus.storage.directories}
                disabled={disabled}
                onChange={updateMedia}
                onHardware={(value) => void planOperation(
                  { kind: 'update_hardware_acceleration', value },
                  {
                    title: '确认媒体硬件策略',
                    description: '硬件失败不会阻断软件导出；未获批准的硬件模式不能执行。',
                    success: '媒体硬件策略已保存，软件回退仍保持可用。'
                  }
                )}
                onMigrateProxy={() => void chooseDirectory('proxy', '预览代理目录')}
                onRefresh={() => void refreshSystemStatus()}
                status={systemStatus.media}
                unit={values.general.fileSizeUnit}
                values={values.media}
              />
            ) : activeCategory === 'privacy' ? (
              <PrivacySettingsPanel
                disabled={disabled}
                onOpenSystemSettings={(target) => void openSystemSettings(target)}
                onPlan={planPrivacy}
                status={systemStatus.privacy}
                values={values.privacy}
              />
            ) : activeCategory === 'network' ? (
              <NetworkSettingsPanel
                disabled={disabled}
                onPlan={(next, credential) => void planProxy(next, credential)}
                status={systemStatus.network}
                values={values.network}
              />
            ) : activeCategory === 'notifications' ? (
              <NotificationsSettingsPanel
                disabled={disabled}
                onChange={updateNotifications}
                onOpenSystemSettings={(target) => void openSystemSettings(target)}
                onTest={(system, sound) => void sendTestNotification(system, sound)}
                result={notificationResult}
                status={systemStatus.notifications}
                values={values.notifications}
              />
            ) : (
              <ShortcutsSettingsPanel
                disabled={disabled}
                onPlan={planShortcuts}
                onRestore={(platform) => void planOperation(
                  { kind: 'restore_shortcut_defaults', platform },
                  {
                    title: '确认恢复快捷键默认',
                    description: '只恢复所选平台的版本化默认快捷键，不覆盖另一个平台。',
                    success: '快捷键已恢复为所选平台默认值。'
                  }
                )}
                status={systemStatus.shortcuts}
                values={values.shortcuts}
              />
            )
          ) : isB2Category || isB3Category ? (
            <SystemStatusUnavailable
              message={systemStatusError || '正在读取真实目录、设备负载、媒体组件、权限、代理、通知和快捷键状态…'}
              onRetry={() => void refreshSystemStatus()}
            />
          ) : (
            <EmptyState
              description={`${category.delivery}。${capabilityReason(capability)}`}
              icon="待"
              readOnly
              title={`${category.label}尚未接入`}
            />
          )}
        </main>

        <aside className="uc-settings__status" aria-label="本机设置状态">
          <div className="uc-settings__status-heading">
            <h2>本机状态摘要</h2>
            <StatusPill tone={saveStateTone(saveState)}>{saveStateLabel(saveState)}</StatusPill>
          </div>
          <dl className="uc-settings__facts">
            <Fact label="设置来源" value={snapshot ? repositoryLabel(snapshot.statuses.repository) : '尚未读取'} />
            <Fact label="Schema" value={snapshot ? `V${snapshot.statuses.schemaVersion}` : '未知'} />
            <Fact label="Revision" value={snapshot ? String(snapshot.revision) : '未知'} />
            <Fact label="待重启" value={snapshot?.pendingRestart.length ? `${snapshot.pendingRestart.length} 项` : '无'} />
          </dl>
          <section className="uc-settings__status-card">
            <h3>当前真实能力</h3>
            <CapabilityStatus capability={capabilityFor(snapshot, 'settings_persistence')} label="本机设置保存" />
            <CapabilityStatus
              capability={capability}
              label={activeCategory === 'general' ? '常规平台能力' : category.label}
            />
          </section>
          {systemStatus ? (
            <CategorySystemStatus
              activeCategory={activeCategory}
              status={systemStatus}
              unit={values?.general.fileSizeUnit ?? 'auto'}
            />
          ) : null}
          <section className="uc-settings__status-card">
            <h3>安全边界</h3>
            <p>当前页面不会显示设置文件路径、凭证、日志原文或设备句柄。</p>
            <p>{isB2Category || isB3Category ? '高风险操作必须先展示真实影响计划，再由你确认执行。' : '未接平台适配器的分类只显示不可用，不提供假控件。'}</p>
          </section>
        </aside>
      </div>

      <footer className={`uc-settings__save-bar uc-settings__save-bar--${saveState}`} aria-live="polite">
        <div>
          <strong>{saveStateLabel(saveState)}</strong>
          <span>{message}</span>
        </div>
        {saveState === 'failed' && values && snapshot ? (
          <Button onClick={() => void saveValues(values)} variant="secondary">重试保存</Button>
        ) : saveState === 'conflict' ? (
          <Button onClick={() => void reloadSnapshot()} variant="secondary">重新载入最新设置</Button>
        ) : null}
      </footer>

      {operationPlan && operationCopy ? (
        <ConfirmOperationDialog
          busy={operationBusy}
          copy={operationCopy}
          onCancel={() => {
            setOperationPlan(undefined);
            setOperationCopy(undefined);
          }}
          onConfirm={() => void executeOperation()}
          plan={operationPlan}
        />
      ) : null}
    </section>
  );
}

function GeneralSettingsPanel({
  disabled,
  onChange,
  platformUnavailable,
  values
}: {
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<GeneralSettings>) => void;
  readonly platformUnavailable: boolean;
  readonly values: GeneralSettings;
}) {
  return (
    <div className="uc-settings__groups">
      <SettingsGroup title="1. 启动行为">
        <SettingRow
          description="需要真实平台启动项适配器；当前不会伪装成已经启用。"
          label="开机后自动启动"
        >
          <Toggle
            checked={values.launchAtLogin}
            disabled={disabled || platformUnavailable}
            label="开机后自动启动"
            onChange={(checked) => onChange({ launchAtLogin: checked })}
          />
        </SettingRow>
        <SettingRow description="保存应用启动后希望进入的页面。" label="启动后打开">
          <select
            aria-label="启动后打开"
            disabled={disabled}
            onChange={(event) => onChange({ startupDestination: event.target.value as GeneralSettings['startupDestination'] })}
            value={values.startupDestination}
          >
            <option value="projects">项目页</option>
            <option value="chat">对话页</option>
            <option value="last_active">上次页面</option>
          </select>
        </SettingRow>
        <SettingRow description="恢复上次页面状态，不包含未保存草稿。" label="恢复上次会话">
          <Toggle checked={values.restoreLastSession} disabled={disabled} label="恢复上次会话" onChange={(checked) => onChange({ restoreLastSession: checked })} />
        </SettingRow>
        <SettingRow description="启动时检查可恢复或需要处理的任务。" label="检查未完成任务">
          <Toggle checked={values.inspectIncompleteTasks} disabled={disabled} label="检查未完成任务" onChange={(checked) => onChange({ inspectIncompleteTasks: checked })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="2. 界面设置">
        <SettingRow description="跟随系统、深色或浅色。保存成功后应用。" label="主题模式">
          <select aria-label="主题模式" disabled={disabled} onChange={(event) => onChange({ theme: event.target.value as GeneralSettings['theme'] })} value={values.theme}>
            <option value="system">跟随系统</option>
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select>
        </SettingRow>
        <SettingRow description="设置会保存在当前设备；完整窗口缩放适配后生效。" label="界面缩放">
          <label className="uc-settings__range">
            <input aria-label="界面缩放" disabled={disabled} max="200" min="75" onChange={(event) => onChange({ uiScalePercent: Number(event.target.value) })} step="5" type="range" value={values.uiScalePercent} />
            <output>{values.uiScalePercent}%</output>
          </label>
        </SettingRow>
        <SettingRow description="选择舒适或紧凑的信息密度。" label="界面密度">
          <select aria-label="界面密度" disabled={disabled} onChange={(event) => onChange({ density: event.target.value as GeneralSettings['density'] })} value={values.density}>
            <option value="comfortable">舒适</option>
            <option value="compact">紧凑</option>
          </select>
        </SettingRow>
        <SettingRow description="控制普通界面过渡动画。" label="动画效果">
          <Toggle checked={values.animations} disabled={disabled} label="动画效果" onChange={(checked) => onChange({ animations: checked })} />
        </SettingRow>
        <SettingRow description="减少非必要动画，提高可访问性。" label="减少动态效果">
          <Toggle checked={values.reduceMotion} disabled={disabled} label="减少动态效果" onChange={(checked) => onChange({ reduceMotion: checked })} />
        </SettingRow>
        <SettingRow description="记住左侧分类和创作导航的展开状态。" label="记住侧栏状态">
          <Toggle checked={values.rememberSidebar} disabled={disabled} label="记住侧栏状态" onChange={(checked) => onChange({ rememberSidebar: checked })} />
        </SettingRow>
        <SettingRow description="鼠标悬停时显示简短功能提示。" label="显示工具提示">
          <Toggle checked={values.showTooltips} disabled={disabled} label="显示工具提示" onChange={(checked) => onChange({ showTooltips: checked })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="3. 语言与格式">
        <SettingRow description="当前版本只有简体中文界面资源。" label="界面语言">
          <select aria-label="界面语言" disabled value={values.locale}>
            <option value="zh-CN">简体中文（当前）</option>
          </select>
        </SettingRow>
        <SettingRow description="日期显示方式。" label="日期格式">
          <select aria-label="日期格式" disabled={disabled} onChange={(event) => onChange({ dateFormat: event.target.value as GeneralSettings['dateFormat'] })} value={values.dateFormat}>
            <option value="system">跟随系统</option>
            <option value="yyyy-mm-dd">YYYY-MM-DD</option>
            <option value="yyyy/mm/dd">YYYY/MM/DD</option>
            <option value="mm/dd/yyyy">MM/DD/YYYY</option>
          </select>
        </SettingRow>
        <SettingRow description="时间显示方式。" label="时间格式">
          <select aria-label="时间格式" disabled={disabled} onChange={(event) => onChange({ timeFormat: event.target.value as GeneralSettings['timeFormat'] })} value={values.timeFormat}>
            <option value="system">跟随系统</option>
            <option value="24h">24 小时制</option>
            <option value="12h">12 小时制</option>
          </select>
        </SettingRow>
        <SettingRow description="文件容量采用自动、十进制或二进制单位。" label="文件大小单位">
          <select aria-label="文件大小单位" disabled={disabled} onChange={(event) => onChange({ fileSizeUnit: event.target.value as GeneralSettings['fileSizeUnit'] })} value={values.fileSizeUnit}>
            <option value="auto">自动（推荐）</option>
            <option value="decimal">十进制 KB / MB / GB</option>
            <option value="binary">二进制 KiB / MiB / GiB</option>
          </select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="4. 关闭应用时">
        <SettingRow description="需要真实平台关闭适配器；当前只显示已保存意图，不宣称已经生效。" label="关闭行为">
          <select aria-label="关闭行为" disabled={disabled || platformUnavailable} onChange={(event) => onChange({ closeBehavior: event.target.value as GeneralSettings['closeBehavior'] })} value={values.closeBehavior}>
            <option value="direct_exit">直接退出</option>
            <option value="minimize_to_tray">最小化到后台</option>
            <option value="confirm_when_tasks_running">有任务运行时询问</option>
            <option value="always_confirm">始终询问</option>
          </select>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}

const storageDirectoryItems = [
  { purpose: 'projects', label: '项目目录' },
  { purpose: 'works', label: '作品目录' },
  { purpose: 'imageOutput', label: '图片输出目录' },
  { purpose: 'videoOutput', label: '视频输出目录' },
  { purpose: 'videoEditorOutput', label: '视频编辑输出目录' },
  { purpose: 'downloads', label: '下载目录' },
  { purpose: 'cache', label: '缓存目录' }
] as const;

const cleanupItems: readonly { readonly scope: CleanupScope; readonly label: string; readonly description: string }[] = [
  { scope: 'caches', label: '应用缓存', description: '只删除可重建缓存' },
  { scope: 'preview_proxies', label: '预览代理', description: '不触碰原始素材' },
  { scope: 'temporary_exports', label: '临时导出', description: '仅处理未完成临时文件' },
  { scope: 'eligible_logs', label: '到期日志', description: '按当前保留期筛选' }
];

function StorageSettingsPanel({
  directories,
  disabled,
  onChange,
  onCleanup,
  onMigrate,
  status,
  unit,
  values
}: {
  readonly directories: readonly ControlledDirectoryDto[];
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<StorageSettings>) => void;
  readonly onCleanup: (scopes: readonly CleanupScope[]) => void;
  readonly onMigrate: (purpose: DirectoryPurpose, label: string) => void;
  readonly status: SettingsSystemStatusDto;
  readonly unit: GeneralSettings['fileSizeUnit'];
  readonly values: StorageSettings;
}) {
  const [cleanupScopes, setCleanupScopes] = useState<readonly CleanupScope[]>(status.storage.cleanupScopes);

  function toggleCleanup(scope: CleanupScope, checked: boolean) {
    setCleanupScopes((current) => checked
      ? [...new Set([...current, scope])]
      : current.filter((item) => item !== scope));
  }

  return (
    <div className="uc-settings__groups">
      <SettingsGroup title="1. 默认保存位置">
        {storageDirectoryItems.map(({ purpose, label }) => {
          const directory = directoryFor(directories, values.directories[purpose]);
          return (
            <SettingRow
              description={directory
                ? `${directory.displayName} · 可用空间 ${formatBytes(directory.freeBytes, unit)}`
                : '使用应用默认位置；renderer 不会取得绝对路径。'}
              key={purpose}
              label={label}
            >
              <div className="uc-settings__inline-actions">
                <StatusPill tone={directoryTone(directory)}>{directoryLabel(directory)}</StatusPill>
                <Button aria-label={`选择并迁移${label}`} disabled={disabled} onClick={() => onMigrate(purpose, label)} variant="secondary">
                  选择并迁移
                </Button>
              </div>
            </SettingRow>
          );
        })}
      </SettingsGroup>

      <SettingsGroup title="2. 本机应用数据">
        <div className="uc-settings__metric-grid">
          <Metric label="应用管理文件" value={formatBytes(status.storage.appUsage.totalBytes, unit)} />
          <Metric label="文件数量" value={`${status.storage.appUsage.fileCount} 个`} />
          <Metric label="扫描状态" value={status.storage.appUsage.truncated ? '达到安全扫描上限' : '扫描完成'} />
          <Metric label="受控目录" value={`${directories.length} 个`} />
        </div>
        <p className="uc-settings__notice">统计仅覆盖应用管理范围，不扫描整块磁盘或用户主目录。</p>
      </SettingsGroup>

      <SettingsGroup title="3. 清理可重建文件">
        <div className="uc-settings__cleanup-grid">
          {cleanupItems.filter((item) => status.storage.cleanupScopes.includes(item.scope)).map((item) => (
            <label className="uc-settings__cleanup-option" key={item.scope}>
              <input
                checked={cleanupScopes.includes(item.scope)}
                disabled={disabled}
                onChange={(event) => toggleCleanup(item.scope, event.target.checked)}
                type="checkbox"
              />
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </label>
          ))}
        </div>
        <div className="uc-settings__group-actions">
          <Button disabled={disabled || cleanupScopes.length === 0} onClick={() => onCleanup(cleanupScopes)}>
            查看影响并确认清理
          </Button>
          <span>计划会返回真实文件数和容量；清理不可回退。</span>
        </div>
      </SettingsGroup>

      <SettingsGroup title="4. 文件命名与冲突处理">
        <SettingRow description="1–64 个字符；离开输入框后自动保存。" label="默认文件名前缀">
          <input
            aria-label="默认文件名前缀"
            defaultValue={values.fileNamePrefix}
            disabled={disabled}
            key={values.fileNamePrefix}
            maxLength={64}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim();
              if (!next) event.currentTarget.value = values.fileNamePrefix;
              else if (next !== values.fileNamePrefix) onChange({ fileNamePrefix: next });
            }}
            type="text"
          />
        </SettingRow>
        <SettingRow description="生成文件名时加入当前项目名称。" label="包含项目名称">
          <Toggle checked={values.includeProjectName} disabled={disabled} label="包含项目名称" onChange={(checked) => onChange({ includeProjectName: checked })} />
        </SettingRow>
        <SettingRow description="按当前日期格式加入日期。" label="包含日期">
          <Toggle checked={values.includeDate} disabled={disabled} label="包含日期" onChange={(checked) => onChange({ includeDate: checked })} />
        </SettingRow>
        <SettingRow description="正式文件不会被静默覆盖。" label="同名文件处理">
          <select aria-label="同名文件处理" disabled={disabled} onChange={(event) => onChange({ conflictPolicy: event.target.value as StorageSettings['conflictPolicy'] })} value={values.conflictPolicy}>
            <option value="create_unique_name">自动创建唯一名称</option>
            <option value="fail">停止并提示</option>
          </select>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}

const performanceTaskItems = [
  { key: 'onlineGeneration', statusKey: 'online_generation', label: '在线生成任务' },
  { key: 'localImage', statusKey: 'local_image', label: '本地图片处理' },
  { key: 'localVideo', statusKey: 'local_video', label: '本地视频处理' },
  { key: 'downloads', statusKey: 'downloads', label: '下载任务' },
  { key: 'thumbnails', statusKey: 'thumbnails', label: '缩略图生成' }
] as const;

function PerformanceSettingsPanel({ disabled, onPlan, status, values }: {
  readonly disabled: boolean;
  readonly onPlan: (values: PerformanceSettings, title: string) => void;
  readonly status: SettingsSystemStatusDto['performance'];
  readonly values: PerformanceSettings;
}) {
  const modes: readonly { readonly value: PerformanceSettings['mode']; readonly label: string; readonly detail: string }[] = [
    { value: 'energy_saver', label: '节能', detail: '降低后台负载与功耗' },
    { value: 'balanced', label: '平衡', detail: '按本机能力动态推荐' },
    { value: 'high_performance', label: '高性能', detail: '可能增加温度与功耗' },
    { value: 'custom', label: '自定义', detail: '逐项设置并发意图' }
  ];

  function planPatch(patch: Partial<PerformanceSettings>, title: string) {
    onPlan({ ...values, ...patch }, title);
  }

  return (
    <div className="uc-settings__groups">
      <SettingsGroup title="1. 性能模式">
        <div className="uc-settings__mode-grid" role="radiogroup" aria-label="性能模式">
          {modes.map((mode) => (
            <button
              aria-checked={values.mode === mode.value}
              className={values.mode === mode.value ? 'is-active' : ''}
              disabled={disabled}
              key={mode.value}
              onClick={() => values.mode !== mode.value && planPatch({ mode: mode.value }, `确认切换到${mode.label}模式`)}
              role="radio"
              type="button"
            >
              <strong>{mode.label}</strong>
              <span>{mode.detail}</span>
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="2. 任务并发">
        {performanceTaskItems.map((item) => {
          const maximum = status.maximums[item.statusKey];
          const recommendation = status.recommendations[item.statusKey];
          const current = values.concurrency[item.key];
          return (
            <SettingRow description={`本机推荐 ${recommendation}，允许范围 1–${maximum}；只影响后续任务。`} key={item.key} label={item.label}>
              <select
                aria-label={`${item.label}并发`}
                disabled={disabled}
                onChange={(event) => onPlan({
                  ...values,
                  mode: 'custom',
                  concurrency: {
                    ...values.concurrency,
                    [item.key]: event.target.value === 'auto' ? 'auto' : Number(event.target.value)
                  }
                }, `确认调整${item.label}并发`)}
                value={String(current)}
              >
                <option value="auto">自动（当前推荐 {recommendation}）</option>
                {Array.from({ length: maximum }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </SettingRow>
          );
        })}
      </SettingsGroup>

      <SettingsGroup title="3. 后台运行与电源">
        <SettingRow description="应用进入后台后继续后续任务。" label="最小化后继续任务">
          <Toggle checked={values.continueInBackground} disabled={disabled} label="最小化后继续任务" onChange={(checked) => planPatch({ continueInBackground: checked }, '确认后台运行策略')} />
        </SettingRow>
        <SettingRow description="有本地任务运行时请求系统保持唤醒。" label="任务运行时防止自动休眠">
          <Toggle checked={values.preventSleepWhileActive} disabled={disabled} label="任务运行时防止自动休眠" onChange={(checked) => planPatch({ preventSleepWhileActive: checked }, '确认休眠策略')} />
        </SettingRow>
        <SettingRow description="设备支持并报告低电量时暂停新负载。" label="低电量时暂停高负载任务">
          <Toggle checked={values.pauseOnLowBattery} disabled={disabled} label="低电量时暂停高负载任务" onChange={(checked) => planPatch({ pauseOnLowBattery: checked }, '确认低电量策略')} />
        </SettingRow>
        <SettingRow description="使用电池时，新任务采用节能意图。" label="使用电池时切换节能模式">
          <Toggle checked={values.switchToEnergySaverOnBattery} disabled={disabled} label="使用电池时切换节能模式" onChange={(checked) => planPatch({ switchToEnergySaverOnBattery: checked }, '确认电池性能策略')} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="4. 任务恢复">
        <SettingRow description="应用重启后继续可恢复的排队任务。" label="恢复排队任务">
          <Toggle checked={values.resumeQueuedTasks} disabled={disabled} label="恢复排队任务" onChange={(checked) => planPatch({ resumeQueuedTasks: checked }, '确认任务恢复策略')} />
        </SettingRow>
        <SettingRow description="只恢复具备恢复证据的下载。" label="恢复未完成下载">
          <Toggle checked={values.resumeDownloads} disabled={disabled} label="恢复未完成下载" onChange={(checked) => planPatch({ resumeDownloads: checked }, '确认下载恢复策略')} />
        </SettingRow>
        <SettingRow description="只恢复具备恢复证据的本地导出。" label="恢复未完成导出">
          <Toggle checked={values.resumeExports} disabled={disabled} label="恢复未完成导出" onChange={(checked) => planPatch({ resumeExports: checked }, '确认导出恢复策略')} />
        </SettingRow>
        <SettingRow description="无法恢复的临时文件仍需通过受控清理计划。" label="清理不可恢复临时文件">
          <Toggle checked={values.cleanupUnrecoverableTemporaryFiles} disabled={disabled} label="清理不可恢复临时文件" onChange={(checked) => planPatch({ cleanupUnrecoverableTemporaryFiles: checked }, '确认临时文件恢复策略')} />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}

function MediaSettingsPanel({ directories, disabled, onChange, onHardware, onMigrateProxy, onRefresh, status, unit, values }: {
  readonly directories: readonly ControlledDirectoryDto[];
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<MediaSettings>) => void;
  readonly onHardware: (value: MediaSettings['hardwareAcceleration']) => void;
  readonly onMigrateProxy: () => void;
  readonly onRefresh: () => void;
  readonly status: SettingsSystemStatusDto['media'];
  readonly unit: GeneralSettings['fileSizeUnit'];
  readonly values: MediaSettings;
}) {
  const proxyDirectory = directoryFor(directories, values.proxyDirectoryId);
  return (
    <div className="uc-settings__groups">
      <SettingsGroup title="1. 本地媒体引擎">
        <div className="uc-settings__metric-grid">
          <Metric label="引擎状态" value={capabilityLabel(status.engine)} />
          <Metric label="适配器" value={status.engine.adapterId ?? '未配置'} />
          <Metric label="版本" value={status.engine.version ?? '未知'} />
          <Metric label="分发范围" value={status.engine.distributionScope === 'development_test_only' ? '仅本地开发/测试' : '未配置'} />
        </div>
        <div className="uc-settings__group-actions">
          <Button disabled={disabled} onClick={onRefresh} variant="secondary">重新检查媒体环境</Button>
          <span>{status.engine.reason ? capabilityReason(status.engine) : '只展示真实探测结果。'}</span>
        </div>
        {status.engine.distributionScope === 'development_test_only' ? (
          <p className="uc-settings__notice uc-settings__notice--warning">当前 `.tools` 媒体引擎仅供本地开发和测试，不是生产组件，也不会进入发布物。</p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="2. 真实能力范围">
        <div className="uc-settings__metric-grid">
          <Metric label="媒体探测" value={yesNo(status.engine.supportsProbe)} />
          <Metric label="预览处理" value={yesNo(status.engine.supportsPreview)} />
          <Metric label="软件导出" value={yesNo(status.engine.supportsSoftwareExport)} />
          <Metric label="硬件状态" value={capabilityLabel(status.hardwareAcceleration)} />
        </div>
      </SettingsGroup>

      <SettingsGroup title="3. 硬件加速与回退">
        <SettingRow description="硬件优先尚未获批准；自动与纯软件仍需确认后保存。" label="加速策略">
          <select aria-label="媒体硬件加速策略" disabled={disabled} onChange={(event) => onHardware(event.target.value as MediaSettings['hardwareAcceleration'])} value={values.hardwareAcceleration}>
            <option value="auto">自动选择</option>
            <option disabled value="prefer_hardware">优先硬件（未获批准）</option>
            <option value="software_only">仅使用软件</option>
          </select>
        </SettingRow>
        <SettingRow description="这是强制安全边界；硬件失败不会阻断软件导出。" label="自动软件回退">
          <Toggle checked={values.automaticSoftwareFallback} disabled label="自动软件回退" onChange={() => undefined} />
        </SettingRow>
        <SettingRow description="来自真实平台状态，不提供未获批的硬件测试按钮。" label="硬件探测">
          <StatusPill tone={capabilityTone(status.hardwareAcceleration)}>{capabilityLabel(status.hardwareAcceleration)}</StatusPill>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="4. 预览代理文件">
        <SettingRow description="仅在预览确有需要时生成可重建代理。" label="生成预览代理">
          <Toggle checked={values.generatePreviewProxy} disabled={disabled} label="生成预览代理" onChange={(checked) => onChange({ generatePreviewProxy: checked })} />
        </SettingRow>
        <SettingRow description="代理不会替代或覆盖原始素材。" label="最终导出读取原文件">
          <Toggle checked={values.exportFromOriginal} disabled label="最终导出读取原文件" onChange={() => undefined} />
        </SettingRow>
        <SettingRow description="当前 B2 只提供逐次清理计划，尚无修改自动规则的受控端口。" label="自动清理过期代理">
          <Toggle checked={values.cleanupExpiredProxies} disabled label="自动清理过期代理" onChange={() => undefined} />
        </SettingRow>
        <SettingRow
          description={proxyDirectory
            ? `${proxyDirectory.displayName} · 可用空间 ${formatBytes(proxyDirectory.freeBytes, unit)}`
            : '使用缓存目录；renderer 不会取得绝对路径。'}
          label="代理保存位置"
        >
          <div className="uc-settings__inline-actions">
            <StatusPill tone={directoryTone(proxyDirectory)}>{directoryLabel(proxyDirectory)}</StatusPill>
            <Button aria-label="选择并迁移预览代理目录" disabled={disabled} onClick={onMigrateProxy} variant="secondary">选择并迁移</Button>
          </div>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}

function PrivacySettingsPanel({ disabled, onOpenSystemSettings, onPlan, status, values }: {
  readonly disabled: boolean;
  readonly onOpenSystemSettings: (target: NativeSystemSettingsTarget) => void;
  readonly onPlan: (values: PrivacySettings) => void;
  readonly status: SettingsSystemStatusDto['privacy'];
  readonly values: PrivacySettings;
}) {
  return (
    <div className="uc-settings__groups">
      <SettingsGroup title="1. 最小授权边界">
        <div className="uc-settings__metric-grid">
          <Metric label="文件访问" value={status.minimumAuthorization.selectedFilesOnly ? '仅用户选择文件' : '状态异常'} />
          <Metric label="项目目录" value={status.minimumAuthorization.authorizedDirectoriesOnly ? '仅授权目录' : '状态异常'} />
          <Metric label="主目录扫描" value={status.minimumAuthorization.homeDirectoryScan ? '异常开启' : '禁止'} />
          <Metric label="后台剪贴板" value={status.minimumAuthorization.backgroundClipboardRead ? '异常开启' : '禁止'} />
        </div>
      </SettingsGroup>

      <SettingsGroup title="2. 系统权限状态">
        {status.permissions.map((permission) => (
          <SettingRow
            description={capabilityReason(permission)}
            key={permission.id}
            label={permission.id === 'files_and_folders' ? '文件与文件夹权限' : '通知权限'}
          >
            <div className="uc-settings__inline-actions">
              <StatusPill tone={capabilityTone(permission)}>{capabilityLabel(permission)}</StatusPill>
              <Button disabled={disabled} onClick={() => onOpenSystemSettings(permission.systemSettingsTarget)} variant="secondary">
                打开系统设置
              </Button>
            </div>
          </SettingRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title="3. 外发与费用确认">
        <SettingRow description="文本任务是否每次都需要确认外发范围。" label="文本外发确认">
          <select aria-label="文本外发确认" disabled={disabled} onChange={(event) => onPlan({ ...values, textOutboundConfirmation: event.target.value as PrivacySettings['textOutboundConfirmation'] })} value={values.textOutboundConfirmation}>
            <option value="each_task">每个任务确认</option>
            <option value="always">始终确认</option>
          </select>
        </SettingRow>
        <SettingRow description="图片和视频提交前必须确认接收方、外发范围和未知费用。" label="多媒体外发确认">
          <div className="uc-settings__inline-actions">
            <StatusPill tone="warning">图片：{outboundLabel(values.imageOutboundConfirmation)}</StatusPill>
            <StatusPill tone="warning">视频：{outboundLabel(values.videoOutboundConfirmation)}</StatusPill>
          </div>
        </SettingRow>
        <SettingRow description="项目上下文和未知费用确认是强制边界，不能被页面关闭。" label="强制确认">
          <div className="uc-settings__inline-actions">
            <StatusPill tone="success">项目上下文：始终确认</StatusPill>
            <StatusPill tone="success">未知费用：始终确认</StatusPill>
          </div>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="4. 数据保护">
        <SettingRow description="只读取用户授权项目上下文，不自动读取未保存聊天。" label="项目上下文读取">
          <Toggle checked={values.readProjectContext} disabled={disabled} label="读取项目上下文" onChange={(checked) => onPlan({ ...values, readProjectContext: checked })} />
        </SettingRow>
        <SettingRow description="已保存项目对话可作为上下文；未保存聊天保持禁止。" label="已保存对话上下文">
          <Toggle checked={values.readSavedProjectChats} disabled={disabled} label="读取已保存项目对话" onChange={(checked) => onPlan({ ...values, readSavedProjectChats: checked })} />
        </SettingRow>
        <SettingRow description="正式作品和原始素材不进入自动清理。" label="清理边界">
          <div className="uc-settings__inline-actions">
            <StatusPill tone="success">{retentionLabel(values.worksRetention)}</StatusPill>
            <StatusPill tone="success">{retentionLabel(values.sourceMediaRetention)}</StatusPill>
          </div>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}

function NetworkSettingsPanel({ disabled, onPlan, status, values }: {
  readonly disabled: boolean;
  readonly onPlan: (next: ProxyMode, credential?: { readonly username: string; readonly secret: string }) => void;
  readonly status: SettingsSystemStatusDto['network'];
  readonly values: NetworkSettings;
}) {
  const [protocol, setProtocol] = useState<Extract<ProxyMode, { kind: 'custom' }>['protocol']>(
    values.proxy.kind === 'custom' ? values.proxy.protocol : 'http'
  );
  const [host, setHost] = useState(values.proxy.kind === 'custom' ? values.proxy.host : '');
  const [port, setPort] = useState(values.proxy.kind === 'custom' ? String(values.proxy.port) : '8080');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const customPort = Number(port);
  const canUseCustom = host.trim().length > 0 && Number.isSafeInteger(customPort) && customPort > 0 && customPort <= 65535;

  function submitCustom(authenticated: boolean) {
    const proxy: ProxyMode = {
      kind: 'custom',
      protocol,
      host: host.trim(),
      port: customPort,
      authenticationConfigured: authenticated
    };
    onPlan(proxy, authenticated ? { username, secret } : undefined);
    setSecret('');
  }

  return (
    <div className="uc-settings__groups">
      <SettingsGroup title="1. 当前代理事实">
        <div className="uc-settings__metric-grid">
          <Metric label="保存意图" value={proxyModeLabel(values.proxy.kind)} />
          <Metric label="当前运行态" value={status.activeMode ? proxyModeLabel(status.activeMode) : '尚未应用'} />
          <Metric label="作用范围" value="仅后续请求" />
          <Metric label="活动请求" value={status.activeRequestsRetried ? '异常重试' : '不重试'} />
        </div>
      </SettingsGroup>

      <SettingsGroup title="2. 代理模式">
        <div className="uc-settings__mode-grid" role="radiogroup" aria-label="网络代理模式">
          {(['system_default', 'system_proxy', 'direct'] as const).map((kind) => (
            <button
              aria-checked={values.proxy.kind === kind}
              className={values.proxy.kind === kind ? 'is-active' : ''}
              disabled={disabled}
              key={kind}
              onClick={() => onPlan({ kind })}
              role="radio"
              type="button"
            >
              <strong>{proxyModeLabel(kind)}</strong>
              <span>{proxyModeDescription(kind)}</span>
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="3. 自定义代理">
        <div className="uc-settings__proxy-form">
          <select aria-label="自定义代理协议" disabled={disabled} onChange={(event) => setProtocol(event.target.value as typeof protocol)} value={protocol}>
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
            <option value="socks5">SOCKS5</option>
          </select>
          <input aria-label="自定义代理主机" disabled={disabled} onChange={(event) => setHost(event.target.value)} placeholder="主机名" type="text" value={host} />
          <input aria-label="自定义代理端口" disabled={disabled} max={65535} min={1} onChange={(event) => setPort(event.target.value)} type="number" value={port} />
        </div>
        <div className="uc-settings__proxy-form">
          <input aria-label="代理用户名" autoComplete="off" disabled={disabled} onChange={(event) => setUsername(event.target.value)} placeholder="用户名（可选）" type="text" value={username} />
          <input aria-label="代理认证值" autoComplete="new-password" disabled={disabled} onChange={(event) => setSecret(event.target.value)} placeholder="认证值（不会回显）" type="password" value={secret} />
          <Button disabled={disabled || !canUseCustom} onClick={() => submitCustom(username.length > 0 || secret.length > 0)} variant="secondary">测试并确认</Button>
        </div>
        <p className="uc-settings__notice">代理测试使用隔离请求，不发送项目内容、提示词、请求正文或服务商凭证。</p>
      </SettingsGroup>

      <SettingsGroup title="4. 连接结果与超时">
        <div className="uc-settings__metric-grid">
          <Metric label="凭证仓储" value={capabilityLabel(status.credentialStorage)} />
          <Metric label="最近测试" value={proxyTestLabel(status.lastTest)} />
          <Metric label="连接超时" value={`${Math.round(values.connectionTimeoutMs / 1000)} 秒`} />
          <Metric label="下载超时" value={`${Math.round(values.downloadTimeoutMs / 1000)} 秒`} />
        </div>
      </SettingsGroup>
    </div>
  );
}

function NotificationsSettingsPanel({ disabled, onChange, onOpenSystemSettings, onTest, result, status, values }: {
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<NotificationSettings>) => void;
  readonly onOpenSystemSettings: (target: NativeSystemSettingsTarget) => void;
  readonly onTest: (system: boolean, sound: boolean) => void;
  readonly result?: NotificationTestResultDto;
  readonly status: SettingsSystemStatusDto['notifications'];
  readonly values: NotificationSettings;
}) {
  function patchRule(event: NotificationSettings['rules'][number]['event'], patch: Partial<NotificationSettings['rules'][number]>) {
    onChange({
      rules: values.rules.map((rule) => rule.event === event ? { ...rule, ...patch } : rule)
    });
  }

  return (
    <div className="uc-settings__groups">
      <SettingsGroup title="1. 通知渠道">
        <div className="uc-settings__metric-grid">
          <Metric label="应用内" value={capabilityLabel(status.inApp)} />
          <Metric label="系统通知" value={capabilityLabel(status.system)} />
          <Metric label="声音" value={capabilityLabel(status.sound)} />
          <Metric label="业务状态" value="不被通知结果改变" />
        </div>
        <div className="uc-settings__group-actions">
          <Button disabled={disabled} onClick={() => onTest(true, true)} variant="secondary">发送测试通知</Button>
          <Button disabled={disabled} onClick={() => onOpenSystemSettings('notifications')} variant="secondary">打开通知设置</Button>
          <span>{result ? `应用内：${result.inApp}，系统：${deliveryLabel(result.system)}，声音：${deliveryLabel(result.sound)}` : '尚未发送本次测试。'}</span>
        </div>
      </SettingsGroup>

      <SettingsGroup title="2. 通知规则">
        {values.rules.map((rule) => (
          <SettingRow description="应用内提醒始终保留；系统与声音按平台能力执行。" key={rule.event} label={notificationEventLabel(rule.event)}>
            <div className="uc-settings__inline-actions">
              <StatusPill tone="success">应用内</StatusPill>
              <Toggle checked={rule.system} disabled={disabled} label={`${notificationEventLabel(rule.event)}系统通知`} onChange={(checked) => patchRule(rule.event, { system: checked })} />
              <Toggle checked={rule.sound} disabled={disabled} label={`${notificationEventLabel(rule.event)}声音提醒`} onChange={(checked) => patchRule(rule.event, { sound: checked })} />
            </div>
          </SettingRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title="3. 合并与关键提醒">
        <SettingRow description="密集完成事件会合并显示，减少打扰。" label="合并任务完成通知">
          <Toggle checked={values.mergeTaskCompletions} disabled={disabled} label="合并任务完成通知" onChange={(checked) => onChange({ mergeTaskCompletions: checked })} />
        </SettingRow>
        <SettingRow description="失败和需要确认必须留在应用内提醒中。" label="关键提醒可见">
          <StatusPill tone="success">{values.keepUserActionVisible ? '保持可见' : '状态异常'}</StatusPill>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}

function ShortcutsSettingsPanel({ disabled, onPlan, onRestore, status, values }: {
  readonly disabled: boolean;
  readonly onPlan: (platform: ShortcutPlatform, bindings: readonly ShortcutBinding[]) => void;
  readonly onRestore: (platform: ShortcutPlatform) => void;
  readonly status: SettingsSystemStatusDto['shortcuts'];
  readonly values: ShortcutSettings;
}) {
  const [platform, setPlatform] = useState<ShortcutPlatform>(status.platform);
  const [edits, setEdits] = useState<Readonly<Record<string, string>>>({});
  const stored = new Map(values.bindings.map((binding) => [binding.actionId, binding]));

  function currentValue(actionId: string) {
    const action = status.actions.find((item) => item.actionId === actionId);
    const binding = stored.get(actionId);
    return edits[actionId] ?? (binding ? binding[platform] : action?.defaults[platform]) ?? '';
  }

  function submit() {
    onPlan(platform, status.actions.map((action) => ({
      actionId: action.actionId,
      windows: platform === 'windows' ? currentValue(action.actionId) || null : stored.get(action.actionId)?.windows ?? action.defaults.windows,
      macos: platform === 'macos' ? currentValue(action.actionId) || null : stored.get(action.actionId)?.macos ?? action.defaults.macos
    })));
  }

  return (
    <div className="uc-settings__groups">
      <SettingsGroup title="1. 平台与注册状态">
        <div className="uc-settings__metric-grid">
          <Metric label="注册表版本" value={`V${status.registryVersion}`} />
          <Metric label="当前平台" value={platformLabel(status.platform)} />
          <Metric label="全局快捷键" value={`${status.activeGlobalActionIds.length} 个已注册`} />
          <Metric label="保存范围" value="平台隔离" />
        </div>
      </SettingsGroup>

      <SettingsGroup title="2. 编辑快捷键">
        <div className="uc-settings__group-actions">
          <select aria-label="快捷键平台" disabled={disabled} onChange={(event) => setPlatform(event.target.value as ShortcutPlatform)} value={platform}>
            <option value="windows">Windows</option>
            <option value="macos">macOS</option>
          </select>
          <Button disabled={disabled} onClick={submit} variant="secondary">检查并确认保存</Button>
          <Button disabled={disabled} onClick={() => onRestore(platform)} variant="ghost">恢复本平台默认</Button>
        </div>
        <div className="uc-settings__shortcut-list">
          {status.actions.map((action) => (
            <SettingRow
              description={`${action.scope === 'global' ? '全局' : '应用内'} · 默认 ${action.defaults[platform] ?? '未设置'}${action.mutable ? '' : ' · 不可修改'}`}
              key={action.actionId}
              label={shortcutActionLabel(action.actionId)}
            >
              <input
                aria-label={`${shortcutActionLabel(action.actionId)}快捷键`}
                disabled={disabled || !action.mutable}
                onChange={(event) => setEdits({ ...edits, [action.actionId]: event.target.value })}
                type="text"
                value={currentValue(action.actionId)}
              />
            </SettingRow>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="3. 冲突规则">
        <p className="uc-settings__notice">保存前会拒绝未知动作、不可修改动作、非法按键、重复键和系统保留键；注册失败会恢复旧绑定。</p>
      </SettingsGroup>
    </div>
  );
}

function SystemStatusUnavailable({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <EmptyState
      action={<Button onClick={onRetry} variant="secondary">重新读取本机状态</Button>}
      description={message}
      icon="检"
      readOnly
      title="本机动态状态暂不可用"
    />
  );
}

function CategorySystemStatus({ activeCategory, status, unit }: {
  readonly activeCategory: SettingsCategory;
  readonly status: SettingsSystemStatusDto;
  readonly unit: GeneralSettings['fileSizeUnit'];
}) {
  if (activeCategory === 'storage') {
    const abnormal = status.storage.directories.filter((directory) => directory.state !== 'available').length;
    return (
      <section className="uc-settings__status-card">
        <h3>存储动态状态</h3>
        <dl className="uc-settings__facts">
          <Fact label="应用管理文件" value={formatBytes(status.storage.appUsage.totalBytes, unit)} />
          <Fact label="受控目录" value={`${status.storage.directories.length} 个`} />
          <Fact label="异常目录" value={abnormal ? `${abnormal} 个` : '无'} />
        </dl>
      </section>
    );
  }
  if (activeCategory === 'performance') {
    return (
      <section className="uc-settings__status-card">
        <h3>本机资源与负载</h3>
        <dl className="uc-settings__facts">
          <Fact label="逻辑处理器" value={`${status.performance.logicalCpuCount} 个`} />
          <Fact label="可用内存" value={formatBytes(status.performance.freeMemoryBytes, unit)} />
          <Fact label="当前负载" value={status.performance.currentLoadPercent === null ? '动态统计不可用' : `${status.performance.currentLoadPercent}%`} />
          <Fact label="活动任务" value={status.performance.activeTaskCount === null ? '动态统计不可用' : `${status.performance.activeTaskCount} 个`} />
        </dl>
      </section>
    );
  }
  if (activeCategory === 'media') {
    return (
      <section className="uc-settings__status-card">
        <h3>媒体与回退</h3>
        <dl className="uc-settings__facts">
          <Fact label="媒体引擎" value={capabilityLabel(status.media.engine)} />
          <Fact label="组件范围" value={status.media.engine.distributionScope === 'development_test_only' ? '仅开发/测试' : '未配置'} />
          <Fact label="硬件加速" value={capabilityLabel(status.media.hardwareAcceleration)} />
          <Fact label="软件回退" value={status.media.automaticSoftwareFallback ? '已启用' : '未启用'} />
        </dl>
      </section>
    );
  }
  if (activeCategory === 'privacy') {
    return (
      <section className="uc-settings__status-card">
        <h3>隐私与权限</h3>
        <dl className="uc-settings__facts">
          <Fact label="文件访问" value={status.privacy.minimumAuthorization.selectedFilesOnly ? '仅用户选择' : '状态异常'} />
          <Fact label="目录访问" value={status.privacy.minimumAuthorization.authorizedDirectoriesOnly ? '仅授权目录' : '状态异常'} />
          <Fact label="后台剪贴板" value={status.privacy.minimumAuthorization.backgroundClipboardRead ? '状态异常' : '禁止'} />
          <Fact label="未知费用" value={status.privacy.minimumAuthorization.unknownCostConfirmationMandatory ? '必须确认' : '状态异常'} />
        </dl>
      </section>
    );
  }
  if (activeCategory === 'network') {
    return (
      <section className="uc-settings__status-card">
        <h3>网络与代理</h3>
        <dl className="uc-settings__facts">
          <Fact label="运行态" value={status.network.activeMode ? proxyModeLabel(status.network.activeMode) : '尚未应用'} />
          <Fact label="作用范围" value="仅后续请求" />
          <Fact label="活动请求" value={status.network.activeRequestsRetried ? '异常重试' : '不重试'} />
          <Fact label="最近测试" value={proxyTestLabel(status.network.lastTest)} />
        </dl>
      </section>
    );
  }
  if (activeCategory === 'notifications') {
    return (
      <section className="uc-settings__status-card">
        <h3>通知渠道</h3>
        <dl className="uc-settings__facts">
          <Fact label="应用内" value={capabilityLabel(status.notifications.inApp)} />
          <Fact label="系统通知" value={capabilityLabel(status.notifications.system)} />
          <Fact label="声音" value={capabilityLabel(status.notifications.sound)} />
          <Fact label="业务状态" value="不受通知影响" />
        </dl>
      </section>
    );
  }
  if (activeCategory === 'shortcuts') {
    return (
      <section className="uc-settings__status-card">
        <h3>快捷键</h3>
        <dl className="uc-settings__facts">
          <Fact label="平台" value={platformLabel(status.shortcuts.platform)} />
          <Fact label="动作注册表" value={`V${status.shortcuts.registryVersion}`} />
          <Fact label="动作数量" value={`${status.shortcuts.actions.length} 个`} />
          <Fact label="已注册全局键" value={`${status.shortcuts.activeGlobalActionIds.length} 个`} />
        </dl>
      </section>
    );
  }
  return null;
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="uc-settings__metric"><span>{label}</span><strong>{value}</strong></div>;
}

function SettingsGroup({ children, title }: { readonly children: ReactNode; readonly title: string }) {
  return (
    <section className="uc-settings__group">
      <h3>{title}</h3>
      <div>{children}</div>
    </section>
  );
}

function SettingRow({ children, description, label }: { readonly children: ReactNode; readonly description: string; readonly label: string }) {
  return (
    <div className="uc-settings__row">
      <div>
        <strong>{label}</strong>
        <span>{description}</span>
      </div>
      <div className="uc-settings__control">{children}</div>
    </div>
  );
}

function Toggle({ checked, disabled, label, onChange }: { readonly checked: boolean; readonly disabled: boolean; readonly label: string; readonly onChange: (checked: boolean) => void }) {
  return (
    <label className="uc-settings__toggle">
      <input aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      <span aria-hidden="true" />
    </label>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function CapabilityStatus({ capability, label }: { readonly capability?: SettingsCapabilityDto; readonly label: string }) {
  return (
    <div className="uc-settings__capability">
      <span>{label}</span>
      <StatusPill tone={capabilityTone(capability)}>{capabilityLabel(capability)}</StatusPill>
    </div>
  );
}

function ConfirmOperationDialog({ busy, copy, onCancel, onConfirm, plan }: {
  readonly busy: boolean;
  readonly copy: OperationCopy;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly plan: SettingsOperationPlanDto;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog aria-labelledby="settings-operation-title" className="uc-settings__dialog" onCancel={onCancel} ref={dialogRef}>
      <h2 id="settings-operation-title">{copy.title}</h2>
      <p>{copy.description}</p>
      <dl className="uc-settings__facts">
        <Fact label="设置变化" value={`${plan.changedValueCount} 项`} />
        <Fact label="预计文件" value={plan.impact?.fileCount === undefined ? '不涉及或未知' : `${plan.impact.fileCount} 个`} />
        <Fact label="预计容量" value={plan.impact?.bytes === undefined ? '不涉及或未知' : formatBytes(plan.impact.bytes, 'auto')} />
        <Fact label="可回退" value={plan.reversible ? '是' : '否'} />
        <Fact label="活动任务" value={plan.impact?.activeTasksUnaffected ? '不受影响' : '不涉及或按计划复检'} />
        <Fact label="旧位置" value={plan.impact?.oldLocationRetained ? '保留' : '不涉及'} />
        <Fact label="待重启" value={plan.pendingRestart.length ? `${plan.pendingRestart.length} 项` : '无'} />
        <Fact label="确认有效期" value={new Date(plan.expiresAt).toLocaleTimeString()} />
      </dl>
      {plan.warnings?.length ? (
        <div className="uc-settings__dialog-note" role="status">
          <strong>影响说明</strong>
          <ul>{plan.warnings.map((warning) => <li key={warning}>{operationCodeLabel(warning)}</li>)}</ul>
        </div>
      ) : null}
      {plan.blockers.length ? (
        <div className="uc-settings__dialog-note uc-settings__dialog-note--danger" role="alert">
          <strong>当前不能执行</strong>
          <ul>{plan.blockers.map((blocker) => <li key={blocker}>{operationCodeLabel(blocker)}</li>)}</ul>
        </div>
      ) : null}
      <div className="uc-settings__dialog-actions">
        <Button autoFocus disabled={busy} onClick={onCancel} variant="ghost">取消</Button>
        <Button disabled={busy || plan.blockers.length > 0} onClick={onConfirm}>确认执行</Button>
      </div>
    </dialog>
  );
}

function directoryFor(
  directories: readonly ControlledDirectoryDto[],
  id: string | null
): ControlledDirectoryDto | undefined {
  return id ? directories.find((directory) => directory.id === id) : undefined;
}

function directoryLabel(directory?: ControlledDirectoryDto): string {
  return directory ? capabilityLabel(directory) : '应用默认';
}

function directoryTone(directory?: ControlledDirectoryDto): StatusTone {
  return directory ? capabilityTone(directory) : 'info';
}

function yesNo(value: boolean): string {
  return value ? '支持' : '不支持';
}

function outboundLabel(value: PrivacySettings['textOutboundConfirmation'] | PrivacySettings['imageOutboundConfirmation'] | PrivacySettings['videoOutboundConfirmation']): string {
  return value === 'always' ? '始终确认' : '每次提交确认';
}

function retentionLabel(value: PrivacySettings['worksRetention'] | PrivacySettings['sourceMediaRetention']): string {
  return value === 'never_auto_cleanup' ? '不自动清理' : '状态异常';
}

function proxyModeLabel(kind: ProxyMode['kind']): string {
  const labels: Record<ProxyMode['kind'], string> = {
    system_default: '系统默认',
    system_proxy: '系统代理',
    custom: '自定义代理',
    direct: '直连'
  };
  return labels[kind];
}

function proxyModeDescription(kind: Exclude<ProxyMode['kind'], 'custom'>): string {
  const labels: Record<Exclude<ProxyMode['kind'], 'custom'>, string> = {
    system_default: '遵循应用默认网络策略。',
    system_proxy: '读取系统代理事实。',
    direct: '后续请求不使用代理。'
  };
  return labels[kind];
}

function proxyTestLabel(result: SettingsSystemStatusDto['network']['lastTest']): string {
  if (!result) return '尚未测试';
  return result.ok ? `已到达 ${new Date(result.reachedAt).toLocaleTimeString()}` : `失败：${proxyFailureLabel(result.failure)}`;
}

function proxyFailureLabel(failure: Exclude<SettingsSystemStatusDto['network']['lastTest'], null | { readonly ok: true }>['failure']): string {
  const labels: Record<typeof failure, string> = {
    dns: 'DNS',
    certificate: '证书',
    authentication: '认证',
    timeout: '超时',
    unknown: '未知'
  };
  return labels[failure];
}

function deliveryLabel(value: NotificationTestResultDto['system']): string {
  const labels: Record<NotificationTestResultDto['system'], string> = {
    accepted: '已提交',
    denied: '被拒绝',
    unsupported: '不支持',
    failed: '失败',
    not_requested: '未请求'
  };
  return labels[value];
}

function notificationEventLabel(event: NotificationSettings['rules'][number]['event']): string {
  const labels: Record<NotificationSettings['rules'][number]['event'], string> = {
    task_completed: '任务完成',
    task_failed: '任务失败',
    user_action_required: '需要确认',
    download_completed: '下载完成',
    export_completed: '导出完成',
    storage_insufficient: '空间不足',
    service_connection_failed: '服务连接失效',
    update_available: '更新可用',
    local_component_failed: '本地组件异常'
  };
  return labels[event];
}

function platformLabel(platform: ShortcutPlatform): string {
  return platform === 'windows' ? 'Windows' : 'macOS';
}

function shortcutActionLabel(actionId: string): string {
  const labels: Record<string, string> = {
    show_app: '显示应用',
    new_project: '新建项目',
    open_settings: '打开设置',
    focus_search: '聚焦搜索',
    cancel_current_action: '取消当前操作'
  };
  return labels[actionId] ?? actionId;
}

function formatBytes(bytes: number | null, unit: GeneralSettings['fileSizeUnit']): string {
  if (bytes === null || !Number.isFinite(bytes)) return '未知';
  if (bytes === 0) return '0 B';
  const binary = unit !== 'decimal';
  const base = binary ? 1024 : 1000;
  const labels = binary ? ['B', 'KiB', 'MiB', 'GiB', 'TiB'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(base)), labels.length - 1);
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(bytes / base ** index)} ${labels[index]}`;
}

function operationCodeLabel(code: string): string {
  const labels: Record<string, string> = {
    changes_apply_only_to_new_tasks_and_attempts: '只影响后续任务和新的 attempt，活动任务保持不变。',
    outbound_confirmation_mandatory: '外发确认是强制边界，不能被关闭。',
    unknown_cost_confirmation_mandatory: '未知费用确认是强制边界，不能被关闭。',
    minimum_authorization_mandatory: '最小授权策略必须保留。',
    proxy_probe_failed_dns: '代理测试失败：DNS 解析失败。',
    proxy_probe_failed_certificate: '代理测试失败：证书校验失败。',
    proxy_probe_failed_authentication: '代理测试失败：认证失败。',
    proxy_probe_failed_timeout: '代理测试失败：连接超时。',
    proxy_probe_failed_unknown: '代理测试失败：原因未知。',
    shortcut_unknown_action: '快捷键包含未知动作。',
    shortcut_immutable_action: '不可修改快捷键不能改变。',
    shortcut_invalid: '快捷键格式无效。',
    shortcut_duplicate: '快捷键存在重复冲突。',
    shortcut_system_reserved: '快捷键被系统保留。',
    software_export_remains_available: '软件导出继续可用，不会因硬件状态失败而阻断。',
    hardware_acceleration_not_approved: '硬件加速尚未获批准，当前不能启用。',
    target_conflict: '目标目录不是空目录，不能覆盖现有文件。',
    insufficient_space: '目标目录可用空间不足。',
    directory_disconnected: '源目录或目标目录当前不可用。',
    directory_permission_denied: '目录读写权限不足。',
    directory_overlap: '源目录和目标目录不能相同或互为父子目录。',
    unsafe_scan_root: '不能选择磁盘根目录或用户主目录。',
    scan_limit_exceeded: '目录内容超过安全扫描上限。'
  };
  return labels[code] ?? `操作被平台阻止（${code}）。`;
}

function capabilityFor(snapshot: SettingsSnapshotDto | undefined, id: string) {
  return snapshot?.capabilities.find((capability) => capability.id === id);
}

function capabilityLabel(capability?: SettingsCapabilityDto): string {
  if (!capability) return '尚未探测';
  const labels: Record<SettingsCapabilityDto['state'], string> = {
    available: '可用', unavailable: '暂不可用', permission_required: '需要权限',
    unsupported: '平台不支持', unknown: '状态未知', failed: '探测失败'
  };
  return labels[capability.state];
}

function capabilityTone(capability?: SettingsCapabilityDto): StatusTone {
  if (capability?.state === 'available') return 'success';
  if (capability?.state === 'permission_required') return 'warning';
  if (capability?.state === 'failed') return 'danger';
  return 'neutral';
}

function capabilityReason(capability?: SettingsCapabilityDto): string {
  if (!capability) return '尚未取得真实能力状态。';
  if (capability.reason === 'phase8_platform_adapter_pending') {
    return '平台适配器尚未接入，因此不提供可执行控件。';
  }
  return capability.reason ?? `当前状态：${capabilityLabel(capability)}。`;
}

function repositoryLabel(source: SettingsSnapshotDto['statuses']['repository']): string {
  if (source === 'primary') return '主设置文件';
  if (source === 'backup') return '已验证备份';
  return '版本化默认值';
}

function snapshotSourceMessage(snapshot: SettingsSnapshotDto): string {
  if (snapshot.statuses.repository === 'backup') {
    return `已从有效备份读取，revision ${snapshot.revision}；损坏证据没有被覆盖。`;
  }
  if (snapshot.statuses.repository === 'default') {
    return '正在使用版本化默认值；第一次修改成功后才写入本机设置文件。';
  }
  return `已保存到此设备，revision ${snapshot.revision}。`;
}

function saveStateLabel(state: SaveState): string {
  const labels: Record<SaveState, string> = {
    loading: '读取中', saved: '已自动保存', saving: '保存中',
    failed: '保存失败', conflict: '设置冲突'
  };
  return labels[state];
}

function saveStateTone(state: SaveState): StatusTone {
  if (state === 'saved') return 'success';
  if (state === 'loading' || state === 'saving') return 'info';
  if (state === 'conflict') return 'warning';
  return 'danger';
}

function settingsErrorMessage(code: SettingsIpcErrorCode): string {
  if (code === 'revision_conflict') return '设置已在其他窗口改变；请重新载入后再修改，当前待保存值未被写入。';
  if (code === 'settings_read_failed') return '读取设置失败；不会用默认值覆盖损坏文件。';
  if (code === 'settings_write_failed') return '保存失败；页面中的待保存值仍保留，可以重试。';
  if (code === 'confirmation_required') return '该变化属于高风险操作，不能通过普通自动保存执行。';
  if (code === 'operation_expired') return '确认已过期，请重新生成影响计划。';
  if (code === 'operation_not_found') return '确认已使用或不存在，请重新生成影响计划。';
  if (code === 'operation_unsupported') return '当前版本不支持该受控操作。';
  if (code === 'operation_blocked') return '当前事实阻止执行；请查看影响计划中的阻断原因。';
  if (code === 'operation_failed') return '操作未完成；当前有效设置和正式文件不会被标记为已切换。';
  return '设置请求无效，当前设置没有改变。';
}
