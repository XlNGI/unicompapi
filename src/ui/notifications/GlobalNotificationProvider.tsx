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
}

type GlobalNotificationItem = GlobalNotificationInput;

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
    if (isGenerationNotice(notification)) return;
    clearSuccessTimer(notification.id);
    setNotifications((current) => {
      const previous = current.find((item) => item.id === notification.id);
      if (previous && sameNotification(previous, notification)) return current;
      return previous
        ? current.map((item) => item.id === notification.id ? notification : item)
        : [...current, notification];
    });
    if (notification.kind === 'success') {
      const timer = window.setTimeout(() => {
        successTimers.current.delete(notification.id);
        setNotifications((current) => current.filter((item) => item.id !== notification.id));
      }, successDurationMs);
      successTimers.current.set(notification.id, timer);
    }
  }, [clearSuccessTimer]);

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
          className={`uc-global-notifications__item uc-global-notifications__item--${item.kind}${
            item.description ? '' : ' uc-global-notifications__item--compact'
          }`}
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
            {item.description ? <p>{item.description}</p> : null}
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

function isGenerationNotice(notification: GlobalNotificationInput): boolean {
  return /^(?:image|video)-generation:/u.test(notification.id);
}

function sameNotification(
  previous: GlobalNotificationItem,
  next: GlobalNotificationInput
): boolean {
  return previous.kind === next.kind &&
    previous.title === next.title &&
    previous.description === next.description &&
    previous.placement === next.placement &&
    previous.action?.label === next.action?.label;
}
