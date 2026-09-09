import { LuCopyPlus, LuRefreshCw } from 'react-icons/lu';
import type { AutosavePhase } from '../application';
import { Button } from './Button';
import { StatusPill, type StatusTone } from './StatusPill';

const labels: Record<AutosavePhase, string> = {
  saved: '已自动保存',
  pending: '有未保存修改',
  saving: '正在保存…',
  retrying: '保存失败，正在重试…',
  failed: '保存失败，修改已保留',
  conflict: '检测到版本冲突'
};

const tones: Record<AutosavePhase, StatusTone> = {
  saved: 'success',
  pending: 'warning',
  saving: 'info',
  retrying: 'warning',
  failed: 'danger',
  conflict: 'danger'
};

interface AutosaveStatusProps {
  readonly phase: AutosavePhase;
  readonly busy?: boolean;
  readonly onReload?: () => void;
  readonly onRetry?: () => void;
  readonly onSaveCopy?: () => void;
}

export function AutosaveStatus({
  phase,
  busy = false,
  onReload,
  onRetry,
  onSaveCopy
}: AutosaveStatusProps) {
  return (
    <div className="uc-autosave-status" role="status">
      <StatusPill tone={tones[phase]}>{labels[phase]}</StatusPill>
      {phase === 'failed' && onRetry ? (
        <Button disabled={busy} onClick={onRetry} variant="ghost">
          <LuRefreshCw aria-hidden="true" />
          重试保存
        </Button>
      ) : null}
      {phase === 'conflict' && onReload ? (
        <Button disabled={busy} onClick={onReload} variant="ghost">
          <LuRefreshCw aria-hidden="true" />
          重新载入
        </Button>
      ) : null}
      {phase === 'conflict' && onSaveCopy ? (
        <Button disabled={busy} onClick={onSaveCopy} variant="ghost">
          <LuCopyPlus aria-hidden="true" />
          另存为新草稿
        </Button>
      ) : null}
    </div>
  );
}
