import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { Notification } from 'rsuite';
import { Button } from '../../components/Button';
import type { StorageTaskSummaryDto } from '../../shared/storage-ipc';

export type GlobalNotificationKind = 'progress' | 'success' | 'warning' | 'error';
export type GlobalNotificationPlacement = 'top-end' | 'bottom-start';

export interface GlobalNotificationInput {
  readonly id: string;
  readonly kind: GlobalNotificationKind;
  readonly title: string;
  readonly description: string;
  readonly placement?: GlobalNotificationPlacement;
  readonly action?: {
    readonly label: string;
    readonly onClick: () => void;
  };
  readonly tracking?: {
    readonly mediaKind: 'image' | 'video';
    readonly sourceDraftId: string;
    readonly taskId?: string;
  };
}

interface GlobalNotificationItem extends GlobalNotificationInput {
  readonly createdAt: number;
}

interface GlobalNotificationContextValue {
  readonly dismiss: (id: string) => void;
  readonly show: (notification: GlobalNotificationInput) => void;
}

const GlobalNotificationContext = createContext<GlobalNotificationContextValue | undefined>(
  undefined
);

const successDurationMs = 5_000;

export function GlobalNotificationProvider({ children }: { readonly children: ReactNode }) {
  const [notifications, setNotifications] = useState<readonly GlobalNotificationItem[]>([]);
  const successTimers = useRef(new Map<string, number>());

  const clearSuccessTimer = useCallback((id: string) => {
    const timer = successTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      successTimers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback((id: string) => {
    clearSuccessTimer(id);
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, [clearSuccessTimer]);

  const show = useCallback((notification: GlobalNotificationInput) => {
    clearSuccessTimer(notification.id);
    setNotifications((current) => {
      const previous = current.find((item) => item.id === notification.id);
      if (previous && sameNotification(previous, notification)) return current;
      const next: GlobalNotificationItem = {
        ...notification,
        createdAt: previous && (previous.tracking || !notification.tracking)
          ? previous.createdAt
          : Date.now()
      };
      return previous
        ? current.map((item) => item.id === notification.id ? next : item)
        : [...current, next];
    });
    if (notification.kind === 'success') {
      const timer = window.setTimeout(() => {
        successTimers.current.delete(notification.id);
        setNotifications((current) => current.filter((item) => item.id !== notification.id));
      }, successDurationMs);
      successTimers.current.set(notification.id, timer);
    }
  }, [clearSuccessTimer]);

  useEffect(() => {
    const tracked = notifications.filter(
      (item) => item.kind === 'progress' && item.tracking
    );
    const storage = window.unicomp?.storage;
    if (!storage || tracked.length === 0) return;
    let active = true;

    const refresh = async () => {
      try {
        const result = await storage.listTasks();
        if (!active || !result.ok) return;
        for (const notification of tracked) {
          const task = await findTrackedTask(
            storage,
            result.value.items,
            notification
          );
          if (!active || !task) continue;
          const state = task.latestExecutionState;
          const mediaLabel = notification.tracking?.mediaKind === 'image' ? '图片' : '视频';
          if (state === 'completed') {
            show({
              id: notification.id,
              kind: 'success',
              title: '已成功生成',
              description: `任务中心确认${mediaLabel}任务已完成。`
            });
          } else if (terminalFailureStates.has(state ?? '')) {
            show({
              id: notification.id,
              kind: 'error',
              title: `${mediaLabel}生成未完成`,
              description: taskFailureDescription(state)
            });
          } else {
            show({
              ...notification,
              title: `${mediaLabel}生成中`,
              description: taskProgressDescription(state),
              tracking: {
                ...notification.tracking!,
                taskId: task.taskId
              }
            });
          }
        }
      } catch {
        // The existing task center remains the source of truth when this UI read is unavailable.
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [notifications, show]);

  useEffect(() => () => {
    successTimers.current.forEach((timer) => window.clearTimeout(timer));
    successTimers.current.clear();
  }, []);

  const context = useMemo(() => ({ dismiss, show }), [dismiss, show]);
  const topEnd = notifications.filter(
    (item) => notificationPlacement(item) === 'top-end'
  );
  const bottomStart = notifications.filter(
    (item) => notificationPlacement(item) === 'bottom-start'
  );

  return (
    <GlobalNotificationContext.Provider value={context}>
      {children}
      <NotificationViewport
        items={topEnd}
        onDismiss={dismiss}
        placement="top-end"
      />
      <NotificationViewport
        items={bottomStart}
        onDismiss={dismiss}
        placement="bottom-start"
      />
    </GlobalNotificationContext.Provider>
  );
}

export function useGlobalNotifications(): GlobalNotificationContextValue {
  const context = useContext(GlobalNotificationContext);
  if (!context) {
    throw new Error('useGlobalNotifications must be used inside GlobalNotificationProvider');
  }
  return context;
}

function NotificationViewport({ items, onDismiss, placement }: {
  readonly items: readonly GlobalNotificationItem[];
  readonly onDismiss: (id: string) => void;
  readonly placement: GlobalNotificationPlacement;
}) {
  if (items.length === 0) return null;
  return (
    <div
      aria-label={placement === 'top-end' ? '应用状态与失败通知' : '应用成功通知'}
      className={`uc-global-notifications uc-global-notifications--${placement}`}
    >
      {items.map((item) => (
        <div
          className={`uc-global-notifications__item uc-global-notifications__item--${item.kind}`}
          key={item.id}
          role={item.kind === 'error' || item.kind === 'warning' ? 'alert' : 'status'}
        >
          <Notification
            closable={item.kind === 'error' || item.kind === 'warning'}
            header={
              <span className="uc-global-notifications__title">
                {item.title}
              </span>
            }
            onClose={() => onDismiss(item.id)}
            type={notificationType(item.kind)}
          >
            <p>{item.description}</p>
            {item.action ? (
              <Button
                className="uc-global-notifications__action"
                onClick={item.action.onClick}
                variant="secondary"
              >
                {item.action.label}
              </Button>
            ) : null}
          </Notification>
          {item.kind === 'progress' || item.kind === 'success' ? (
            <span
              aria-hidden="true"
              className={`uc-global-notifications__progress uc-global-notifications__progress--${item.kind}`}
              style={item.kind === 'success'
                ? { animationDuration: `${successDurationMs}ms` }
                : undefined}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function notificationType(
  kind: GlobalNotificationKind
): 'info' | 'success' | 'warning' | 'error' {
  if (kind === 'progress') return 'info';
  if (kind === 'success') return 'success';
  if (kind === 'warning') return 'warning';
  if (kind === 'error') return 'error';
  return 'info';
}

function notificationPlacement(
  notification: GlobalNotificationInput
): GlobalNotificationPlacement {
  return notification.placement ?? (notification.kind === 'success' ? 'bottom-start' : 'top-end');
}

const terminalFailureStates = new Set([
  'cancelled',
  'submission_outcome_unknown',
  'cancellation_unknown',
  'needs_user_action',
  'interrupted',
  'recovery_required',
  'failed',
  'expired'
]);

async function findTrackedTask(
  storage: NonNullable<typeof window.unicomp>['storage'],
  tasks: readonly StorageTaskSummaryDto[],
  notification: GlobalNotificationItem
): Promise<StorageTaskSummaryDto | undefined> {
  const tracking = notification.tracking;
  if (!tracking) return undefined;
  if (tracking.taskId) {
    return tasks.find((task) => task.taskId === tracking.taskId);
  }
  const expectedKind = `${tracking.mediaKind}_generation`;
  const candidates = tasks.filter((task) =>
    task.kind === expectedKind &&
    Date.parse(task.createdAt) >= notification.createdAt - 60_000
  );
  const details = await Promise.all(
    candidates.map(async (task) => {
      const result = await storage.getTaskDetails(task.taskId);
      return result.ok && result.value?.sourceDraftId === tracking.sourceDraftId
        ? task
        : undefined;
    })
  );
  return details.find((task) => task !== undefined);
}

function taskProgressDescription(state?: string): string {
  if (!state || state === 'created') return '任务已创建，正在等待处理。';
  if (state === 'submitting') return '正在向服务商提交生成请求。';
  if (state === 'queued') return '服务商已受理，当前正在排队。';
  if (state === 'processing') return '服务商正在生成。';
  if (state === 'remote_completed') return '远端生成已完成，正在准备获取结果。';
  if (state === 'downloading') return '正在下载生成结果。';
  if (['writing', 'writing_file'].includes(state)) return '正在写入本地结果。';
  if (['verifying', 'verifying_file'].includes(state)) return '正在校验本地结果。';
  if (state === 'registering_work') return '正在登记本地作品。';
  if (['validating_sources', 'preparing_media', 'encoding'].includes(state)) {
    return '正在进行本地媒体处理。';
  }
  if (state === 'cancel_requested') return '取消请求已记录，正在等待真实停止结果。';
  return '任务状态正在更新，详情以任务中心为准。';
}

function taskFailureDescription(state?: string): string {
  if (state === 'cancelled') return '任务已取消，没有生成新作品。';
  if (state === 'expired') return '任务已过期，没有生成新作品。';
  if (state === 'needs_user_action') return '任务需要用户处理，请打开任务中心查看具体原因。';
  if (state === 'submission_outcome_unknown' || state === 'cancellation_unknown') {
    return '任务结果暂时无法确认，请打开任务中心核对真实状态。';
  }
  if (state === 'interrupted' || state === 'recovery_required') {
    return '任务执行已中断，请打开任务中心查看恢复要求。';
  }
  return '任务中心确认生成失败，请打开任务详情查看安全失败原因。';
}

function sameNotification(
  previous: GlobalNotificationItem,
  next: GlobalNotificationInput
): boolean {
  return previous.kind === next.kind &&
    previous.title === next.title &&
    previous.description === next.description &&
    previous.placement === next.placement &&
    previous.action?.label === next.action?.label &&
    previous.tracking?.mediaKind === next.tracking?.mediaKind &&
    previous.tracking?.sourceDraftId === next.tracking?.sourceDraftId &&
    previous.tracking?.taskId === next.tracking?.taskId;
}
