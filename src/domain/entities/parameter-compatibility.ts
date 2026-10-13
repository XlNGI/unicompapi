import { validateParameterSchemaV2, validateParameterValues, type ParameterSchemaV2, type ParameterScalar, type ParameterValue } from './product-feature';

export interface ParameterCompatibilityRuleV1 {
  readonly fieldId: string;
  readonly unsupported?: boolean;
  readonly targetPath?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly options?: readonly ParameterScalar[];
  readonly enumMappings?: readonly { readonly from: ParameterScalar; readonly to: ParameterScalar }[];
}

export interface ModelApiContractBindingV1 {
  readonly schemaVersion: 1;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly contractFingerprint?: string;
  readonly rules: readonly ParameterCompatibilityRuleV1[];
}

export class ParameterCompatibilityError extends Error {
  constructor(readonly code: 'invalid_binding' | 'invalid_rule' | 'unsupported_parameter' | 'mapping_conflict', message: string) {
    super(message); this.name = 'ParameterCompatibilityError';
  }
}

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const hostFields = new Set(['model', 'messages', 'tools', 'stream', 'stream_options', 'prompt', 'image', 'images', 'input', 'headers', 'authorization', 'api_key', 'endpoint']);

/** Local declarative data only: no expressions, scripts, URLs, credentials or executable transforms. */
export function parseModelApiContractBinding(value: unknown): ModelApiContractBindingV1 {
  const item = exactObject(value, ['schemaVersion', 'contractId', 'contractRevision', 'contractFingerprint', 'rules']);
  if (item.schemaVersion !== 1 || !identifier(item.contractId) || !Number.isSafeInteger(item.contractRevision) || Number(item.contractRevision) < 1 ||
      !Array.isArray(item.rules) || item.rules.length > 64 || JSON.stringify(value).length > 16_000) invalid('invalid_binding');
  const rules = (item.rules as unknown[]).map(parseRule);
  if (item.contractFingerprint !== undefined && (typeof item.contractFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.contractFingerprint))) invalid('invalid_binding');
  if (new Set(rules.map(rule => rule.fieldId)).size !== rules.length) invalid('invalid_rule');
  return { schemaVersion: 1, contractId: item.contractId as string, contractRevision: Number(item.contractRevision), rules,
    ...(item.contractFingerprint ? { contractFingerprint: item.contractFingerprint as string } : {}) };
}

function parseRule(value: unknown): ParameterCompatibilityRuleV1 {
  const item = exactObject(value, ['fieldId', 'unsupported', 'targetPath', 'minimum', 'maximum', 'options', 'enumMappings']);
  if (!identifier(item.fieldId) || (item.unsupported !== undefined && typeof item.unsupported !== 'boolean')) invalid('invalid_rule');
  if (item.unsupported && Object.keys(item).some(key => !['fieldId', 'unsupported'].includes(key))) invalid('invalid_rule');
  let targetPath: string[] | undefined;
  if (item.targetPath !== undefined) {
    if (!Array.isArray(item.targetPath) || item.targetPath.length < 1 || item.targetPath.length > 4 || item.targetPath.some(key => !identifier(key))) invalid('invalid_rule');
    targetPath = [...item.targetPath as string[]];
    if (hostFields.has(targetPath[0])) invalid('invalid_rule');
  }
  for (const key of ['minimum', 'maximum']) {
    if (item[key] !== undefined && (typeof item[key] !== 'number' || !Number.isFinite(item[key]))) invalid('invalid_rule');
  }
  if (typeof item.minimum === 'number' && typeof item.maximum === 'number' && item.minimum > item.maximum) invalid('invalid_rule');
  let options: ParameterScalar[] | undefined;
  if (item.options !== undefined) {
    if (!Array.isArray(item.options) || item.options.length < 1 || item.options.length > 64 || item.options.some(value => !scalar(value))) invalid('invalid_rule');
    options = [...item.options as ParameterScalar[]];
    if (new Set(options.map(value => JSON.stringify(value))).size !== options.length) invalid('invalid_rule');
  }
  let enumMappings: { from: ParameterScalar; to: ParameterScalar }[] | undefined;
  if (item.enumMappings !== undefined) {
    if (!Array.isArray(item.enumMappings) || item.enumMappings.length < 1 || item.enumMappings.length > 64) invalid('invalid_rule');
    enumMappings = item.enumMappings.map(value => {
      const mapping = exactObject(value, ['from', 'to']);
      if (!scalar(mapping.from) || !scalar(mapping.to)) invalid('invalid_rule');
      return { from: mapping.from as ParameterScalar, to: mapping.to as ParameterScalar };
    });
    if (new Set(enumMappings.map(mapping => JSON.stringify(mapping.from))).size !== enumMappings.length) invalid('invalid_rule');
  }
  return { fieldId: item.fieldId as string, ...(item.unsupported !== undefined ? { unsupported: item.unsupported as boolean } : {}),
    ...(targetPath ? { targetPath } : {}), ...(item.minimum !== undefined ? { minimum: item.minimum as number } : {}),
    ...(item.maximum !== undefined ? { maximum: item.maximum as number } : {}), ...(options ? { options } : {}), ...(enumMappings ? { enumMappings } : {}) };
}

