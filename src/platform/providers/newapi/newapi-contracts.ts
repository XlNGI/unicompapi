import { createHash } from 'node:crypto';
import {
  createUsageSchema,
  toUsageSchemaId,
  type ParameterFieldSchemaV2,
  type ParameterSchemaV2,
  type ProductFeature,
  type ProviderModelDefinition,
  type ProviderPackageDescriptor,
  type UsageSchemaV1
} from '../../../domain';

export const NEWAPI_PROVIDER_PACKAGE_ID = 'provider-package-newapi';
export const NEWAPI_PROVIDER_PACKAGE_VERSION = '1.0.0';
export const NEWAPI_COMPATIBLE_TEMPLATE_ID = 'newapi-compatible';
export const NEWAPI_CREDENTIAL_SCHEMA_ID = 'credential.newapi.api-key';
export const NEWAPI_ENDPOINT_POLICY_ID = 'endpoint.newapi.compatible';
export const NEWAPI_SOURCE_DOCUMENT_REVISION =
  'newapi-docs-and-openai-video-status@2026-08-03';

export const NEWAPI_CHAT_ADAPTER_ID = 'newapi.chat';
export const NEWAPI_IMAGE_ADAPTER_ID = 'newapi.image';
export const NEWAPI_VIDEO_ADAPTER_ID = 'newapi.video';
export const NEWAPI_ADAPTER_VERSION = '2026-08-03';
export const NEWAPI_CHAT_PROTOCOL_ID = 'newapi.openai.chat-completions';
export const NEWAPI_IMAGE_PROTOCOL_ID = 'newapi.openai.images-generations';
export const NEWAPI_VIDEO_PROTOCOL_ID = 'newapi.openai.videos';
export const NEWAPI_PROTOCOL_VERSION = '2026-08-03';

export const NEWAPI_CHAT_RESULT_SCHEMA_ID = 'results.newapi.chat';
export const NEWAPI_IMAGE_RESULT_SCHEMA_ID = 'results.newapi.image';
export const NEWAPI_VIDEO_RESULT_SCHEMA_ID = 'results.newapi.video';
export const NEWAPI_CHAT_USAGE_SCHEMA_ID = 'usage.newapi.chat-completions';
export const NEWAPI_IMAGE_USAGE_SCHEMA_ID = 'usage.newapi.image-generation';
export const NEWAPI_VIDEO_USAGE_SCHEMA_ID = 'usage.newapi.video-not-reported';
export const NEWAPI_TEXT_CONSTRAINT_SET_ID = 'constraints.newapi.text';
export const NEWAPI_IMAGE_CONSTRAINT_SET_ID = 'constraints.newapi.text-to-image';
export const NEWAPI_IMAGE_EDIT_CONSTRAINT_SET_ID =
  'constraints.newapi.image-edit.single-image';
export const NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID =
  'constraints.newapi.text-to-video';
export const NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID =
  'constraints.newapi.image-to-video.single-image';
export const NEWAPI_DEFAULT_TEXT_CHAT_PARAMETER_SCHEMA_ID =
  'parameters.newapi.text_chat.default';
export const NEWAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID =
  'parameters.newapi.text_reasoning.default';
export const NEWAPI_DEFAULT_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID =
  'parameters.newapi.text_to_image.default';
export const NEWAPI_DEFAULT_IMAGE_EDIT_PARAMETER_SCHEMA_ID =
  'parameters.newapi.image_edit.default';
export const NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID =
  'parameters.newapi.text_to_video.default';
export const NEWAPI_DEFAULT_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID =
  'parameters.newapi.image_to_video.default';

