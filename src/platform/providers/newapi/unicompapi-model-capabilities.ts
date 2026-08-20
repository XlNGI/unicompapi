import type { ParameterFieldSchemaV2, ParameterSchemaV2 } from '../../../domain';
import { UNICOMPAPI_PROVIDER_PACKAGE_ID } from './unicompapi-contracts';

export const UNICOMPAPI_SEEDREAM_5_MODEL_KEY = 'doubao-seedream-5-0-260128';
export const UNICOMPAPI_SEEDREAM_5_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.doubao_seedream_5_0_260128.text_to_image.official';
export const UNICOMPAPI_QWEN_IMAGE_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.qwen_image.text_to_image.official';
export const UNICOMPAPI_QWEN_IMAGE_REFERENCE_TO_IMAGE_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.qwen_image_edit_2509.reference_to_image.official';

/**
 * Seedream 5.0 lite image-generation parameters supported by the current
 * non-streaming, single-image UniCompAPI integration.
 */
export const uniCompApiSeedream5TextToImageParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: UNICOMPAPI_SEEDREAM_5_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID,
  revision: 1,
  productFeature: 'text_to_image',
  fields: [
    {
      fieldId: 'size',
      labelId: 'provider.parameter.size',
      groupId: 'provider.parameter.generation',
      order: 10,
      valueType: 'enum',
      exposure: 'user_required',
      defaultPolicy: 'require_user_value',
      required: true,
      options: ['2K', '3K', '4K']
    },
    {
      fieldId: 'output_format',
      labelId: 'provider.parameter.output_format',
      groupId: 'provider.parameter.generation',
      order: 20,
      valueType: 'enum',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      options: ['jpeg', 'png']
    },
    {
      fieldId: 'response_format',
      labelId: 'provider.parameter.response_format',
      groupId: 'provider.parameter.generation',
      order: 30,
      valueType: 'enum',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      options: ['url', 'b64_json']
    },
    {
      fieldId: 'watermark',
      labelId: 'provider.parameter.watermark',
      groupId: 'provider.parameter.generation',
      order: 40,
      valueType: 'boolean',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    }
  ]
};

const qwenImageSizeOptions = [
  '1664*928',
  '1472*1104',
  '1328*1328',
  '1104*1472',
  '928*1664'
] as const;

function qwenOptionalField(
  fieldId: string,
  valueType: ParameterFieldSchemaV2['valueType'],
  order: number,
  extra: Partial<ParameterFieldSchemaV2> = {}
): ParameterFieldSchemaV2 {
  return {
    fieldId,
    labelId: `provider.parameter.${fieldId}`,
    groupId: 'provider.parameter.generation',
    order,
    valueType,
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false,
    ...extra
  };
}

/**
 * Qwen-Image parameters exposed by the UniCompAPI OpenAI-compatible gateway.
 * Qwen keeps PNG output and a single result fixed for this catalog model, so
 * generic OpenAI quality/style/output-format controls are intentionally absent.
 */
export const uniCompApiQwenImageTextToImageParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: UNICOMPAPI_QWEN_IMAGE_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID,
  revision: 1,
  productFeature: 'text_to_image',
  fields: [
    qwenOptionalField('size', 'enum', 10, { options: qwenImageSizeOptions }),
    qwenOptionalField('negative_prompt', 'string', 20),
    qwenOptionalField('prompt_extend', 'boolean', 30),
    qwenOptionalField('watermark', 'boolean', 40),
    qwenOptionalField('seed', 'integer', 50, {
      minimum: 0,
      maximum: 2_147_483_647
    })
  ]
};

/**
 * qwen-image-edit-2509 is the legacy single-output reference model. Its
 * documented controls are negative prompt, watermark, and seed; size,
 * prompt extension, and output-format controls are not sent by default.
 */
export const uniCompApiQwenImageReferenceToImageParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: UNICOMPAPI_QWEN_IMAGE_REFERENCE_TO_IMAGE_PARAMETER_SCHEMA_ID,
  revision: 1,
  productFeature: 'reference_to_image',
  fields: [
    qwenOptionalField('negative_prompt', 'string', 10),
    qwenOptionalField('watermark', 'boolean', 20),
    qwenOptionalField('seed', 'integer', 30, {
      minimum: 0,
      maximum: 2_147_483_647
    })
  ]
};

export type UniCompApiVideoFeature = 'text_to_video' | 'image_to_video';

export type UniCompApiModelFeature =
  | 'text_chat'
  | 'text_reasoning'
  | 'text_to_image'
  | 'reference_to_image'
  | 'image_edit'
  | UniCompApiVideoFeature;

