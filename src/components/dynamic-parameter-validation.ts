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

export interface DynamicParameterValidationResult {
  readonly valid: boolean;
  readonly errors: Readonly<Record<string, string>>;
  readonly firstError?: string;
}

export function validateDynamicParameterValues(
  fields: readonly DynamicParameterField[],
  values: Readonly<Record<string, DynamicParameterValue | undefined>>,
  inputErrors: Readonly<Record<string, string | undefined>> = {}
): DynamicParameterValidationResult {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const inputError = inputErrors[field.fieldId];
    if (inputError) {
      errors[field.fieldId] = inputError;
      continue;
    }
    const error = validateDynamicParameterValue(field, values[field.fieldId]);
    if (error) errors[field.fieldId] = error;
  }
  const firstError = Object.values(errors)[0];
  return {
    valid: firstError === undefined,
    errors,
    ...(firstError === undefined ? {} : { firstError })
  };
}

export function validateDynamicParameterValue(
  field: DynamicParameterField,
  value: DynamicParameterValue | undefined
): string | undefined {
  const label = parameterValidationLabel(field);
  if (isMissingParameterValue(value)) {
    return field.required ? `${label}为必填项。` : undefined;
  }
  if (field.valueType === 'string' || field.valueType === 'media_slot') {
    return typeof value === 'string' ? undefined : `${label}格式不正确。`;
  }
  if (field.valueType === 'number' || field.valueType === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `${label}必须是有效数字。`;
    }
    if (field.valueType === 'integer' && !Number.isSafeInteger(value)) {
      return `${label}必须是整数。`;
    }
    return validateNumericConstraint(field, value, label);
  }
  if (field.valueType === 'boolean') {
    return typeof value === 'boolean' ? undefined : `${label}格式不正确。`;
  }
  if (field.valueType === 'enum') {
    return field.options?.some((option) => Object.is(option, value))
      ? undefined
      : `${label}不在可选范围内。`;
  }
  if (field.valueType === 'string_array') {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? undefined
      : `${label}格式不正确。`;
  }
  if (field.valueType === 'number_array') {
    if (!Array.isArray(value) || value.some(
      (item) => typeof item !== 'number' || !Number.isFinite(item)
    )) {
      return `${label}必须是以逗号分隔的有效数字。`;
    }
    for (const item of value) {
      const error = validateNumericConstraint(field, item, label);
      if (error) return error;
    }
    return undefined;
  }
  if (field.valueType === 'object') {
    return isPlainRecord(value) ? undefined : `${label}必须是有效的 JSON 对象。`;
  }
  return `${label}使用了不支持的参数格式。`;
}

function validateNumericConstraint(
  field: DynamicParameterField,
  value: number,
  label: string
): string | undefined {
  if (field.minimum !== undefined && value < field.minimum) {
    return `${label}不能小于 ${field.minimum}。`;
  }
  if (field.maximum !== undefined && value > field.maximum) {
    return `${label}不能大于 ${field.maximum}。`;
  }
  if (field.step !== undefined && field.minimum !== undefined) {
    const quotient = (value - field.minimum) / field.step;
    if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 16) {
      return `${label}必须按步长 ${field.step} 填写。`;
    }
  }
  return undefined;
}

function isMissingParameterValue(value: DynamicParameterValue | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function parameterValidationLabel(field: DynamicParameterField): string {
  const key = (field.fieldId || field.labelId)
    .replace(/^provider\.parameter\./, '')
    .replace(/^provider\./, '');
  return /[\u3400-\u9fff]/u.test(key) ? key : `参数“${key}”`;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
