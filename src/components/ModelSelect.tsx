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

  return (
    <div className="uc-model-select">
      <label className="uc-model-select__field">
        <span>{label}</span>
        <select
          aria-label={ariaLabel}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          value={value}
        >
          <option value="">请选择模型</option>
          {options.map((option) => (
            <option
              disabled={!option.available}
              key={option.id}
              value={option.id}
            >
              {option.label}
              {option.available
                ? ''
                : `（${(option.unavailableReasons ?? [])
                    .map((reason) => reasonLabels[reason] ?? reason)
                    .join('、') || '不可用'}）`}
            </option>
          ))}
        </select>
      </label>
      {hint ? <p className="uc-model-select__hint" role="status">{hint}</p> : null}
    </div>
  );
}
