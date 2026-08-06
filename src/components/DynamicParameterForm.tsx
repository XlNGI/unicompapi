import { useEffect, useState } from 'react';

export type DynamicParameterValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | Readonly<Record<string, unknown>>;

export interface DynamicParameterField {
  readonly fieldId: string;
  readonly labelId: string;
  readonly valueType: string;
  readonly required: boolean;
  readonly options?: readonly (string | number | boolean)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly step?: number;
}

export interface DynamicParameterFormProps {
  readonly fields: readonly DynamicParameterField[];
  readonly values: Readonly<Record<string, DynamicParameterValue | undefined>>;
  readonly disabled?: boolean;
  readonly emptyHint?: string;
  readonly onChange: (fieldId: string, value: DynamicParameterValue | undefined) => void;
}

export function DynamicParameterForm({
  fields,
  values,
  disabled = false,
  emptyHint = '本次不需要用户参数，采用服务商默认值。',
  onChange
}: DynamicParameterFormProps) {
  if (fields.length === 0) {
    return <p className="uc-model-select__hint" role="status">{emptyHint}</p>;
  }
  return (
    <div className="uc-dynamic-parameters" aria-label="模型参数">
      {fields.map((field) => (
        <ParameterField
          disabled={disabled}
          field={field}
          key={field.fieldId}
          onChange={(value) => onChange(field.fieldId, value)}
          value={values[field.fieldId]}
        />
      ))}
    </div>
  );
}

export function toDynamicParameterFields(
  fields: readonly {
    readonly fieldId?: string;
    readonly key?: string;
    readonly labelId?: string;
    readonly label?: string;
    readonly valueType?: string;
    readonly kind?: string;
    readonly required: boolean;
    readonly options?: readonly (string | number | boolean)[];
    readonly minimum?: number;
    readonly maximum?: number;
    readonly step?: number;
  }[]
): readonly DynamicParameterField[] {
  return fields.map((field, index) => ({
    fieldId: field.fieldId ?? field.key ?? `field-${index}`,
    labelId: field.labelId ?? field.label ?? field.fieldId ?? field.key ?? `field-${index}`,
    valueType: field.valueType ?? field.kind ?? 'string',
    required: field.required,
    ...(field.options ? { options: field.options } : {}),
    ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
    ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
    ...(field.step === undefined ? {} : { step: field.step })
  }));
}

function ParameterField({
  field,
  value,
  disabled,
  onChange
}: {
  readonly field: DynamicParameterField;
  readonly value: DynamicParameterValue | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: DynamicParameterValue | undefined) => void;
}) {
  const label = `${field.labelId}${field.required ? '（必填）' : ''}`;
  if (field.valueType === 'boolean') {
    return (
      <label className="uc-model-select__checkbox">
        <input
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <span>{label}</span>
      </label>
    );
  }
  if (field.valueType === 'enum') {
    return (
      <label className="uc-model-select__field">
        <span>{label}</span>
        <select
          disabled={disabled}
          onChange={(event) => {
            const option = field.options?.find((item) => String(item) === event.target.value);
            onChange(option);
          }}
          value={value === undefined ? '' : String(value)}
        >
          <option value="">请选择</option>
          {field.options?.map((option) => (
            <option key={String(option)} value={String(option)}>{String(option)}</option>
          ))}
        </select>
      </label>
    );
  }
  if (field.valueType === 'number' || field.valueType === 'integer') {
    return (
      <label className="uc-model-select__field">
        <span>{label}</span>
        <input
          disabled={disabled}
          max={field.maximum}
          min={field.minimum}
          onChange={(event) => onChange(
            event.target.value === '' ? undefined : Number(event.target.value)
          )}
          step={field.valueType === 'integer' ? 1 : field.step}
          type="number"
          value={typeof value === 'number' ? value : ''}
        />
      </label>
    );
  }
  if (field.valueType === 'string_array' || field.valueType === 'number_array') {
    return (
      <label className="uc-model-select__field">
        <span>{label}</span>
        <input
          disabled={disabled}
          onChange={(event) => {
            const items = event.target.value.split(',').map((item) => item.trim()).filter(Boolean);
            onChange(items.length === 0
              ? undefined
              : field.valueType === 'number_array'
                ? items.map(Number)
                : items);
          }}
          placeholder="使用逗号分隔"
          type="text"
          value={Array.isArray(value) ? value.join(', ') : ''}
        />
      </label>
    );
  }
  if (field.valueType === 'object') {
    return <ObjectParameterField disabled={disabled} field={field} onChange={onChange} value={value} />;
  }
  if (field.valueType === 'media_slot') {
    return (
      <label className="uc-model-select__field">
        <span>{label}</span>
        <input disabled readOnly value="由当前草稿的受控素材提供" />
      </label>
    );
  }
  return (
    <label className="uc-model-select__field">
      <span>{label}</span>
      <input
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
        type="text"
        value={typeof value === 'string' ? value : ''}
      />
    </label>
  );
}

function ObjectParameterField({
  field,
  value,
  disabled,
  onChange
}: {
  readonly field: DynamicParameterField;
  readonly value: DynamicParameterValue | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: DynamicParameterValue | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(value === undefined ? '' : JSON.stringify(value));
    setInvalid(false);
  }, [value]);
  return (
    <label className="uc-model-select__field">
      <span>{field.labelId}{field.required ? '（必填）' : ''}</span>
      <textarea
        aria-invalid={invalid}
        disabled={disabled}
        onBlur={() => {
          if (!text.trim()) {
            setInvalid(false);
            onChange(undefined);
            return;
          }
          try {
            const parsed = JSON.parse(text) as unknown;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              throw new TypeError('object required');
            }
            setInvalid(false);
            onChange(parsed as Readonly<Record<string, unknown>>);
          } catch {
            setInvalid(true);
          }
        }}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        value={text}
      />
      {invalid ? <small role="alert">请输入有效的 JSON 对象。</small> : null}
    </label>
  );
}
