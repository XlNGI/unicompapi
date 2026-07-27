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
  PerformanceSettings,
  SettingsCategory,
  SettingsValues,
  StorageSettings
} from '../../domain';
import type {
  CleanupScope,
  ControlledDirectoryDto,
  DirectoryPurpose,
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
    capabilityId: 'permission_controls', delivery: '等待 B3 与 A3',
    keywords: '隐私 权限 文件 外发 剪贴板'
  },
  {
    id: 'network', label: '网络与代理', icon: LuWifi,
    description: '系统代理、连接与超时',
    capabilityId: 'proxy_controls', delivery: '等待 B3 与 A3',
    keywords: '网络 代理 连接 DNS 证书 超时'
  },
  {
    id: 'notifications', label: '通知', icon: LuBell,
    description: '应用内、系统与声音提醒',
    capabilityId: 'notification_controls', delivery: '等待 B3 与 A3',
    keywords: '通知 提醒 声音 系统'
  },
  {
    id: 'shortcuts', label: '快捷键', icon: LuKeyboard,
    description: 'Windows 与 macOS 按键映射',
    capabilityId: 'shortcut_controls', delivery: '等待 B3 与 A3',
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

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const visibleCategories = categories.filter((category) =>
    `${category.label} ${category.description} ${category.keywords}`
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery)
  );
  const category = categories.find((item) => item.id === activeCategory) ?? categories[0];
  const capability = capabilityFor(snapshot, category.capabilityId);
  const isB2Category = ['storage', 'performance', 'media'].includes(activeCategory);
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
          ) : isB2Category ? (
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
          ) : isB2Category && values && systemStatus ? (
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
            ) : (
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
            )
          ) : isB2Category ? (
            <SystemStatusUnavailable
              message={systemStatusError || '正在读取真实目录、设备负载和媒体组件状态…'}
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
            <p>{isB2Category ? '高风险操作必须先展示真实影响计划，再由你确认执行。' : '未接平台适配器的分类只显示不可用，不提供假控件。'}</p>
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
