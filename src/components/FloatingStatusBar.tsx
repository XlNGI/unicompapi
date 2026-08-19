import type { HTMLAttributes, ReactNode } from 'react';
import { StatusPill, type StatusTone } from './StatusPill';
import '../styles/components.css';

export interface FloatingStatusBarProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  readonly children: ReactNode;
  readonly label?: ReactNode;
  readonly tone?: StatusTone;
}

/**
 * Persistent, workspace-level feedback. It remains visible above the bottom
 * edge of the content area while the user edits or scrolls a workbench.
 */
export function FloatingStatusBar({
  children,
  className = '',
  label,
  role = 'status',
  tone = 'neutral',
  ...props
}: FloatingStatusBarProps) {
  return (
    <aside
      className={['uc-floating-status-bar', className].filter(Boolean).join(' ')}
      role={role}
      {...props}
    >
      {label ? <StatusPill tone={tone}>{label}</StatusPill> : null}
      <div className="uc-floating-status-bar__content">{children}</div>
    </aside>
  );
}
