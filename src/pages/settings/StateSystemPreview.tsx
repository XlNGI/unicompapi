import { useState } from 'react';
import type {
  ExecutionState,
  FileState,
  TaskStatus
} from '../../domain';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill, type StatusTone } from '../../components/StatusPill';

interface StateFixture {
  id: string;
  title: string;
  description: string;
  label: string;
  icon: string;
  tone: StatusTone;
  domainState?: ExecutionState | FileState | TaskStatus;
  actionLabel?: string;
  actionDisabled?: boolean;
  busy?: boolean;
  readOnly?: boolean;
  role?: 'alert' | 'status';
}

export const stateFixtures = [
  {
    id: 'empty',
    title: '这里还没有内容',
    description: '创建或导入内容后将在这里显示。',
    label: '空白',
    icon: '空',
    tone: 'neutral'
  },
  {
    id: 'loading',
    title: '正在读取本地状态',
    description: '完成前不可重复操作；不显示虚假进度。',
    label: '加载中',
    icon: '载',
    tone: 'info',
    domainState: 'processing',
    actionLabel: '正在读取',
    actionDisabled: true,
    busy: true,
    role: 'status'
  },
  {
    id: 'failure',
    title: '操作失败',
    description: '失败原因保留在当前区域，可在确认原因后重试。',
    label: '失败',
    icon: '错',
    tone: 'danger',
    domainState: 'failed',
    actionLabel: '重试',
    role: 'alert'
  },
  {
    id: 'expired',
    title: '执行已过期',
    description: '旧执行不会恢复为进行中；重新提交会创建新执行。',
    label: '已过期',
    icon: '期',
    tone: 'warning',
    domainState: 'expired',
    actionLabel: '重新提交'
  },
  {
    id: 'service-unavailable',
    title: '服务暂不可用',
    description: '当前不推断服务能力、恢复时间或费用。',
    label: '服务不可用',
    icon: '服',
    tone: 'warning',
    actionLabel: '检查配置'
  },
  {
    id: 'file-missing',
    title: '本地文件已丢失',
    description: '保留文件引用，不把缺失文件显示为正式作品。',
    label: '文件丢失',
    icon: '失',
    tone: 'danger',
    domainState: 'missing',
    actionLabel: '重新定位'
  },
  {
    id: 'read-only',
    title: '当前位置只读',
    description: '内容仍可查看和复制，但不能修改或覆盖。',
    label: '只读',
    icon: '读',
    tone: 'warning',
    domainState: 'read_only',
    actionLabel: '复制路径',
    readOnly: true
  },
  {
    id: 'recovery',
    title: '外置存储已断开',
    description: '重新连接后可从已保留的文件引用继续恢复。',
    label: '等待恢复',
    icon: '复',
    tone: 'info',
    domainState: 'disconnected',
    actionLabel: '重新连接'
  }
] satisfies readonly StateFixture[];

export function StateSystemPreview() {
  const [announcement, setAnnouncement] = useState('');

  return (
    <details className="uc-state-preview">
      <summary>阶段 2 界面状态预览</summary>
      <p className="uc-state-preview__description">
        纯本地夹具，不访问后台或文件系统。
      </p>
      <div className="uc-state-preview__grid">
        {stateFixtures.map((fixture) => (
          <EmptyState
            action={
              fixture.actionLabel && (
                <Button
                  disabled={fixture.actionDisabled}
                  onClick={() =>
                    setAnnouncement(`${fixture.title}：已触发预览操作`)
                  }
                  variant="secondary"
                >
                  {fixture.actionLabel}
                </Button>
              )
            }
            busy={fixture.busy}
            description={fixture.description}
            icon={fixture.icon}
            key={fixture.id}
            readOnly={fixture.readOnly}
            role={fixture.role}
            status={
              <StatusPill
                data-domain-state={fixture.domainState}
                tone={fixture.tone}
              >
                {fixture.label}
              </StatusPill>
            }
            title={fixture.title}
          />
        ))}
      </div>
      <p className="uc-state-preview__announcement" aria-live="polite">
        {announcement}
      </p>
    </details>
  );
}
