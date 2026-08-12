import { useEffect, useState, type ReactNode } from 'react';
import { SelectPicker } from 'rsuite';
import { EmptyState } from './EmptyState';

export interface ModelSelectOption {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly providerName?: string;
  readonly connectionName?: string;
  readonly statusLabel?: string;
  readonly unavailableReasons?: readonly string[];
}

export interface ModelSelectProps {
  readonly label?: string;
  readonly ariaLabel?: string;
  readonly appearance?: 'default' | 'subtle';
  readonly className?: string;
  readonly value: string;
  readonly options: readonly ModelSelectOption[];
  readonly disabled?: boolean;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly hint?: string;
  readonly reasonLabels?: Readonly<Record<string, string>>;
  readonly placeholder?: ReactNode;
  readonly popupClassName?: string;
  readonly listboxMaxHeight?: number;
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
  readonly showEmptyState?: boolean;
  readonly noResultsText?: string;
  readonly listboxHeader?: ReactNode;
  readonly renderValue?: (option: ModelSelectOption) => ReactNode;
  readonly onClose?: () => void;
  readonly onChange: (value: string) => void;
}

export function ModelSelect({
  label = '服务商 / 连接 / 模型',
  ariaLabel = '选择模型',
  appearance = 'default',
  className = '',
  value,
  options,
  disabled = false,
  emptyTitle = '没有可选模型',
  emptyDescription = '请先到「模型与服务商」添加连接并启用模型。',
  hint,
  reasonLabels = {},
  placeholder = '请选择模型',
  popupClassName = '',
  listboxMaxHeight = 320,
  searchable = true,
  searchPlaceholder = '搜索模型或服务商',
  showEmptyState = true,
  noResultsText = '没有匹配的模型',
  listboxHeader,
  renderValue,
  onClose,
  onChange
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const workspace = document.querySelector<HTMLElement>('.workspace');
    if (!workspace) return;
    const handleScroll = () => setOpen(false);
    workspace.addEventListener('scroll', handleScroll, {
      capture: true,
      passive: true
    });
    return () => workspace.removeEventListener('scroll', handleScroll, true);
  }, [open]);

  if (options.length === 0 && showEmptyState) {
    return (
      <div className={`uc-model-select${className ? ` ${className}` : ''}`}>
        <EmptyState
          description={emptyDescription}
          icon="模"
          readOnly
          title={emptyTitle}
        />
        {hint ? <p className="uc-model-select__hint" role="status">{hint}</p> : null}
      </div>
    );
  }

  const data = options.map((option) => ({
    ...option,
    value: option.id,
    label: option.label,
    group: option.available ? '可用模型' : '暂不可用模型',
    searchText: [
      option.label,
      option.providerName,
      option.connectionName,
      ...(option.unavailableReasons ?? []).map(
        (reason) => reasonLabels[reason] ?? '其他不可用原因'
      )
    ]
      .filter(Boolean)
      .join(' ')
  }));
  const disabledItemValues = options
    .filter((option) => !option.available)
    .map((option) => option.id);

  return (
    <div className={`uc-model-select${className ? ` ${className}` : ''}`}>
      <div className="uc-model-select__field">
        <span>{label}</span>
        <SelectPicker
          appearance={appearance}
          aria-label={ariaLabel}
          block
          cleanable={false}
          data={data}
          disabled={disabled}
          disabledItemValues={disabledItemValues}
          groupBy="group"
          listboxMaxHeight={listboxMaxHeight}
          locale={{ noResultsText, searchPlaceholder }}
          onChange={(next) => onChange(next ?? '')}
          onClose={() => {
            setOpen(false);
            onClose?.();
          }}
          onOpen={() => setOpen(true)}
          open={open}
          placement="autoVerticalStart"
          placeholder={placeholder}
          preventOverflow
          popupClassName={`uc-model-select__popup${popupClassName ? ` ${popupClassName}` : ''}`}
          renderListbox={listboxHeader
            ? (listbox) => (
              <div className="uc-model-select__listbox-composite">
                {listboxHeader}
                {listbox}
              </div>
            )
            : undefined}
          renderOption={(_label, item) => (
            <ModelSelectOptionContent
              option={item as ModelSelectOption & { readonly group?: string }}
              reasonLabels={reasonLabels}
            />
          )}
          renderOptionGroup={(title) => (
            <span className="uc-model-select__group-title">{title}</span>
          )}
          renderValue={(_next, item, selectedElement) =>
            item ? (
              renderValue?.(item as ModelSelectOption & { readonly group?: string }) ?? (
                <ModelSelectOptionContent
                  compact
                  option={item as ModelSelectOption & { readonly group?: string }}
                  reasonLabels={reasonLabels}
                />
              )
            ) : (
              selectedElement
            )
          }
          searchable={searchable}
          searchBy={(keyword, _label, item) =>
            String((item as { readonly searchText?: string }).searchText ?? '')
              .toLocaleLowerCase()
              .includes(keyword.toLocaleLowerCase())
          }
          value={value || null}
        />
      </div>
      {hint ? <p className="uc-model-select__hint" role="status">{hint}</p> : null}
    </div>
  );
}

function ModelSelectOptionContent({
  option,
  reasonLabels,
  compact = false
}: {
  readonly option: ModelSelectOption;
  readonly reasonLabels: Readonly<Record<string, string>>;
  readonly compact?: boolean;
}) {
  const reasons = (option.unavailableReasons ?? [])
    .map((reason) => reasonLabels[reason] ?? '其他不可用原因')
    .filter((reason, index, all) => all.indexOf(reason) === index);
  const statusLabel =
    option.statusLabel ??
    (option.available ? '可用' : reasons[0] ?? '暂不可用');

  return (
    <span
      className={`uc-model-select__option${compact ? ' uc-model-select__option--compact' : ''}`}
      title={reasons.length > 1 ? reasons.join('、') : undefined}
    >
      <span className="uc-model-select__option-main">
        <strong>{option.label}</strong>
        <span
          className={`uc-model-select__status uc-model-select__status--${option.available ? 'available' : 'unavailable'}`}
        >
          {statusLabel}
        </span>
      </span>
      {option.providerName || option.connectionName ? (
        <span className="uc-model-select__option-meta">
          {[option.providerName, option.connectionName].filter(Boolean).join(' · ')}
        </span>
      ) : null}
      {!compact && !option.available && reasons.length > 1 ? (
        <span className="uc-model-select__option-reason">
          {reasons.slice(1).join('、')}
        </span>
      ) : null}
    </span>
  );
}