export interface NewApiNumericRangeDeclarationV1 {
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface NewApiTextFeatureDeclarationV1 {
  readonly maxTokens?: NewApiNumericRangeDeclarationV1;
  readonly temperature?: NewApiNumericRangeDeclarationV1;
  readonly topP?: NewApiNumericRangeDeclarationV1;
  readonly reasoningEfforts?: readonly string[];
}

export interface NewApiImageFeatureDeclarationV1 {
  readonly sizes?: readonly string[];
  readonly qualities?: readonly string[];
  readonly styles?: readonly string[];
  readonly outputFormats?: readonly string[];
}

export interface NewApiVideoFeatureDeclarationV1 {
  readonly durations?: readonly number[];
  readonly widths?: readonly number[];
  readonly heights?: readonly number[];
  readonly frameRates?: readonly number[];
  readonly supportsSeed?: boolean;
}

export interface NewApiModelProfileDeclarationV1 {
  readonly textChat?: NewApiTextFeatureDeclarationV1;
  readonly textReasoning?: NewApiTextFeatureDeclarationV1;
  readonly textToImage?: NewApiImageFeatureDeclarationV1;
  readonly textToVideo?: NewApiVideoFeatureDeclarationV1;
  readonly imageToVideo?: NewApiVideoFeatureDeclarationV1;
}

export interface NewApiModelContractV1 {
  readonly definition: ProviderModelDefinition;
  readonly parameterSchemas: readonly ParameterSchemaV2[];
  readonly contractHash: string;
}

export const newApiChatUsageSchema: UsageSchemaV1 = createUsageSchema({
  id: toUsageSchemaId(NEWAPI_CHAT_USAGE_SCHEMA_ID),
  revision: 1,
  completenessRule: 'all_required_metrics',
  conflictPolicy: 'mark_invalid_response',
  metrics: [
    tokenMetric('completion_tokens', true),
    tokenMetric('prompt_tokens', true),
    tokenMetric('total_tokens', true),
    tokenMetric('reasoning_tokens', false),
    tokenMetric('cached_tokens', false)
  ]
});

/**
 * Default OpenAI-compatible text schemas for UniCompAPI / NewAPI soft routing.
 * Required wire fields are only model + messages (forced by the adapter).
 * Optional sampling fields follow the gateway chat/completions surface;
 * stream stays adapter-controlled (always true with include_usage).
 */
export const newApiDefaultTextChatParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: NEWAPI_DEFAULT_TEXT_CHAT_PARAMETER_SCHEMA_ID,
  revision: 3,
  productFeature: 'text_chat',
  fields: [
    {
      fieldId: 'max_tokens',
      labelId: 'provider.parameter.max_tokens',
      groupId: 'provider.parameter.generation',
      order: 10,
      valueType: 'integer',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      minimum: 1,
      maximum: 128000
    },
    {
      fieldId: 'temperature',
      labelId: 'provider.parameter.temperature',
      groupId: 'provider.parameter.generation',
      order: 20,
      valueType: 'number',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      minimum: 0,
      maximum: 2
    },
    {
      fieldId: 'top_p',
      labelId: 'provider.parameter.top_p',
      groupId: 'provider.parameter.generation',
      order: 30,
      valueType: 'number',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      minimum: 0,
      maximum: 1
    },
    {
      fieldId: 'stop',
      labelId: 'provider.parameter.stop',
      groupId: 'provider.parameter.generation',
      order: 40,
      valueType: 'string',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    ...createAdvancedChatParameterFields(50)
  ]
};

export const newApiDefaultTextReasoningParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: NEWAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID,
  revision: 3,
  productFeature: 'text_reasoning',
  fields: [
    {
      fieldId: 'max_completion_tokens',
      labelId: 'provider.parameter.max_completion_tokens',
      groupId: 'provider.parameter.generation',
      order: 10,
      valueType: 'integer',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      minimum: 1,
      maximum: 128000
    },
    {
      fieldId: 'reasoning_effort',
      labelId: 'provider.parameter.reasoning_effort',
      groupId: 'provider.parameter.generation',
      order: 20,
      valueType: 'enum',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      options: ['low', 'medium', 'high']
    },
    {
      fieldId: 'stop',
      labelId: 'provider.parameter.stop',
      groupId: 'provider.parameter.generation',
      order: 30,
      valueType: 'string',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    ...createAdvancedReasoningParameterFields(40)
  ]
};

function createAdvancedChatParameterFields(startOrder: number): readonly ParameterFieldSchemaV2[] {
  return [
    integerParameterField('n', 'provider.parameter.n', startOrder, 1, 8),
    numberParameterField('presence_penalty', 'provider.parameter.presence_penalty', startOrder + 10),
    numberParameterField('frequency_penalty', 'provider.parameter.frequency_penalty', startOrder + 20),
    integerParameterField('seed', 'provider.parameter.seed', startOrder + 30),
    objectParameterField('response_format', 'provider.parameter.response_format', startOrder + 40),
    stringParameterField('tool_choice', 'provider.parameter.tool_choice', startOrder + 50),
    booleanParameterField('parallel_tool_calls', 'provider.parameter.parallel_tool_calls', startOrder + 60),
    stringParameterField('user', 'provider.parameter.user', startOrder + 70),
    objectParameterField('metadata', 'provider.parameter.metadata', startOrder + 80)
  ];
}

function createAdvancedReasoningParameterFields(startOrder: number): readonly ParameterFieldSchemaV2[] {
  return [
    integerParameterField('n', 'provider.parameter.n', startOrder, 1, 8),
    integerParameterField('top_k', 'provider.parameter.top_k', startOrder + 10, 0),
    objectParameterField('thinking', 'provider.parameter.thinking', startOrder + 20),
    booleanParameterField('enable_thinking', 'provider.parameter.enable_thinking', startOrder + 30),
    objectParameterField('chat_template_kwargs', 'provider.parameter.chat_template_kwargs', startOrder + 40),
    objectParameterField('response_format', 'provider.parameter.response_format', startOrder + 50),
    stringParameterField('user', 'provider.parameter.user', startOrder + 60),
    objectParameterField('metadata', 'provider.parameter.metadata', startOrder + 70)
  ];
}

function integerParameterField(
  fieldId: string,
  labelId: string,
  order: number,
  minimum?: number,
  maximum?: number
): ParameterFieldSchemaV2 {
  return {
    fieldId,
    labelId,
    groupId: 'provider.parameter.generation',
    order,
    valueType: 'integer',
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false,
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum })
  };
}

function numberParameterField(fieldId: string, labelId: string, order: number): ParameterFieldSchemaV2 {
  return {
    fieldId,
    labelId,
    groupId: 'provider.parameter.generation',
    order,
    valueType: 'number',
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false
  };
}

function stringParameterField(fieldId: string, labelId: string, order: number): ParameterFieldSchemaV2 {
  return {
    fieldId,
    labelId,
    groupId: 'provider.parameter.metadata',
    order,
    valueType: 'string',
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false
  };
}

function booleanParameterField(fieldId: string, labelId: string, order: number): ParameterFieldSchemaV2 {
  return {
    fieldId,
    labelId,
    groupId: 'provider.parameter.tools',
    order,
    valueType: 'boolean',
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false
  };
}

