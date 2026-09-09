import type { ReactElement, ReactNode } from 'react';
import { LuEllipsis } from 'react-icons/lu';
import { Dropdown } from 'rsuite';
import '../styles/components.css';

export interface ActionMenuItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly icon?: ReactElement;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly separatorBefore?: boolean;
}

export interface ActionMenuProps {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly toggleClassName?: string;
  readonly items: readonly ActionMenuItem[];
  readonly onSelect: (key: string) => void;
}

export function ActionMenu({
  ariaLabel,
  className = '',
  toggleClassName = '',
  items,
  onSelect
}: ActionMenuProps) {
  return (
    <Dropdown
      className={className}
      noCaret
      onSelect={(eventKey) => {
        if (typeof eventKey === 'string') onSelect(eventKey);
      }}
      placement="bottomEnd"
      renderToggle={(props, ref) => (
        <button
          {...props}
          aria-label={ariaLabel}
          className={`${toggleClassName}${props.className ? ` ${props.className}` : ''}`}
          ref={ref}
          type="button"
        >
          <LuEllipsis aria-hidden="true" />
        </button>
      )}
    >
      {items.flatMap((item) => [
        ...(item.separatorBefore
          ? [<Dropdown.Separator key={`${item.key}-separator`} />]
          : []),
        <Dropdown.Item
          className={item.danger ? 'uc-action-menu__item--danger' : undefined}
          disabled={item.disabled}
          eventKey={item.key}
          icon={item.icon}
          key={item.key}
        >
          {item.label}
        </Dropdown.Item>
      ])}
    </Dropdown>
  );
}
