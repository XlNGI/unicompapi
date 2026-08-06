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

/** Display the parameter key without internal label namespace prefixes. */
export function displayParameterKey(value: string): string {
  return value
    .replace(/^provider\.parameter\./, '')
    .replace(/^provider\./, '');
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
    readonly exposure?: string;
    readonly required: boolean;
    readonly options?: readonly (string | number | boolean)[];
    readonly minimum?: number;
    readonly maximum?: number;
    readonly step?: number;
  }[]
): readonly DynamicParameterField[] {
  return fields.map((field, index) => {
    const fieldId = field.fieldId ?? field.key ?? `field-${index}`;
    return {
      fieldId,
      labelId: field.labelId ?? field.label ?? fieldId,
      valueType: field.valueType ?? field.kind ?? 'string',
      required: field.required === true || field.exposure === 'user_required',
      ...(field.options ? { options: field.options } : {}),
      ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
      ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
      ...(field.step === undefined ? {} : { step: field.step })
    };
  });
}

function parameterLabel(field: DynamicParameterField): {
  readonly text: string;
  readonly required: boolean;
} {
  return {
    text: displayParameterKey(field.fieldId || field.labelId),
    required: field.required
  };
}

function ParameterLabel({ field }: { readonly field: DynamicParameterField }) {
  const { text, required } = parameterLabel(field);
  return (
    <span className="uc-dynamic-parameters__label">
      <span className="uc-dynamic-parameters__key">{text}</span>
      {required ? (
        <span aria-label="必填" className="uc-dynamic-parameters__required">
          必填
        </span>
      ) : null}
    </span>
  );
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
  if (field.valueType === 'boolean') {
    return (
      <label className="uc-model-select__checkbox">
        <input
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <ParameterLabel field={field} />
      </label>
    );
  }
  if (field.valueType === 'enum') {
    return (
      <label className="uc-model-select__field">
        <ParameterLabel field={field} />
        <select
          disabled={disabled}
          onChange={(event) => {
            const option = field.options?.find((item) => String(item) === event.target.value);
            onChange(option);
          }}
          required={field.required}
          value={value === undefined ? '' : String(value)}
        >
          <option value="">{field.required ? '请选择（必填）' : '请选择'}</option>
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
        <ParameterLabel field={field} />
        <input
          disabled={disabled}
          max={field.maximum}
          min={field.minimum}
          onChange={(event) => onChange(
            event.target.value === '' ? undefined : Number(event.target.value)
          )}
          required={field.required}
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
        <ParameterLabel field={field} />
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
          required={field.required}
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
        <ParameterLabel field={field} />
        <input disabled readOnly value="由当前草稿的受控素材提供" />
      </label>
    );
  }
  return (
    <label className="uc-model-select__field">
      <ParameterLabel field={field} />
      <input
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
        required={field.required}
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
      <ParameterLabel field={field} />
      <textarea
        aria-invalid={invalid}
        disabled={disabled}
        required={field.required}
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