function objectParameterField(fieldId: string, labelId: string, order: number): ParameterFieldSchemaV2 {
  return {
    fieldId,
    labelId,
    groupId: 'provider.parameter.metadata',
    order,
    valueType: 'object',
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false
  };
}

/**
 * Default OpenAI-compatible text_to_image schema for POST /v1/images/generations.
 * Mirrors the public parameter surface for generation; edit/multi-image inputs
 * (images / image / mask) stay out of text_to_image.
 */
export const newApiDefaultTextToImageParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: NEWAPI_DEFAULT_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID,
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
      options: [
        '1024x1024',
        '1536x1024',
        '1024x1536',
        '1792x1024',
        '1024x1792',
        '1328x1328',
        '1664x928',
        '928x1664'
      ]
    },
    {
      fieldId: 'n',
      labelId: 'provider.parameter.n',
      groupId: 'provider.parameter.generation',
      order: 20,
      valueType: 'integer',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      minimum: 1,
      maximum: 8
    },
    {
      fieldId: 'quality',
      labelId: 'provider.parameter.quality',
      groupId: 'provider.parameter.generation',
      order: 30,
      valueType: 'enum',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      options: ['auto', 'standard', 'hd', 'high', 'medium', 'low']
    },
    {
      fieldId: 'response_format',
      labelId: 'provider.parameter.response_format',
      groupId: 'provider.parameter.generation',
      order: 40,
      valueType: 'enum',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      options: ['url', 'b64_json']
    },
    {
      fieldId: 'style',
      labelId: 'provider.parameter.style',
      groupId: 'provider.parameter.generation',
      order: 50,
      valueType: 'enum',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      options: ['vivid', 'natural']
    },
    {
      fieldId: 'output_format',
      labelId: 'provider.parameter.output_format',
      groupId: 'provider.parameter.generation',
      order: 60,
      valueType: 'enum',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      options: ['png', 'jpeg', 'webp']
    },
    {
      fieldId: 'watermark',
      labelId: 'provider.parameter.watermark',
      groupId: 'provider.parameter.generation',
      order: 70,
      valueType: 'boolean',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    }
  ]
};

export const newApiDefaultImageEditParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: NEWAPI_DEFAULT_IMAGE_EDIT_PARAMETER_SCHEMA_ID,
  revision: 1,
  productFeature: 'image_edit',
  fields: [
    {
      fieldId: 'size',
      labelId: 'provider.parameter.size',
      groupId: 'provider.parameter.generation',
      order: 10,
      valueType: 'string',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    {
      fieldId: 'n',
      labelId: 'provider.parameter.n',
      groupId: 'provider.parameter.generation',
      order: 20,
      valueType: 'integer',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      minimum: 1,
      maximum: 1
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
    },
    {
      fieldId: 'input_fidelity',
      labelId: 'provider.parameter.input_fidelity',
      groupId: 'provider.parameter.generation',
      order: 50,
      valueType: 'string',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    }
  ]
};

/** Default OpenAI-compatible video schemas: optional fields only; provider defaults apply. */
export const newApiDefaultTextToVideoParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
  revision: 2,
  productFeature: 'text_to_video',
  fields: createOpenAiCompatibleDefaultVideoParameterFields()
};

export const newApiDefaultImageToVideoParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: NEWAPI_DEFAULT_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID,
  revision: 2,
  productFeature: 'image_to_video',
  fields: createOpenAiCompatibleDefaultVideoParameterFields()
};

