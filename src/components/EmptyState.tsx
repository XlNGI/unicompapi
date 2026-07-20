import type { ReactNode } from 'react';
import { Card } from './Card';
import '../styles/components.css';

export interface EmptyStateProps {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ action, description, icon = '·', title }: EmptyStateProps) {
  return (
    <Card className="uc-empty-state">
      <span className="uc-empty-state__icon" aria-hidden="true">
        {icon}
      </span>
      <h2 className="uc-empty-state__title">{title}</h2>
      <p className="uc-empty-state__description">{description}</p>
      {action}
    </Card>
  );
}
