import type { ProviderOperationPurpose } from './provider';

export const productFeatures = [
  'text_chat',
  'text_reasoning',
  'image_understanding',
  'image_to_prompt',
  'text_to_image',
  'reference_to_image',
  'image_edit',
  'text_to_video',
  'image_to_video'
] as const;
export type ProductFeature = (typeof productFeatures)[number];

export const productFeatureInternalPurposes: Readonly<
  Record<ProductFeature, ProviderOperationPurpose | 'text_execution'>
> = {
  text_chat: 'text_execution',
  text_reasoning: 'text_execution',
  image_understanding: 'image_understanding',
  image_to_prompt: 'image_to_prompt',
  text_to_image: 'image_generation',
  reference_to_image: 'reference_to_image',
  image_edit: 'image_editing',
  text_to_video: 'video_generation',
  image_to_video: 'reference_to_video'
};

export const parameterSchemaExposures = [
  'user_required',
  'user_optional',
  'product_fixed',
  'adapter_derived',
  'internal'
] as const;
export type ParameterSchemaExposure = (typeof parameterSchemaExposures)[number];

export const parameterSchemaDefaultPolicies = [
  'require_user_value',
  'omit_use_provider_default',
  'use_explicit_provider_default',
  'use_product_fixed',
  'derive_in_adapter'
] as const;
export type ParameterSchemaDefaultPolicy =
  (typeof parameterSchemaDefaultPolicies)[number];

export const parameterSchemaValueTypes = [
  'string',
  'number',
  'integer',
  'boolean',
  'enum',
  'string_array',
  'number_array',
  'object',
  'media_slot'
] as const;
export type ParameterSchemaValueType = (typeof parameterSchemaValueTypes)[number];
export type ParameterScalar = string | number | boolean;

export const parameterProjectionModes = ['required_only', 'full'] as const;
export type ParameterProjectionMode = (typeof parameterProjectionModes)[number];

export type ProductFeatureSurface = 'conversation' | 'quick' | 'professional';

export interface ProductFeatureDefinition {
  readonly productFeature: ProductFeature;
  readonly internalPurpose?: string;
  readonly parameterSchemaDefinitionId: string;
  readonly resultSchemaDefinitionId: string;
  readonly usageSchemaDefinitionId: string;
  readonly constraintSetDefinitionId: string;
}