function createOpenAiCompatibleDefaultVideoParameterFields(): readonly ParameterFieldSchemaV2[] {
  return [
    {
      fieldId: 'duration',
      labelId: 'provider.parameter.duration',
      groupId: 'provider.parameter.generation',
      order: 10,
      valueType: 'integer',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    {
      fieldId: 'resolution',
      labelId: 'provider.parameter.resolution',
      groupId: 'provider.parameter.generation',
      order: 20,
      valueType: 'string',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    {
      fieldId: 'aspect_ratio',
      labelId: 'provider.parameter.aspect_ratio',
      groupId: 'provider.parameter.generation',
      order: 30,
      valueType: 'string',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    {
      fieldId: 'audio',
      labelId: 'provider.parameter.audio',
      groupId: 'provider.parameter.generation',
      order: 40,
      valueType: 'boolean',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    {
      fieldId: 'mode',
      labelId: 'provider.parameter.mode',
      groupId: 'provider.parameter.generation',
      order: 50,
      valueType: 'string',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    {
      fieldId: 'seed',
      labelId: 'provider.parameter.seed',
      groupId: 'provider.parameter.generation',
      order: 60,
      valueType: 'integer',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    {
      fieldId: 'ratio',
      labelId: 'provider.parameter.ratio',
      groupId: 'provider.parameter.generation',
      order: 70,
      valueType: 'string',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    {
      fieldId: 'generate_audio',
      labelId: 'provider.parameter.generate_audio',
      groupId: 'provider.parameter.generation',
      order: 80,
      valueType: 'boolean',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    {
      fieldId: 'watermark',
      labelId: 'provider.parameter.watermark',
      groupId: 'provider.parameter.generation',
      order: 90,
      valueType: 'boolean',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    {
      fieldId: 'camera_fixed',
      labelId: 'provider.parameter.camera_fixed',
      groupId: 'provider.parameter.generation',
      order: 100,
      valueType: 'boolean',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    {
      fieldId: 'return_last_frame',
      labelId: 'provider.parameter.return_last_frame',
      groupId: 'provider.parameter.generation',
      order: 110,
      valueType: 'boolean',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false
    },
    {
      fieldId: 'frames',
      labelId: 'provider.parameter.frames',
      groupId: 'provider.parameter.generation',
      order: 120,
      valueType: 'integer',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      minimum: 1,
      maximum: 10000
    }
  ];
}

/**
 * Exact Model Definition for OpenAI-compatible chat bindings.
 * Does not infer image/video; only attaches package-approved text features.
 */
export function createOpenAiCompatibleDefaultTextDefinition(input: {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly providerModelKey: string;
  readonly features?: readonly ('text_chat' | 'text_reasoning')[];
}): ProviderModelDefinition {
  const providerModelKey = requireProviderModelKey(input.providerModelKey);
  if (
    input.packageId !== NEWAPI_PROVIDER_PACKAGE_ID &&
    input.packageId !== 'provider-package-unicompapi'
  ) {
    throw new TypeError('OpenAI-compatible text definitions require a known package id');
  }
  const suffix = createHash('sha256')
    .update(canonicalJson({
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      providerModelKey,
      features: input.features ?? ['text_chat', 'text_reasoning']
    }))
    .digest('hex')
    .slice(0, 16);
  const features = input.features ?? ['text_chat', 'text_reasoning'];
  if (
    features.length < 1 ||
    new Set(features).size !== features.length ||
    features.some((feature) => feature !== 'text_chat' && feature !== 'text_reasoning')
  ) {
    throw new TypeError('OpenAI-compatible text features are invalid');
  }
  return {
    schemaVersion: 1,
    definitionId: `definition.openai-compatible.text.${suffix}`,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    providerModelKey,
    profileTemplates: [
      {
        templateId: `profile-template.openai-compatible.text.${suffix}`,
        adapterKey: NEWAPI_CHAT_ADAPTER_ID,
        protocolDefinitionId: NEWAPI_CHAT_PROTOCOL_ID,
        sourceDocumentRevision: NEWAPI_SOURCE_DOCUMENT_REVISION,
        features: features.map((feature) => feature === 'text_chat'
          ? {
            productFeature: 'text_chat',
            internalPurpose: 'text_execution',
            parameterSchemaId: NEWAPI_DEFAULT_TEXT_CHAT_PARAMETER_SCHEMA_ID,
            resultSchemaId: NEWAPI_CHAT_RESULT_SCHEMA_ID,
            usageSchemaId: NEWAPI_CHAT_USAGE_SCHEMA_ID,
            constraintSetId: NEWAPI_TEXT_CONSTRAINT_SET_ID
          }
          : {
            productFeature: 'text_reasoning',
            internalPurpose: 'text_execution',
            parameterSchemaId: NEWAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID,
            resultSchemaId: NEWAPI_CHAT_RESULT_SCHEMA_ID,
            usageSchemaId: NEWAPI_CHAT_USAGE_SCHEMA_ID,
            constraintSetId: NEWAPI_TEXT_CONSTRAINT_SET_ID
          })
      }
    ]
  };
}

/**
 * Exact Model Definition for OpenAI-compatible image bindings.
 * Explicit attach only — never inferred from catalog sync.
 * Endpoint: POST /v1/images/generations (URL or Base64 results).
 */
export function createOpenAiCompatibleDefaultImageDefinition(input: {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly providerModelKey: string;
}): ProviderModelDefinition {
  const providerModelKey = requireProviderModelKey(input.providerModelKey);
  if (
    input.packageId !== NEWAPI_PROVIDER_PACKAGE_ID &&
    input.packageId !== 'provider-package-unicompapi'
  ) {
    throw new TypeError('OpenAI-compatible image definitions require a known package id');
  }
  const suffix = createHash('sha256')
    .update(canonicalJson({
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      providerModelKey,
      feature: 'text_to_image'
    }))
    .digest('hex')
    .slice(0, 16);
  return {
    schemaVersion: 1,
    definitionId: `definition.openai-compatible.image.${suffix}`,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    providerModelKey,
    profileTemplates: [
      {
        templateId: `profile-template.openai-compatible.image.${suffix}`,
        adapterKey: NEWAPI_IMAGE_ADAPTER_ID,
        protocolDefinitionId: NEWAPI_IMAGE_PROTOCOL_ID,
        sourceDocumentRevision: NEWAPI_SOURCE_DOCUMENT_REVISION,
        features: [
          {
            productFeature: 'text_to_image',
            internalPurpose: 'image_generation',
            parameterSchemaId: NEWAPI_DEFAULT_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID,
            resultSchemaId: NEWAPI_IMAGE_RESULT_SCHEMA_ID,
            usageSchemaId: NEWAPI_IMAGE_USAGE_SCHEMA_ID,
            constraintSetId: NEWAPI_IMAGE_CONSTRAINT_SET_ID
          }
        ]
      }
    ]
  };
}

export function createOpenAiCompatibleDefaultImageEditDefinition(input: {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly providerModelKey: string;
}): ProviderModelDefinition {
  const providerModelKey = requireProviderModelKey(input.providerModelKey);
  if (
    input.packageId !== NEWAPI_PROVIDER_PACKAGE_ID &&
    input.packageId !== 'provider-package-unicompapi'
  ) {
    throw new TypeError('OpenAI-compatible image edit definitions require a known package id');
  }
  const suffix = createHash('sha256')
    .update(canonicalJson({
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      providerModelKey,
      feature: 'image_edit'
    }))
    .digest('hex')
    .slice(0, 16);
  return {
    schemaVersion: 1,
    definitionId: `definition.openai-compatible.image-edit.${suffix}`,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    providerModelKey,
    profileTemplates: [
      {
        templateId: `profile-template.openai-compatible.image-edit.${suffix}`,
        adapterKey: NEWAPI_IMAGE_ADAPTER_ID,
        protocolDefinitionId: NEWAPI_IMAGE_PROTOCOL_ID,
        sourceDocumentRevision: NEWAPI_SOURCE_DOCUMENT_REVISION,
        features: [
          {
            productFeature: 'image_edit',
            internalPurpose: 'image_editing',
            parameterSchemaId: NEWAPI_DEFAULT_IMAGE_EDIT_PARAMETER_SCHEMA_ID,
            resultSchemaId: NEWAPI_IMAGE_RESULT_SCHEMA_ID,
            usageSchemaId: NEWAPI_IMAGE_USAGE_SCHEMA_ID,
            constraintSetId: NEWAPI_IMAGE_EDIT_CONSTRAINT_SET_ID
          }
        ]
      }
    ]
  };
}

/**
 * Exact Model Definition for OpenAI-compatible video bindings.
 * Explicit attach only — never inferred from catalog sync.
 * Endpoint: POST /v1/videos (async) + GET /v1/videos/{id}.
 */
export function createOpenAiCompatibleDefaultVideoDefinition(input: {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly providerModelKey: string;
  readonly features?: readonly ('text_to_video' | 'image_to_video')[];
}): ProviderModelDefinition {
  const providerModelKey = requireProviderModelKey(input.providerModelKey);
  if (
    input.packageId !== NEWAPI_PROVIDER_PACKAGE_ID &&
    input.packageId !== 'provider-package-unicompapi'
  ) {
    throw new TypeError('OpenAI-compatible video definitions require a known package id');
  }
  const features = input.features ?? ['text_to_video', 'image_to_video'];
  if (
    features.length < 1 ||
    new Set(features).size !== features.length ||
    features.some((feature) => feature !== 'text_to_video' && feature !== 'image_to_video')
  ) {
    throw new TypeError('OpenAI-compatible video features are invalid');
  }
  const suffix = createHash('sha256')
    .update(canonicalJson({
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      providerModelKey,
      features
    }))
    .digest('hex')
    .slice(0, 16);
  return {
    schemaVersion: 1,
    definitionId: `definition.openai-compatible.video.${suffix}`,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    providerModelKey,
    profileTemplates: [
      {
        templateId: `profile-template.openai-compatible.video.${suffix}`,
        adapterKey: NEWAPI_VIDEO_ADAPTER_ID,
        protocolDefinitionId: NEWAPI_VIDEO_PROTOCOL_ID,
        sourceDocumentRevision: NEWAPI_SOURCE_DOCUMENT_REVISION,
        features: features.map((feature) => feature === 'text_to_video'
          ? {
            productFeature: 'text_to_video',
            internalPurpose: 'video_generation',
            parameterSchemaId: NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
            resultSchemaId: NEWAPI_VIDEO_RESULT_SCHEMA_ID,
            usageSchemaId: NEWAPI_VIDEO_USAGE_SCHEMA_ID,
            constraintSetId: NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID
          }
          : {
            productFeature: 'image_to_video',
            internalPurpose: 'reference_to_video',
            parameterSchemaId: NEWAPI_DEFAULT_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID,
            resultSchemaId: NEWAPI_VIDEO_RESULT_SCHEMA_ID,
            usageSchemaId: NEWAPI_VIDEO_USAGE_SCHEMA_ID,
            constraintSetId: NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID
          })
      }
    ]
  };
}

export const newApiImageUsageSchema: UsageSchemaV1 = createUsageSchema({
  id: toUsageSchemaId(NEWAPI_IMAGE_USAGE_SCHEMA_ID),
  revision: 1,
  completenessRule: 'provider_status_only',
  conflictPolicy: 'mark_invalid_response',
  metrics: [
    tokenMetric('input_tokens', false),
    tokenMetric('output_tokens', false),
    tokenMetric('total_tokens', false),
    tokenMetric('text_tokens', false),
    tokenMetric('image_tokens', false)
  ]
});

export const newApiVideoUsageSchema: UsageSchemaV1 = createUsageSchema({
  id: toUsageSchemaId(NEWAPI_VIDEO_USAGE_SCHEMA_ID),
  revision: 1,
  completenessRule: 'provider_status_only',
  conflictPolicy: 'mark_invalid_response',
  metrics: []
});

export const newApiProviderPackageDescriptor: ProviderPackageDescriptor = {
  packageId: NEWAPI_PROVIDER_PACKAGE_ID,
  packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
  displayName: 'OpenAI Compatible',
  credentialSchemas: [
    {
      schemaId: NEWAPI_CREDENTIAL_SCHEMA_ID,
      version: 1,
      fields: [
        {
          key: 'api_key',
          label: 'API key',
          secret: true,
          required: true,
          kind: 'token'
        }
      ]
    }
  ],
  endpointPolicies: [
    {
      policyId: NEWAPI_ENDPOINT_POLICY_ID,
      revision: 1,
      allowedSchemes: ['https', 'http'],
      allowedHosts: ['*'],
      allowedPorts: [],
      allowedPathPrefixes: ['/v1'],
      redirectPolicy: 'deny',
      proxyPolicy: 'system',
      allowLoopback: true,
      allowPrivateNetwork: false,
      allowLoopbackHttp: true,
      dnsRebindingProtection: 'required'
    }
  ],
  adapters: [
    {
      adapterId: NEWAPI_CHAT_ADAPTER_ID,
      adapterVersion: NEWAPI_ADAPTER_VERSION,
      protocolId: NEWAPI_CHAT_PROTOCOL_ID,
      protocolVersion: NEWAPI_PROTOCOL_VERSION,
      operations: ['validate_connection', 'discover_models', 'submit', 'cancel']
    },
    {
      adapterId: NEWAPI_IMAGE_ADAPTER_ID,
      adapterVersion: NEWAPI_ADAPTER_VERSION,
      protocolId: NEWAPI_IMAGE_PROTOCOL_ID,
      protocolVersion: NEWAPI_PROTOCOL_VERSION,
      operations: ['submit', 'receive_result']
    },
    {
      adapterId: NEWAPI_VIDEO_ADAPTER_ID,
      adapterVersion: NEWAPI_ADAPTER_VERSION,
      protocolId: NEWAPI_VIDEO_PROTOCOL_ID,
      protocolVersion: NEWAPI_PROTOCOL_VERSION,
      operations: ['submit', 'query', 'cancel', 'receive_result']
    }
  ],
  templates: [
    {
      templateId: NEWAPI_COMPATIBLE_TEMPLATE_ID,
      kind: 'compatible_custom',
      displayName: 'OpenAI Compatible Endpoint',
      baseUrlMode: 'required',
      credentialSchemaId: NEWAPI_CREDENTIAL_SCHEMA_ID,
      credentialSchemaVersion: 1,
      connectionPolicyId: 'connection.newapi.compatible',
      connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.newapi.models',
      discoveryPolicyRevision: 1,
      endpointPolicyId: NEWAPI_ENDPOINT_POLICY_ID,
      endpointPolicyRevision: 1,
      adapterBindings: [
        { adapterId: NEWAPI_CHAT_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION },
        { adapterId: NEWAPI_IMAGE_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION },
        { adapterId: NEWAPI_VIDEO_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION }
      ],
      freeConnectionValidation: true,
      modelDiscoveryKind: 'catalog'
    }
  ]
};

export function createNewApiModelContract(
  providerModelKey: string,
  declaration: NewApiModelProfileDeclarationV1
): NewApiModelContractV1 {
  const exactKey = requireProviderModelKey(providerModelKey);
  const normalized = normalizeDeclaration(declaration);
  if (Object.keys(normalized).length === 0) {
    throw new TypeError('NewAPI model declarations must publish at least one feature');
  }
  const contractHash = createHash('sha256')
    .update(canonicalJson({ providerModelKey: exactKey, declaration: normalized }))
    .digest('hex');
  const suffix = contractHash.slice(0, 16);
  const schemas: ParameterSchemaV2[] = [];
  const profileTemplates: ProviderModelDefinition['profileTemplates'][number][] = [];

  const addProfile = (
    adapterKey: string,
    protocolDefinitionId: string,
    features: readonly {
      readonly feature: ProductFeature;
      readonly declaration: NewApiTextFeatureDeclarationV1 |
        NewApiImageFeatureDeclarationV1 | NewApiVideoFeatureDeclarationV1;
    }[]
  ) => {
    if (features.length === 0) return;
    const mapped = features.map(({ feature, declaration: featureDeclaration }) => {
      const schema = parameterSchema(feature, suffix, featureDeclaration);
      schemas.push(schema);
      return {
        productFeature: feature,
        internalPurpose: internalPurpose(feature),
        parameterSchemaId: schema.schemaId,
        resultSchemaId: resultSchema(feature),
        usageSchemaId: usageSchema(feature),
        constraintSetId: constraintSet(feature)
      };
    });
    profileTemplates.push({
      templateId: `profile-template.newapi.${adapterKey}.${suffix}`,
      adapterKey,
      protocolDefinitionId,
      sourceDocumentRevision: NEWAPI_SOURCE_DOCUMENT_REVISION,
      features: mapped
    });
  };

  addProfile(NEWAPI_CHAT_ADAPTER_ID, NEWAPI_CHAT_PROTOCOL_ID, [
    ...(normalized.textChat
      ? [{ feature: 'text_chat' as const, declaration: normalized.textChat }]
      : []),
    ...(normalized.textReasoning
      ? [{ feature: 'text_reasoning' as const, declaration: normalized.textReasoning }]
      : [])
  ]);
  addProfile(NEWAPI_IMAGE_ADAPTER_ID, NEWAPI_IMAGE_PROTOCOL_ID,
    normalized.textToImage
      ? [{ feature: 'text_to_image', declaration: normalized.textToImage }]
      : []
  );
  addProfile(NEWAPI_VIDEO_ADAPTER_ID, NEWAPI_VIDEO_PROTOCOL_ID, [
    ...(normalized.textToVideo
      ? [{ feature: 'text_to_video' as const, declaration: normalized.textToVideo }]
      : []),
    ...(normalized.imageToVideo
      ? [{ feature: 'image_to_video' as const, declaration: normalized.imageToVideo }]
      : [])
  ]);

  return {
    contractHash,
    parameterSchemas: schemas,
    definition: {
      schemaVersion: 1,
      definitionId: `definition.newapi.${suffix}`,
      packageId: NEWAPI_PROVIDER_PACKAGE_ID,
      packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
      providerModelKey: exactKey,
      profileTemplates
    }
  };
}

export function createNewApiModelDefinition(
  providerModelKey: string,
  declaration: NewApiModelProfileDeclarationV1
): ProviderModelDefinition {
  return createNewApiModelContract(providerModelKey, declaration).definition;
}

function normalizeDeclaration(
  declaration: NewApiModelProfileDeclarationV1
): NewApiModelProfileDeclarationV1 {
  const item = exactObject(declaration, [
    'textChat', 'textReasoning', 'textToImage', 'textToVideo', 'imageToVideo'
  ], 'NewAPI model declaration');
  return {
    ...(item.textChat === undefined
      ? {} : { textChat: normalizeText(item.textChat, false) }),
    ...(item.textReasoning === undefined
      ? {} : { textReasoning: normalizeText(item.textReasoning, true) }),
    ...(item.textToImage === undefined
      ? {} : { textToImage: normalizeImage(item.textToImage) }),
    ...(item.textToVideo === undefined
      ? {} : { textToVideo: normalizeVideo(item.textToVideo) }),
    ...(item.imageToVideo === undefined
      ? {} : { imageToVideo: normalizeVideo(item.imageToVideo) })
  };
}

function normalizeText(value: unknown, reasoning: boolean): NewApiTextFeatureDeclarationV1 {
  const item = exactObject(value, [
    'maxTokens', 'temperature', 'topP', 'reasoningEfforts'
  ], 'NewAPI text feature declaration');
  if (!reasoning && item.reasoningEfforts !== undefined) {
    throw new TypeError('reasoningEfforts is only valid for text_reasoning');
  }
  return {
    ...(item.maxTokens === undefined ? {} : { maxTokens: numericRange(item.maxTokens) }),
    ...(item.temperature === undefined ? {} : { temperature: numericRange(item.temperature) }),
    ...(item.topP === undefined ? {} : { topP: numericRange(item.topP) }),
    ...(item.reasoningEfforts === undefined
      ? {} : { reasoningEfforts: stringOptions(item.reasoningEfforts, 'reasoning effort') })
  };
}

function normalizeImage(value: unknown): NewApiImageFeatureDeclarationV1 {
  const item = exactObject(value, [
    'sizes', 'qualities', 'styles', 'outputFormats'
  ], 'NewAPI image feature declaration');
  return {
    ...(item.sizes === undefined ? {} : { sizes: stringOptions(item.sizes, 'image size') }),
    ...(item.qualities === undefined ? {} : { qualities: stringOptions(item.qualities, 'image quality') }),
    ...(item.styles === undefined ? {} : { styles: stringOptions(item.styles, 'image style') }),
    ...(item.outputFormats === undefined
      ? {} : { outputFormats: stringOptions(item.outputFormats, 'image output format') })
  };
}

function normalizeVideo(value: unknown): NewApiVideoFeatureDeclarationV1 {
  const item = exactObject(value, [
    'durations', 'widths', 'heights', 'frameRates', 'supportsSeed'
  ], 'NewAPI video feature declaration');
  if (item.supportsSeed !== undefined && typeof item.supportsSeed !== 'boolean') {
    throw new TypeError('NewAPI supportsSeed declaration must be boolean');
  }
  return {
    ...(item.durations === undefined ? {} : { durations: numberOptions(item.durations, 'duration') }),
    ...(item.widths === undefined ? {} : { widths: numberOptions(item.widths, 'width') }),
    ...(item.heights === undefined ? {} : { heights: numberOptions(item.heights, 'height') }),
    ...(item.frameRates === undefined ? {} : { frameRates: numberOptions(item.frameRates, 'frame rate') }),
    ...(item.supportsSeed === undefined ? {} : { supportsSeed: item.supportsSeed })
  };
}

function parameterSchema(
  feature: ProductFeature,
  suffix: string,
  declaration: NewApiTextFeatureDeclarationV1 |
    NewApiImageFeatureDeclarationV1 | NewApiVideoFeatureDeclarationV1
): ParameterSchemaV2 {
  const fields: ParameterFieldSchemaV2[] = [];
  const add = (field: Omit<ParameterFieldSchemaV2, 'order'>) => {
    fields.push({ ...field, order: fields.length * 10 + 10 });
  };
  if (feature === 'text_chat' || feature === 'text_reasoning') {
    const text = declaration as NewApiTextFeatureDeclarationV1;
    if (text.maxTokens) add(numberField('max_tokens', 'integer', text.maxTokens, 'token'));
    if (text.temperature) add(numberField('temperature', 'number', text.temperature));
    if (text.topP) add(numberField('top_p', 'number', text.topP));
    if (text.reasoningEfforts) add(enumField('reasoning_effort', text.reasoningEfforts));
  } else if (feature === 'text_to_image') {
    const image = declaration as NewApiImageFeatureDeclarationV1;
    if (image.sizes) add(enumField('size', image.sizes));
    if (image.qualities) add(enumField('quality', image.qualities));
    if (image.styles) add(enumField('style', image.styles));
    if (image.outputFormats) add(enumField('output_format', image.outputFormats));
  } else {
    const video = declaration as NewApiVideoFeatureDeclarationV1;
    if (video.durations) add(enumField('duration', video.durations, 'second'));
    if (video.widths) add(enumField('width', video.widths, 'pixel'));
    if (video.heights) add(enumField('height', video.heights, 'pixel'));
    if (video.frameRates) add(enumField('fps', video.frameRates, 'frame_per_second'));
    if (video.supportsSeed) {
      add({
        fieldId: 'seed',
        labelId: 'provider.parameter.seed',
        groupId: 'provider.parameter.generation',
        valueType: 'integer',
        exposure: 'user_optional',
        defaultPolicy: 'omit_use_provider_default',
        required: false,
        minimum: 0
      });
    }
  }
  return {
    schemaVersion: 2,
    schemaId: `parameters.newapi.${feature}.${suffix}`,
    revision: 1,
    productFeature: feature,
    fields
  };
}

function numberField(
  fieldId: string,
  valueType: 'number' | 'integer',
  range: NewApiNumericRangeDeclarationV1,
  unitId?: string
): Omit<ParameterFieldSchemaV2, 'order'> {
  return {
    fieldId,
    labelId: `provider.parameter.${fieldId}`,
    groupId: 'provider.parameter.generation',
    valueType,
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false,
    minimum: range.minimum,
    maximum: range.maximum,
    unitId
  };
}

function enumField(
  fieldId: string,
  options: readonly (string | number)[],
  unitId?: string
): Omit<ParameterFieldSchemaV2, 'order'> {
  return {
    fieldId,
    labelId: `provider.parameter.${fieldId}`,
    groupId: 'provider.parameter.generation',
    valueType: 'enum',
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false,
    options,
    unitId
  };
}

function numericRange(value: unknown): NewApiNumericRangeDeclarationV1 {
  const item = exactObject(value, ['minimum', 'maximum'], 'NewAPI numeric range');
  const minimum = optionalFiniteNonNegative(item.minimum, 'minimum');
  const maximum = optionalFiniteNonNegative(item.maximum, 'maximum');
  if (minimum === undefined && maximum === undefined) {
    throw new TypeError('NewAPI numeric range must declare a bound');
  }
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new TypeError('NewAPI numeric range is inverted');
  }
  return { minimum, maximum };
}

function stringOptions(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new TypeError(`NewAPI ${label} options are invalid`);
  }
  const result = value.map((item) => {
    if (typeof item !== 'string' || item.length < 1 || item.length > 128 || /[\u0000-\u001f\u007f]/u.test(item)) {
      throw new TypeError(`NewAPI ${label} option is invalid`);
    }
    return item;
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError(`NewAPI ${label} options must be unique`);
  }
  return [...result].sort((left, right) => left.localeCompare(right));
}

function numberOptions(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new TypeError(`NewAPI ${label} options are invalid`);
  }
  const result = value.map((item) => {
    if (!Number.isSafeInteger(item) || Number(item) < 1) {
      throw new TypeError(`NewAPI ${label} option is invalid`);
    }
    return Number(item);
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError(`NewAPI ${label} options must be unique`);
  }
  return [...result].sort((left, right) => left - right);
}

function optionalFiniteNonNegative(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`NewAPI ${label} must be a finite non-negative number`);
  }
  return value;
}

function resultSchema(feature: ProductFeature): string {
  if (feature === 'text_chat' || feature === 'text_reasoning') return NEWAPI_CHAT_RESULT_SCHEMA_ID;
  if (feature === 'text_to_image') return NEWAPI_IMAGE_RESULT_SCHEMA_ID;
  return NEWAPI_VIDEO_RESULT_SCHEMA_ID;
}

function usageSchema(feature: ProductFeature): string {
  if (feature === 'text_chat' || feature === 'text_reasoning') return NEWAPI_CHAT_USAGE_SCHEMA_ID;
  if (feature === 'text_to_image') return NEWAPI_IMAGE_USAGE_SCHEMA_ID;
  return NEWAPI_VIDEO_USAGE_SCHEMA_ID;
}

function constraintSet(feature: ProductFeature): string {
  if (feature === 'text_chat' || feature === 'text_reasoning') return NEWAPI_TEXT_CONSTRAINT_SET_ID;
  if (feature === 'text_to_image') return NEWAPI_IMAGE_CONSTRAINT_SET_ID;
  return feature === 'text_to_video'
    ? NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID
    : NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID;
}

function internalPurpose(feature: ProductFeature): string {
  if (feature === 'text_chat' || feature === 'text_reasoning') return 'text_execution';
  if (feature === 'text_to_image') return 'image_generation';
  return feature === 'text_to_video' ? 'video_generation' : 'reference_to_video';
}

function tokenMetric(metricId: string, requiredForComplete: boolean) {
  return {
    metricId,
    allowedUnits: ['token'],
    numericKind: 'integer' as const,
    aggregation: 'final_authoritative' as const,
    requiredForComplete,
    allowedStages: ['result'] as const
  };
}

function requireProviderModelKey(value: unknown): string {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > 256 ||
    value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError('NewAPI provider model key is invalid');
  }
  return value;
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError(`${label} contains an unknown field`);
  }
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}
