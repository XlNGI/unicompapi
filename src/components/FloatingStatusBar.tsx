import { useEffect, useId, type HTMLAttributes, type ReactNode } from 'react';
import type { StatusTone } from './StatusPill';
import '../styles/components.css';
import { useProjectStatus } from '../ui/status/ProjectStatusContext';

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
  label,
  role = 'status',
  tone = 'neutral'
}: FloatingStatusBarProps) {
  const statusId = useId();
  const { register, unregister } = useProjectStatus();
  useEffect(() => {
    register(statusId, {
      label: label ?? '项目状态',
      tone,
      content: children,
      priority: 10,
      role: role === 'alert' ? 'alert' : 'status'
    });
    return () => unregister(statusId);
  }, [children, label, register, role, statusId, tone, unregister]);
  return null;
}