export interface ParameterFieldSchemaV2 {
  readonly fieldId: string;
  readonly labelId: string;
  readonly groupId?: string;
  readonly order: number;
  readonly valueType: ParameterSchemaValueType;
  readonly exposure: ParameterSchemaExposure;
  readonly defaultPolicy: ParameterSchemaDefaultPolicy;
  readonly required: boolean;
  readonly options?: readonly ParameterScalar[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly step?: number;
  readonly unitId?: string;
  readonly secret?: boolean;
  readonly display?: {
    readonly label?: string;
    readonly description?: string;
    readonly groupLabel?: string;
    readonly note?: string;
    readonly optionLabels?: readonly {
      readonly value: ParameterScalar;
      readonly label: string;
    }[];
    readonly visibleWhen?: {
      readonly fieldId: string;
      readonly operator: 'equals' | 'not_equals';
      readonly value: ParameterScalar;
    };
  };
}

export interface ParameterSchemaV2 {
  readonly schemaVersion: 2;
  readonly schemaId: string;
  readonly revision: number;
  readonly productFeature: ProductFeature;
  readonly fields: readonly ParameterFieldSchemaV2[];
}

export type ParameterSchema = ParameterSchemaV2;

export interface ProductFeatureRequestSubject {
  readonly productFeature: ProductFeature;
  readonly surface: ProductFeatureSurface;
  readonly imageCount?: number;
  readonly videoCount?: number;
  readonly contextCount?: number;
}

export class ProductFeatureContractError extends Error {
  constructor(
    readonly code:
      | 'invalid_feature'
      | 'invalid_schema'
      | 'invalid_projection'
      | 'unknown_parameter'
      | 'missing_parameter'
      | 'invalid_parameter'
      | 'feature_constraint_violation',
    message: string
  ) {
    super(message);
    this.name = 'ProductFeatureContractError';
  }
}

export function isProductFeature(value: unknown): value is ProductFeature {
  return productFeatures.includes(value as ProductFeature);
}

export function parseProductFeature(value: unknown): ProductFeature {
  if (!isProductFeature(value)) {
    throw new ProductFeatureContractError(
      'invalid_feature',
      'Product feature is not supported'
    );
  }
  return value;
}

export function productFeatureToInternalPurpose(
  feature: ProductFeature
): ProviderOperationPurpose | 'text_execution' {
  return productFeatureInternalPurposes[parseProductFeature(feature)];
}

export const productFeatureToPurpose = productFeatureToInternalPurpose;

export function validateProductFeatureDefinition(
  definition: ProductFeatureDefinition
): ProductFeatureDefinition {
  const feature = parseProductFeature(definition.productFeature);
  for (const [value, label] of [
    [definition.parameterSchemaDefinitionId, 'parameter schema definition ID'],
    [definition.resultSchemaDefinitionId, 'result schema definition ID'],
    [definition.usageSchemaDefinitionId, 'usage schema definition ID'],
    [definition.constraintSetDefinitionId, 'constraint set definition ID']
  ] as const) {
    requireStableId(value, label);
  }
  if (definition.internalPurpose !== undefined) {
    requireStableId(definition.internalPurpose, 'internal purpose');
    if (definition.internalPurpose !== productFeatureToInternalPurpose(feature)) {
      throw new ProductFeatureContractError(
        'invalid_feature',
        'Product feature internal purpose does not match the explicit mapping'
      );
    }
  }
  return { ...definition };
}

export function validateParameterSchemaV2(
  schema: ParameterSchemaV2
): ParameterSchemaV2 {
  if (
    schema.schemaVersion !== 2 ||
    !Number.isSafeInteger(schema.revision) ||
    schema.revision < 1 ||
    !Array.isArray(schema.fields)
  ) {
    throw new ProductFeatureContractError(
      'invalid_schema',
      'ParameterSchema V2 metadata is invalid'
    );
  }
  parseProductFeature(schema.productFeature);
  requireStableId(schema.schemaId, 'schema ID');
  const fields = schema.fields.map(validateParameterField);
  assertUnique(fields.map((field) => field.fieldId), 'parameter field ID');
  assertUnique(fields.map((field) => String(field.order)), 'parameter field order');
  const fieldsById = new Map(fields.map((field) => [field.fieldId, field]));
  for (const field of fields) {
    const condition = field.display?.visibleWhen;
    if (!condition) continue;
    const source = fieldsById.get(condition.fieldId);
    if (!source || source.fieldId === field.fieldId ||
      !['user_required', 'user_optional'].includes(source.exposure)) {
      throw new ProductFeatureContractError(
        'invalid_schema',
        'Parameter display condition references an unavailable field'
      );
    }
    validateParameterValue(source, condition.value);
  }
  return { ...schema, fields };
}

export function projectParameterSchema(
  schema: ParameterSchemaV2,
  mode: ParameterProjectionMode
): ParameterSchemaV2 {
  const validated = validateParameterSchemaV2(schema);
  if (!parameterProjectionModes.includes(mode)) {
    throw new ProductFeatureContractError(
      'invalid_projection',
      'Parameter schema projection mode is invalid'
    );
  }
  const visible = validated.fields.filter((field) =>
    mode === 'required_only'
      ? field.exposure === 'user_required'
      : field.exposure === 'user_required' || field.exposure === 'user_optional'
  );
  return { ...validated, fields: visible };
}

export const projectParameterSchemaV2 = projectParameterSchema;

export function validateParameterValues(
  schema: ParameterSchemaV2,
  mode: ParameterProjectionMode,
  values: unknown
): Readonly<Record<string, ParameterValue>> {
  const projected = projectParameterSchema(schema, mode);
  if (!isPlainRecord(values)) {
    throw new ProductFeatureContractError(
      'invalid_parameter',
      'Parameter values must be a plain object'
    );
  }
  const fieldById = new Map(projected.fields.map((field) => [field.fieldId, field]));
  for (const key of Object.keys(values)) {
    if (!fieldById.has(key)) {
      throw new ProductFeatureContractError(
        'unknown_parameter',
        `Parameter ${key} is not part of the ${mode} projection`
      );
    }
  }
  const result: Record<string, ParameterValue> = {};
  for (const field of projected.fields) {
    const present = Object.prototype.hasOwnProperty.call(values, field.fieldId);
    if (!present) {
      if (field.exposure === 'user_required') {
        throw new ProductFeatureContractError(
          'missing_parameter',
          `Required parameter ${field.fieldId} is missing`
        );
      }
      continue;
    }
    const value = (values as Record<string, unknown>)[field.fieldId];
    validateParameterValue(field, value);
    result[field.fieldId] = value as ParameterValue;
  }
  return result;
}

export const validateParameterSchemaValues = validateParameterValues;

export function validateProductFeatureRequest(
  subject: ProductFeatureRequestSubject
): void {
  const feature = parseProductFeature(subject.productFeature);
  const imageCount = count(subject.imageCount, 'imageCount');
  const videoCount = count(subject.videoCount, 'videoCount');
  const contextCount = count(subject.contextCount, 'contextCount');
  if (!['conversation', 'quick', 'professional'].includes(subject.surface)) {
    throw featureConstraint('Product feature surface is invalid');
  }
  if (subject.surface === 'quick' && contextCount !== 0) {
    throw featureConstraint('Quick creation cannot use conversation context');
  }
  if (subject.surface === 'quick' && !['text_to_image', 'text_to_video'].includes(feature)) {
    throw featureConstraint('Quick creation only supports text-to-image and text-to-video');
  }
  if (feature === 'text_to_image' || feature === 'text_to_video') {
    if (imageCount !== 0 || videoCount !== 0) {
      throw featureConstraint(`${feature} cannot accept reference media`);
    }
    return;
  }
  if (feature === 'reference_to_image' || feature === 'image_to_video') {
    requireSingleImage(imageCount, feature);
    if (videoCount !== 0) throw featureConstraint(`${feature} cannot accept video media`);
    if (subject.surface !== 'professional') {
      throw featureConstraint(`${feature} requires the professional surface`);
    }
    return;
  }
  if (
    feature === 'image_understanding' ||
    feature === 'image_to_prompt' ||
    feature === 'image_edit'
  ) {
    requireSingleImage(imageCount, feature);
    if (videoCount !== 0) throw featureConstraint(`${feature} cannot accept video media`);
    return;
  }
  if (imageCount !== 0 || videoCount !== 0) {
    throw featureConstraint(`${feature} cannot accept media`);
  }
}

export const validateFeatureRequest = validateProductFeatureRequest;
export const validateProductFeatureSubject = validateProductFeatureRequest;

export type ParameterValue = string | number | boolean | readonly ParameterValue[] | {
  readonly [key: string]: ParameterValue;
};

function validateParameterField(field: ParameterFieldSchemaV2): ParameterFieldSchemaV2 {
  requireStableId(field.fieldId, 'parameter field ID');
  requireStableId(field.labelId, 'parameter label ID');
  if (field.groupId !== undefined) requireStableId(field.groupId, 'parameter group ID');
  if (!Number.isSafeInteger(field.order) || field.order < 0) {
    throw new ProductFeatureContractError('invalid_schema', 'Parameter field order is invalid');
  }
  if (!parameterSchemaValueTypes.includes(field.valueType)) {
    throw new ProductFeatureContractError('invalid_schema', 'Parameter field value type is invalid');
  }
  if (!parameterSchemaExposures.includes(field.exposure)) {
    throw new ProductFeatureContractError('invalid_schema', 'Parameter field exposure is invalid');
  }
  if (!parameterSchemaDefaultPolicies.includes(field.defaultPolicy)) {
    throw new ProductFeatureContractError('invalid_schema', 'Parameter field default policy is invalid');
  }
  if (field.exposure === 'user_required' && (!field.required || field.defaultPolicy !== 'require_user_value')) {
    throw new ProductFeatureContractError('invalid_schema', 'Required user fields must require an explicit value');
  }
  if (field.exposure === 'user_optional' && field.required) {
    throw new ProductFeatureContractError('invalid_schema', 'Optional user fields cannot be required');
  }
  if (field.exposure === 'user_optional' && field.defaultPolicy === 'require_user_value') {
    throw new ProductFeatureContractError('invalid_schema', 'Optional user fields cannot require a value');
  }
  if (field.exposure === 'product_fixed' && field.defaultPolicy !== 'use_product_fixed') {
    throw new ProductFeatureContractError('invalid_schema', 'Product-fixed fields must use product-fixed defaults');
  }
  if ((field.exposure === 'adapter_derived' || field.exposure === 'internal') && field.defaultPolicy !== 'derive_in_adapter') {
    throw new ProductFeatureContractError('invalid_schema', 'Derived and internal fields must be adapter-derived');
  }
  if (field.secret && field.exposure !== 'internal') {
    throw new ProductFeatureContractError('invalid_schema', 'Secret fields must be internal');
  }
  if (field.valueType === 'enum' && (!field.options || field.options.length === 0)) {
    throw new ProductFeatureContractError('invalid_schema', 'Enum fields require options');
  }
  if (field.options !== undefined) {
    if (field.valueType !== 'enum') {
      throw new ProductFeatureContractError('invalid_schema', 'Only enum fields may declare options');
    }
    assertUnique(field.options.map((option) => JSON.stringify(option)), 'parameter option');
  }
  for (const [value, label] of [
    [field.minimum, 'minimum'],
    [field.maximum, 'maximum'],
    [field.step, 'step']
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || (label === 'step' && value === 0))) {
      throw new ProductFeatureContractError('invalid_schema', `Parameter ${label} is invalid`);
    }
  }
  if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) {
    throw new ProductFeatureContractError('invalid_schema', 'Parameter range is inverted');
  }
  if (field.unitId !== undefined) requireStableId(field.unitId, 'parameter unit ID');
  return {
    ...field,
    ...(field.display ? { display: validateParameterDisplay(field) } : {})
  };
}

