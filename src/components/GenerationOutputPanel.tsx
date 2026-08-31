import type { HTMLAttributes, ReactNode } from 'react';
import '../styles/components.css';

export interface GenerationOutputPanelProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  readonly children: ReactNode;
}

/** Shared framed output region for generated media and its related actions. */
export function GenerationOutputPanel({
  children,
  className = '',
  ...props
}: GenerationOutputPanelProps) {
  return (
    <section
      className={['uc-generation-output-panel', className].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
    </section>
  );
}