const uniCompApiModelFeatureMap = new Map<string, readonly UniCompApiModelFeature[]>([
  ['deepseek-r1-0528', ['text_chat', 'text_reasoning']],
  ['deepseek-v3', ['text_chat', 'text_reasoning']],
  ['deepseek-v3.2', ['text_chat', 'text_reasoning']],
  ['deepseek-v3.2-exp', ['text_chat', 'text_reasoning']],
  ['deepseek-v4-flash', ['text_chat', 'text_reasoning']],
  ['deepseek-v4-pro', ['text_chat', 'text_reasoning']],
  ['doubao-seedance-2-0-260128', ['text_to_video', 'image_to_video']],
  ['doubao-seedance-2-0-fast-260128', ['text_to_video', 'image_to_video']],
  [UNICOMPAPI_SEEDREAM_5_MODEL_KEY, ['text_to_image']],
  ['glm-4.6', ['text_chat', 'text_reasoning']],
  ['glm-4.7', ['text_chat', 'text_reasoning']],
  ['glm-5', ['text_chat', 'text_reasoning']],
  ['glm-5.1', ['text_chat', 'text_reasoning']],
  ['glm-5.2', ['text_chat', 'text_reasoning']],
  ['gpt-5.6-luna', ['text_chat']],
  ['gpt-5.6-sol', ['text_chat']],
  ['gpt-5.6-terra', ['text_chat']],
  ['happyhorse-1.0-i2v', ['image_to_video']],
  ['happyhorse-1.0-r2v', []],
  ['happyhorse-1.0-t2v', ['text_to_video']],
  ['happyhorse-1.0-video-edit', []],
  ['happyhorse-1.1-i2v', ['image_to_video']],
  ['happyhorse-1.1-r2v', []],
  ['happyhorse-1.1-t2v', ['text_to_video']],
  ['kimi-k2.6', ['text_chat']],
  ['kling-v3-turbo', ['text_to_video', 'image_to_video']],
  ['kimi-k3', ['text_chat', 'text_reasoning']],
  ['qwen-image', ['text_to_image']],
  ['qwen-image-edit-2509', ['reference_to_image']],
  ['qwen3-235b-a22b', ['text_chat', 'text_reasoning']],
  ['qwen3-32b', ['text_chat', 'text_reasoning']],
  ['viduq3', ['image_to_video']],
  ['viduq3-mix', ['image_to_video']],
  ['viduq3-pro', ['text_to_video']],
  ['viduq3-turbo', ['text_to_video', 'image_to_video']]
]);

export function isUniCompApiPackage(packageId: string): boolean {
  return packageId === UNICOMPAPI_PROVIDER_PACKAGE_ID;
}

export function isUniCompApiDeepSeekModel(providerModelKey: string): boolean {
  return providerModelKey.startsWith('deepseek-') &&
    (uniCompApiModelFeatureMap.get(providerModelKey)?.includes('text_reasoning') ?? false);
}

export function uniCompApiModelFeatures(
  providerModelKey: string
): readonly UniCompApiModelFeature[] | undefined {
  return uniCompApiModelFeatureMap.get(providerModelKey);
}

export function uniCompApiTextToImageParameterSchema(
  providerModelKey: string
): ParameterSchemaV2 | undefined {
  if (providerModelKey === UNICOMPAPI_SEEDREAM_5_MODEL_KEY) {
    return uniCompApiSeedream5TextToImageParameterSchema;
  }
  return providerModelKey === 'qwen-image'
    ? uniCompApiQwenImageTextToImageParameterSchema
    : undefined;
}

export function uniCompApiReferenceToImageParameterSchema(
  providerModelKey: string
): ParameterSchemaV2 | undefined {
  return providerModelKey === 'qwen-image-edit-2509'
    ? uniCompApiQwenImageReferenceToImageParameterSchema
    : undefined;
}

export function isKnownUniCompApiModel(providerModelKey: string): boolean {
  return uniCompApiModelFeatureMap.has(providerModelKey);
}

export function uniCompApiSupportsFeature(
  packageId: string,
  providerModelKey: string,
  feature: UniCompApiModelFeature
): boolean {
  if (!isUniCompApiPackage(packageId)) return true;
  const features = uniCompApiModelFeatures(providerModelKey);
  // Preserve legacy manual-registration behavior for model keys that are not
  // part of the current UniCompAPI catalog. Exact catalog keys are closed-
  // world and only receive explicitly declared features.
  return features === undefined ? true : features.includes(feature);
}

export function uniCompApiVideoFeatures(
  providerModelKey: string
): readonly UniCompApiVideoFeature[] | undefined {
  const features = uniCompApiModelFeatures(providerModelKey);
  if (features === undefined) return undefined;
  return features.filter(
    (feature): feature is UniCompApiVideoFeature =>
      feature === 'text_to_video' || feature === 'image_to_video'
  );
}

export function isUniCompApiViduModel(providerModelKey: string): boolean {
  return ['viduq3', 'viduq3-mix', 'viduq3-pro', 'viduq3-turbo']
    .includes(providerModelKey);
}

export function uniCompApiSupportsText(
  packageId: string,
  providerModelKey: string
): boolean {
  return uniCompApiSupportsFeature(packageId, providerModelKey, 'text_chat');
}

export function uniCompApiSupportsImage(
  packageId: string,
  providerModelKey: string
): boolean {
  return uniCompApiSupportsFeature(packageId, providerModelKey, 'text_to_image');
}

export function uniCompApiSupportsImageEdit(
  packageId: string,
  providerModelKey: string
): boolean {
  return uniCompApiSupportsFeature(packageId, providerModelKey, 'image_edit');
}

export function uniCompApiSupportsReferenceImage(
  packageId: string,
  providerModelKey: string
): boolean {
  return uniCompApiSupportsFeature(
    packageId,
    providerModelKey,
    'reference_to_image'
  );
}