function validateParameterDisplay(
  field: ParameterFieldSchemaV2
): NonNullable<ParameterFieldSchemaV2['display']> {
  const display = field.display;
  if (!display || Object.keys(display).some((key) => ![
    'label', 'description', 'groupLabel', 'note', 'optionLabels', 'visibleWhen'
  ].includes(key))) {
    throw new ProductFeatureContractError('invalid_schema', 'Parameter display metadata is invalid');
  }
  const optionLabels = display.optionLabels?.map((option) => {
    if (!isPlainRecord(option) ||
      Object.keys(option).some((key) => !['value', 'label'].includes(key)) ||
      !field.options?.some((value) => Object.is(value, option.value))) {
      throw new ProductFeatureContractError(
        'invalid_schema',
        'Parameter option display metadata is invalid'
      );
    }
    return { value: option.value as ParameterScalar, label: displayText(option.label, 80) };
  });
  if (optionLabels &&
    new Set(optionLabels.map((option) => JSON.stringify(option.value))).size !== optionLabels.length) {
    throw new ProductFeatureContractError(
      'invalid_schema',
      'Parameter option display metadata must be unique'
    );
  }
  let visibleWhen: NonNullable<ParameterFieldSchemaV2['display']>['visibleWhen'];
  if (display.visibleWhen !== undefined) {
    const condition = display.visibleWhen;
    if (!isPlainRecord(condition) ||
      Object.keys(condition).some((key) => !['fieldId', 'operator', 'value'].includes(key)) ||
      !['equals', 'not_equals'].includes(String(condition.operator)) ||
      !['string', 'number', 'boolean'].includes(typeof condition.value)) {
      throw new ProductFeatureContractError(
        'invalid_schema',
        'Parameter display condition is invalid'
      );
    }
    requireStableId(condition.fieldId, 'parameter display condition field ID');
    visibleWhen = {
      fieldId: condition.fieldId,
      operator: condition.operator as 'equals' | 'not_equals',
      value: condition.value as ParameterScalar
    };
  }
  return {
    ...(display.label === undefined ? {} : { label: displayText(display.label, 80) }),
    ...(display.description === undefined
      ? {}
      : { description: displayText(display.description, 500) }),
    ...(display.groupLabel === undefined
      ? {}
      : { groupLabel: displayText(display.groupLabel, 80) }),
    ...(display.note === undefined ? {} : { note: displayText(display.note, 200) }),
    ...(optionLabels ? { optionLabels } : {}),
    ...(visibleWhen ? { visibleWhen } : {})
  };
}

