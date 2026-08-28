import type { ReactNode } from 'react';
import { LuChevronDown } from 'react-icons/lu';

interface CreationAdvancedSectionProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly defaultOpen?: boolean;
  readonly note?: string;
  readonly title: string;
}

export function CreationAdvancedSection({
  children,
  className = '',
  defaultOpen = false,
  note,
  title
}: CreationAdvancedSectionProps) {
  return (
    <details
      className={`uc-creation-advanced${className ? ` ${className}` : ''}`}
      open={defaultOpen}
    >
      <summary className="uc-creation-advanced__summary">
        <div>
          <strong>{title}</strong>
          {note ? <span>{note}</span> : null}
        </div>
        <LuChevronDown aria-hidden="true" className="uc-creation-advanced__chevron" />
      </summary>
      <div className="uc-creation-advanced__body">{children}</div>
    </details>
  );
}
