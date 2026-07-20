import type { HTMLAttributes } from 'react';
import '../styles/components.css';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  raised?: boolean;
}

export function Card({ className = '', raised = false, ...props }: CardProps) {
  const classes = ['uc-card', raised ? 'uc-card--raised' : '', className].filter(Boolean).join(' ');
  return <div className={classes} {...props} />;
}