function displayText(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 ||
    value.length > maximumLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProductFeatureContractError('invalid_schema', 'Parameter display text is invalid');
  }
  return value.trim();
}

function validateParameterValue(field: ParameterFieldSchemaV2, value: unknown): void {
  if (value === undefined) {
    throw new ProductFeatureContractError('invalid_parameter', `Parameter ${field.fieldId} is undefined`);
  }
  if (field.valueType === 'string' || field.valueType === 'media_slot') {
    if (typeof value !== 'string') invalidParameter(field);
  } else if (field.valueType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalidParameter(field);
  } else if (field.valueType === 'integer') {
    if (!Number.isSafeInteger(value)) invalidParameter(field);
  } else if (field.valueType === 'boolean') {
    if (typeof value !== 'boolean') invalidParameter(field);
  } else if (field.valueType === 'enum') {
    if (!field.options?.some((option) => Object.is(option, value))) invalidParameter(field);
  } else if (field.valueType === 'string_array') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) invalidParameter(field);
  } else if (field.valueType === 'number_array') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) invalidParameter(field);
  } else if (field.valueType === 'object') {
    if (!isPlainRecord(value)) invalidParameter(field);
  }
  const numericValues = field.valueType === 'number_array' && Array.isArray(value)
    ? value
    : typeof value === 'number'
      ? [value]
      : [];
  for (const numeric of numericValues) {
    if (field.minimum !== undefined && numeric < field.minimum) invalidParameter(field);
    if (field.maximum !== undefined && numeric > field.maximum) invalidParameter(field);
    if (field.step !== undefined && field.minimum !== undefined && (numeric - field.minimum) % field.step !== 0) invalidParameter(field);
  }
}

function invalidParameter(field: ParameterFieldSchemaV2): never {
  throw new ProductFeatureContractError('invalid_parameter', `Parameter ${field.fieldId} has an invalid value`);
}

function requireSingleImage(imageCount: number, feature: ProductFeature): void {
  if (imageCount !== 1) throw featureConstraint(`${feature} requires exactly one image`);
}

function featureConstraint(message: string): ProductFeatureContractError {
  return new ProductFeatureContractError('feature_constraint_violation', message);
}

function count(value: number | undefined, label: string): number {
  const result = value ?? 0;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ProductFeatureContractError('feature_constraint_violation', `${label} is invalid`);
  }
  return result;
}

function requireStableId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new ProductFeatureContractError('invalid_schema', `${label} is invalid`);
  }
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new ProductFeatureContractError('invalid_schema', `Duplicate ${label} is not allowed`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
