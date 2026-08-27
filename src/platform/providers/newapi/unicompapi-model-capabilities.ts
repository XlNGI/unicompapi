import type { ParameterFieldSchemaV2, ParameterSchemaV2 } from '../../../domain';
import { createViduModelContract } from '../vidu/vidu-contracts';
import { UNICOMPAPI_PROVIDER_PACKAGE_ID } from './unicompapi-contracts';

export const UNICOMPAPI_SEEDREAM_5_MODEL_KEY = 'doubao-seedream-5-0-260128';
export const UNICOMPAPI_SEEDREAM_5_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.doubao_seedream_5_0_260128.text_to_image.official';
export const UNICOMPAPI_QWEN_IMAGE_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.qwen_image.text_to_image.official';
export const UNICOMPAPI_QWEN_IMAGE_REFERENCE_TO_IMAGE_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.qwen_image_edit_2509.reference_to_image.official';
export const UNICOMPAPI_SEEDANCE_2_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.doubao_seedance_2_0_260128.text_to_video.official';
export const UNICOMPAPI_SEEDANCE_2_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.doubao_seedance_2_0_260128.image_to_video.official';
export const UNICOMPAPI_SEEDANCE_2_FAST_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.doubao_seedance_2_0_fast_260128.text_to_video.official';
export const UNICOMPAPI_SEEDANCE_2_FAST_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.doubao_seedance_2_0_fast_260128.image_to_video.official';
export const UNICOMPAPI_VIDUQ3_TURBO_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.viduq3_turbo.image_to_video.official_mapping';
export const UNICOMPAPI_VIDUQ3_TURBO_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.viduq3_turbo.text_to_video.official_mapping';
export const UNICOMPAPI_VIDUQ3_PRO_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.viduq3_pro.text_to_video.official_mapping';


export const UNICOMPAPI_DEFAULT_TEXT_CHAT_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.text_chat.official';
export const UNICOMPAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID =
  'parameters.unicompapi.text_reasoning.official';

function uniCompApiTextField(
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
 * UniCompAPI text chat parameters limited to the official OpenAI-compatible
 * Chat Completions contract. Unverified vendor extensions (thinking, top_k,
 * chat_template_kwargs, enable_thinking, metadata) are intentionally absent:
 * UniCompAPI rejects request fields that are not part of its public contract.
 */
export const uniCompApiTextChatParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: UNICOMPAPI_DEFAULT_TEXT_CHAT_PARAMETER_SCHEMA_ID,
  revision: 1,
  productFeature: 'text_chat',
  fields: [
    uniCompApiTextField('max_tokens', 'integer', 10, { minimum: 1, maximum: 128_000 }),
    uniCompApiTextField('temperature', 'number', 20, { minimum: 0, maximum: 2 }),
    uniCompApiTextField('top_p', 'number', 30, { minimum: 0, maximum: 1 }),
    uniCompApiTextField('stop', 'string', 40),
    uniCompApiTextField('n', 'integer', 50, { minimum: 1, maximum: 8 }),
    uniCompApiTextField('presence_penalty', 'number', 60),
    uniCompApiTextField('frequency_penalty', 'number', 70),
    uniCompApiTextField('seed', 'integer', 80),
    uniCompApiTextField('response_format', 'object', 90),
    uniCompApiTextField('tool_choice', 'string', 100),
    uniCompApiTextField('user', 'string', 110),
    uniCompApiTextField('logit_bias', 'object', 120)
  ]
};

/**
 * UniCompAPI text reasoning parameters limited to the official
 * Chat Completions contract (reasoning_effort + standard sampling fields).
 * No thinking / chat_template_kwargs / enable_thinking / top_k: those are not
 * part of the public UniCompAPI contract and are rejected by the gateway.
 */
export const uniCompApiTextReasoningParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: UNICOMPAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID,
  revision: 1,
  productFeature: 'text_reasoning',
  fields: [
    uniCompApiTextField('max_completion_tokens', 'integer', 10, {
      minimum: 1,
      maximum: 128_000
    }),
    uniCompApiTextField('reasoning_effort', 'enum', 20, {
      options: ['low', 'medium', 'high']
    }),
    uniCompApiTextField('stop', 'string', 30),
    uniCompApiTextField('n', 'integer', 40, { minimum: 1, maximum: 8 }),
    uniCompApiTextField('presence_penalty', 'number', 50),
    uniCompApiTextField('frequency_penalty', 'number', 60),
    uniCompApiTextField('seed', 'integer', 70),
    uniCompApiTextField('response_format', 'object', 80),
    uniCompApiTextField('tool_choice', 'string', 90),
    uniCompApiTextField('user', 'string', 100),
    uniCompApiTextField('logit_bias', 'object', 110)
  ]
};

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
  '1664x928',
  '1472x1104',
  '1328x1328',
  '1104x1472',
  '928x1664'
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
  revision: 3,
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
      options: qwenImageSizeOptions
    },
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

const seedance2RatioOptions = [
  '21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'
] as const;

const seedance2DurationOptions = [
  -1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
] as const;

/**
 * Model-specific Seedance 2.0 controls verified against the Volcano Ark
 * documentation on 2026-08-26. `model` and input `content` are the only
 * required official API fields; all controls below are intentionally optional.
 */
