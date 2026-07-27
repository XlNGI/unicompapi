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
  SettingsCategory,
  SettingsValues
} from '../../domain';
import type {
  SettingsCapabilityDto,
  SettingsIpcErrorCode,
  SettingsOperationPlanDto,
  SettingsSnapshotDto
} from '../../shared/settings-ipc';
import { useTheme } from '../../theme/useTheme';
import '../../styles/pages.css';

type SaveState = 'loading' | 'saved' | 'saving' | 'failed' | 'conflict';

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
    capabilityId: 'directory_operations', delivery: '等待 B2 与 A2',
    keywords: '目录 容量 磁盘 文件 迁移 清理'
  },
  {
    id: 'performance', label: '任务与性能', icon: LuGauge,
    description: '并发、后台运行与设备负载',
    capabilityId: 'task_policy', delivery: '等待 B2 与 A2',
    keywords: '任务 性能 并发 后台 CPU GPU 内存'
  },
  {
    id: 'media', label: '本地媒体处理', icon: LuMonitorPlay,
    description: '本机媒体组件与硬件能力',
    capabilityId: 'media_components', delivery: '等待 B2 与 A2',
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
  const [operationPlan, setOperationPlan] = useState<SettingsOperationPlanDto>();
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

  async function planGeneralRestore() {
    if (!settings || !snapshot || operationBusy) return;
    setOperationBusy(true);
    try {
      const result = await settings.planOperation(snapshot.revision, {
        kind: 'restore_category_defaults',
        category: 'general'
      });
      if (!result.ok) {
        setSaveState(result.error.code === 'revision_conflict' ? 'conflict' : 'failed');
        setMessage(settingsErrorMessage(result.error.code));
        return;
      }
      if (result.value.changedValueCount === 0) {
        setMessage('常规设置已经是默认值，没有需要恢复的内容。');
        return;
      }
      setOperationPlan(result.value);
    } catch {
      setMessage('无法生成恢复影响计划，当前设置没有改变。');
    } finally {
      setOperationBusy(false);
    }
  }

  async function executeRestore() {
    if (!settings || !operationPlan || operationBusy) return;
    setOperationBusy(true);
    try {
      const result = await settings.executeOperation(operationPlan.confirmationHandle);
      setOperationPlan(undefined);
      if (!result.ok) {
        setSaveState(result.error.code === 'revision_conflict' ? 'conflict' : 'failed');
        setMessage(settingsErrorMessage(result.error.code));
        return;
      }
      acceptSnapshot(result.value);
      setMessage('常规设置已恢复默认并保存到此设备。');
    } catch {
      setOperationPlan(undefined);
      setMessage('恢复默认失败，原设置保持不变。');
    } finally {
      setOperationBusy(false);
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const visibleCategories = categories.filter((category) =>
    `${category.label} ${category.description} ${category.keywords}`
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery)
  );
  const category = categories.find((item) => item.id === activeCategory) ?? categories[0];
  const capability = capabilityFor(snapshot, category.capabilityId);
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
          <Button
            disabled={!snapshot || disabled}
            onClick={() => void planGeneralRestore()}
            variant="secondary"
          >
            恢复常规默认
          </Button>
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
          <section className="uc-settings__status-card">
            <h3>安全边界</h3>
            <p>当前页面不会显示设置文件路径、凭证、日志原文或设备句柄。</p>
            <p>未接平台适配器的分类只显示不可用，不提供假控件。</p>
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

      {operationPlan ? (
        <ConfirmRestoreDialog
          busy={operationBusy}
          onCancel={() => setOperationPlan(undefined)}
          onConfirm={() => void executeRestore()}
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

function ConfirmRestoreDialog({ busy, onCancel, onConfirm, plan }: { readonly busy: boolean; readonly onCancel: () => void; readonly onConfirm: () => void; readonly plan: SettingsOperationPlanDto }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog aria-labelledby="restore-general-title" className="uc-settings__dialog" onCancel={onCancel} ref={dialogRef}>
      <h2 id="restore-general-title">确认恢复常规默认</h2>
      <p>这会修改 {plan.changedValueCount} 项本机常规设置，并生成新的 revision。</p>
      <dl className="uc-settings__facts">
        <Fact label="可回退" value={plan.reversible ? '是' : '否'} />
        <Fact label="待重启" value={plan.pendingRestart.length ? `${plan.pendingRestart.length} 项` : '无'} />
        <Fact label="确认有效期" value={new Date(plan.expiresAt).toLocaleTimeString()} />
      </dl>
      <div className="uc-settings__dialog-actions">
        <Button autoFocus disabled={busy} onClick={onCancel} variant="ghost">取消</Button>
        <Button disabled={busy || plan.blockers.length > 0} onClick={onConfirm}>确认恢复</Button>
      </div>
    </dialog>
  );
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
  return '设置请求无效，当前设置没有改变。';
}
