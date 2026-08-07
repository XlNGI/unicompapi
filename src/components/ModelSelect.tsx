import { useEffect, useState } from 'react';
import { SelectPicker } from 'rsuite';
import { EmptyState } from './EmptyState';

export interface ModelSelectOption {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly unavailableReasons?: readonly string[];
}

export interface ModelSelectProps {
  readonly label?: string;
  readonly ariaLabel?: string;
  readonly value: string;
  readonly options: readonly ModelSelectOption[];
  readonly disabled?: boolean;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly hint?: string;
  readonly reasonLabels?: Readonly<Record<string, string>>;
  readonly onChange: (value: string) => void;
}

export function ModelSelect({
  label = '服务商 / 连接 / 模型',
  ariaLabel = '选择模型',
  value,
  options,
  disabled = false,
  emptyTitle = '没有可选模型',
  emptyDescription = '请先到「模型与服务商」添加连接并启用模型。',
  hint,
  reasonLabels = {},
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

  if (options.length === 0) {
    return (
      <div className="uc-model-select">
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
    value: option.id,
    label: option.available
      ? option.label
      : `${option.label}（${(option.unavailableReasons ?? [])
          .map((reason) => reasonLabels[reason] ?? '其他不可用原因')
          .join('、') || '不可用'}）`
  }));
  const disabledItemValues = options
    .filter((option) => !option.available)
    .map((option) => option.id);

  return (
    <div className="uc-model-select">
      <div className="uc-model-select__field">
        <span>{label}</span>
        <SelectPicker
          aria-label={ariaLabel}
          block
          cleanable={false}
          data={data}
          disabled={disabled}
          disabledItemValues={disabledItemValues}
          listboxMaxHeight={320}
          onChange={(next) => onChange(next ?? '')}
          onClose={() => setOpen(false)}
          onOpen={() => setOpen(true)}
          open={open}
          placement="autoVerticalStart"
          placeholder="请选择模型"
          preventOverflow
          searchable={false}
          value={value || null}
        />
      </div>
      {hint ? <p className="uc-model-select__hint" role="status">{hint}</p> : null}
    </div>
  );
}