function uniCompApiSeedance2VideoParameterSchema(
  schemaId: string,
  productFeature: UniCompApiVideoFeature,
  resolutionOptions: readonly string[]
): ParameterSchemaV2 {
  return {
    schemaVersion: 2,
    schemaId,
    revision: 1,
    productFeature,
    fields: [
      qwenOptionalField('resolution', 'enum', 10, { options: resolutionOptions }),
      qwenOptionalField('ratio', 'enum', 20, { options: seedance2RatioOptions }),
      qwenOptionalField('duration', 'enum', 30, { options: seedance2DurationOptions }),
      qwenOptionalField('frames', 'integer', 40, { minimum: 1 }),
      qwenOptionalField('seed', 'integer', 50, { minimum: 0 }),
      qwenOptionalField('camera_fixed', 'boolean', 60),
      qwenOptionalField('watermark', 'boolean', 70),
      qwenOptionalField('generate_audio', 'boolean', 80),
      qwenOptionalField('return_last_frame', 'boolean', 90)
    ]
  };
}

export const uniCompApiSeedance2TextToVideoParameterSchema =
  uniCompApiSeedance2VideoParameterSchema(
    UNICOMPAPI_SEEDANCE_2_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
    'text_to_video',
    ['480p', '720p', '1080p', '4k']
  );

export const uniCompApiSeedance2ImageToVideoParameterSchema =
  uniCompApiSeedance2VideoParameterSchema(
    UNICOMPAPI_SEEDANCE_2_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID,
    'image_to_video',
    ['480p', '720p', '1080p', '4k']
  );

export const uniCompApiSeedance2FastTextToVideoParameterSchema =
  uniCompApiSeedance2VideoParameterSchema(
    UNICOMPAPI_SEEDANCE_2_FAST_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
    'text_to_video',
    ['480p', '720p']
  );

export const uniCompApiSeedance2FastImageToVideoParameterSchema =
  uniCompApiSeedance2VideoParameterSchema(
    UNICOMPAPI_SEEDANCE_2_FAST_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID,
    'image_to_video',
    ['480p', '720p']
  );

function mappedViduVideoParameterSchema(
  providerModelKey: 'viduq3-turbo' | 'viduq3-pro',
  productFeature: UniCompApiVideoFeature,
  schemaId: string
): ParameterSchemaV2 {
  const official = createViduModelContract(providerModelKey).parameterSchemas.find(
    (schema) => schema.productFeature === productFeature
  );
  if (!official) {
    throw new TypeError('UniCompAPI Vidu mapping requires an exact official contract');
  }
  return {
    ...official,
    schemaId,
    fields: official.fields.map((field) => ({
      ...field,
      ...(field.options ? { options: [...field.options] } : {})
    }))
  };
}

/**
 * Exact UniCompAPI Vidu mappings reuse the official Vidu parameter semantics,
 * while submission remains on the UniCompAPI /v1/videos gateway transport.
 */
export const uniCompApiViduQ3TurboImageToVideoParameterSchema =
  mappedViduVideoParameterSchema(
    'viduq3-turbo',
    'image_to_video',
    UNICOMPAPI_VIDUQ3_TURBO_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID
  );

export const uniCompApiViduQ3TurboTextToVideoParameterSchema =
  mappedViduVideoParameterSchema(
    'viduq3-turbo',
    'text_to_video',
    UNICOMPAPI_VIDUQ3_TURBO_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID
  );

export const uniCompApiViduQ3ProTextToVideoParameterSchema =
  mappedViduVideoParameterSchema(
    'viduq3-pro',
    'text_to_video',
    UNICOMPAPI_VIDUQ3_PRO_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID
  );

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
  ['viduq3', []],
  ['viduq3-mix', []],
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

/**
 * Exact UniCompAPI DeepSeek V4 reasoning models that accept the official
 * `reasoning_effort` field (low/medium/high, default medium). Older DeepSeek
 * catalog models are not sent this field.
 */
export function isUniCompApiDeepSeekV4Model(providerModelKey: string): boolean {
  return providerModelKey === 'deepseek-v4-flash' || providerModelKey === 'deepseek-v4-pro';
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

export function uniCompApiVideoParameterSchema(
  providerModelKey: string,
  feature: UniCompApiVideoFeature
): ParameterSchemaV2 | undefined {
  if (providerModelKey === 'doubao-seedance-2-0-260128') {
    return feature === 'text_to_video'
      ? uniCompApiSeedance2TextToVideoParameterSchema
      : uniCompApiSeedance2ImageToVideoParameterSchema;
  }
  if (providerModelKey === 'doubao-seedance-2-0-fast-260128') {
    return feature === 'text_to_video'
      ? uniCompApiSeedance2FastTextToVideoParameterSchema
      : uniCompApiSeedance2FastImageToVideoParameterSchema;
  }
  if (providerModelKey === 'viduq3-turbo') {
    return feature === 'text_to_video'
      ? uniCompApiViduQ3TurboTextToVideoParameterSchema
      : uniCompApiViduQ3TurboImageToVideoParameterSchema;
  }
  if (providerModelKey === 'viduq3-pro' && feature === 'text_to_video') {
    return uniCompApiViduQ3ProTextToVideoParameterSchema;
  }
  return undefined;
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
  // Closed-world routing: only exact declared capabilities are routable.
  // Unknown catalog or manual keys stay without any inferred profile until
  // the capability table, schema and routing tests are explicitly extended.
  return features === undefined ? false : features.includes(feature);
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
