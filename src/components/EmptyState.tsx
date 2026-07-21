import type { ReactNode } from 'react';
import { Card } from './Card';
import '../styles/components.css';

export interface EmptyStateProps {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
  status?: ReactNode;
  busy?: boolean;
  readOnly?: boolean;
  role?: 'alert' | 'status';
}

export function EmptyState({
  action,
  busy = false,
  description,
  icon = '·',
  readOnly = false,
  role,
  status,
  title
}: EmptyStateProps) {
  return (
    <Card
      className="uc-empty-state"
      aria-busy={busy || undefined}
      data-read-only={readOnly || undefined}
      role={role}
    >
      {status}
      <span className="uc-empty-state__icon" aria-hidden="true">
        {icon}
      </span>
      <h2 className="uc-empty-state__title">{title}</h2>
      <p className="uc-empty-state__description">{description}</p>
      {action}
    </Card>
  );
}