/** Both the UI projection and Host validation consume this exact schema. Overrides may only narrow it. */
export function buildCompatibleParameterSchema(base: ParameterSchemaV2, binding: ModelApiContractBindingV1): ParameterSchemaV2 {
  const schema = validateParameterSchemaV2(base);
  const parsed = parseModelApiContractBinding(binding);
  for (const rule of parsed.rules) if (!schema.fields.some(field => field.fieldId === rule.fieldId)) invalid('invalid_rule');
  const fields = schema.fields.flatMap(field => {
    const rule = parsed.rules.find(item => item.fieldId === field.fieldId);
    if (rule && !['user_required', 'user_optional'].includes(field.exposure)) invalid('invalid_rule');
    if (rule?.unsupported) {
      if (field.required || field.exposure === 'user_required') invalid('invalid_rule');
      return [];
    }
    if ((rule?.minimum !== undefined || rule?.maximum !== undefined) && !['number', 'integer', 'number_array'].includes(field.valueType)) invalid('invalid_rule');
    if (rule?.minimum !== undefined && field.minimum !== undefined && rule.minimum < field.minimum) invalid('invalid_rule');
    if (rule?.maximum !== undefined && field.maximum !== undefined && rule.maximum > field.maximum) invalid('invalid_rule');
    if (field.valueType === 'integer' && [rule?.minimum, rule?.maximum].some(value => value !== undefined && !Number.isSafeInteger(value))) invalid('invalid_rule');
    const minimum = rule?.minimum ?? field.minimum;
    // Product handles one output. An API's wider result count must never bypass that constraint.
    const maximum = field.fieldId === 'n' ? Math.min(rule?.maximum ?? field.maximum ?? 1, 1) : rule?.maximum ?? field.maximum;
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) invalid('invalid_rule');
    if ((rule?.options || rule?.enumMappings) && field.valueType !== 'enum') invalid('invalid_rule');
    const options = rule?.options ?? field.options;
    if (rule?.options?.some(option => !field.options?.some(value => Object.is(option, value)))) invalid('invalid_rule');
    if (rule?.enumMappings && (!options?.every(option => rule.enumMappings!.some(mapping => Object.is(mapping.from, option))) ||
        rule.enumMappings.some(mapping => !options?.some(option => Object.is(option, mapping.from))))) invalid('invalid_rule');
    return [{ ...field, ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}), ...(options ? { options: [...options] } : {}) }];
  });
  const paths = fields.filter(field => ['user_required', 'user_optional'].includes(field.exposure)).map(field => {
    const target = parsed.rules.find(rule => rule.fieldId === field.fieldId)?.targetPath ?? [field.fieldId];
    if (target.some(key => !identifier(key)) || hostFields.has(target[0])) invalid('invalid_rule');
    return target;
  });
  paths.forEach((left, index) => paths.slice(index + 1).forEach(right => {
    if (left.slice(0, Math.min(left.length, right.length)).every((key, part) => key === right[part])) invalid('mapping_conflict');
  }));
  return { ...schema, fields };
}

/** Converts already validated public parameters. A supplied value is never silently discarded. */
export function mapCompatibleParameterValues(schema: ParameterSchemaV2, binding: ModelApiContractBindingV1,
  values: Readonly<Record<string, ParameterValue>>): Readonly<Record<string, ParameterValue>> {
  const parsed = parseModelApiContractBinding(binding);
  for (const rule of parsed.rules) if (rule.unsupported && Object.prototype.hasOwnProperty.call(values, rule.fieldId)) invalid('unsupported_parameter');
  const validated = validateParameterValues(schema, 'full', values);
  const output: Record<string, ParameterValue> = {};
  for (const [fieldId, value] of Object.entries(validated)) {
    const rule = parsed.rules.find(item => item.fieldId === fieldId);
    const mapping = rule?.enumMappings?.find(item => Object.is(item.from, value));
    if (rule?.enumMappings && !mapping) invalid('invalid_rule');
    const target = rule?.targetPath ?? [fieldId];
    if (target.some(key => !identifier(key)) || hostFields.has(target[0])) invalid('invalid_rule');
    let object: Record<string, ParameterValue> = output;
    for (const key of target.slice(0, -1)) {
      if (Object.prototype.hasOwnProperty.call(object, key) && (!object[key] || typeof object[key] !== 'object' || Array.isArray(object[key]))) invalid('mapping_conflict');
      object[key] ??= {};
      object = object[key] as Record<string, ParameterValue>;
    }
    const key = target[target.length - 1];
    if (Object.prototype.hasOwnProperty.call(object, key)) invalid('mapping_conflict');
    object[key] = structuredClone(mapping ? mapping.to : value);
  }
  return output;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,199}$/.test(value) && !forbiddenKeys.has(value);
}
function scalar(value: unknown): value is ParameterScalar {
  return typeof value === 'string' && value.length <= 256 || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
}
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid('invalid_binding');
  return value as Record<string, unknown>;
}
function invalid(code: ParameterCompatibilityError['code']): never { throw new ParameterCompatibilityError(code, `Parameter compatibility ${code}`); }
