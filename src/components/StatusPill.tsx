import type { HTMLAttributes } from 'react';
import '../styles/components.css';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
}

export function StatusPill({ className = '', tone = 'neutral', ...props }: StatusPillProps) {
  const classes = [
    'uc-status-pill',
    tone === 'neutral' ? '' : `uc-status-pill--${tone}`,
    className
  ]
    .filter(Boolean)
    .join(' ');

  return <span className={classes} {...props} />;
}
