import { createHash } from 'node:crypto';
import {
  createUsageSchema,
  toUsageSchemaId,
  type ParameterFieldSchemaV2,
  type ParameterSchemaV2,
  type ProviderModelDefinition,
  type ProviderPackageDescriptor,
  type UsageSchemaV1
} from '../../../domain';

export const VOLCENGINE_PROVIDER_PACKAGE_ID = 'provider-package-volcengine';
export const VOLCENGINE_PROVIDER_PACKAGE_VERSION = '1.0.0';
export const VOLCENGINE_OFFICIAL_TEMPLATE_ID = 'volcengine-ark-official';
export const VOLCENGINE_CREDENTIAL_SCHEMA_ID =
  'credential.volcengine.ark-api-key';
export const VOLCENGINE_ENDPOINT_POLICY_ID = 'endpoint.volcengine.ark-official';
export const VOLCENGINE_OFFICIAL_BASE_URL =
  'https://ark.cn-beijing.volces.com/api/v3';

export const DOUBAO_VISION_ADAPTER_ID = 'volcengine.doubao-vision';
export const DOUBAO_VISION_ADAPTER_VERSION = '2026-08-03';
export const DOUBAO_VISION_PROTOCOL_ID =
  'volcengine.ark.chat-completions-vision';
export const DOUBAO_VISION_PROTOCOL_VERSION = '2026-08-03';
export const DOUBAO_VISION_SOURCE_DOCUMENT_REVISION =
  'volcengine-ark-docs@2026-08-03';

export const SEEDANCE_VIDEO_ADAPTER_ID = 'volcengine.seedance-video';
export const SEEDANCE_VIDEO_ADAPTER_VERSION = '2026-08-03';
export const SEEDANCE_VIDEO_PROTOCOL_ID =
  'volcengine.ark.contents-generations-video';
export const SEEDANCE_VIDEO_PROTOCOL_VERSION = '2026-08-03';
export const SEEDANCE_VIDEO_SOURCE_DOCUMENT_REVISION =
  'volcengine-ark-video-docs@2026-08-03';
export const SEEDANCE_VIDEO_RESULT_SCHEMA_ID =
  'results.volcengine.seedance.video';
export const SEEDANCE_VIDEO_USAGE_SCHEMA_ID =
  'usage.volcengine.ark.video-generation';
export const SEEDANCE_TEXT_TO_VIDEO_CONSTRAINT_SET_ID =
  'constraints.volcengine.seedance.text-only';
export const SEEDANCE_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID =
  'constraints.volcengine.seedance.single-controlled-first-frame';

export const DOUBAO_IMAGE_UNDERSTANDING_PARAMETER_SCHEMA_ID =
  'parameters.volcengine.doubao.image-understanding';
export const DOUBAO_IMAGE_TO_PROMPT_PARAMETER_SCHEMA_ID =
  'parameters.volcengine.doubao.image-to-prompt';
export const DOUBAO_IMAGE_UNDERSTANDING_RESULT_SCHEMA_ID =
  'results.volcengine.doubao.image-observations';
export const DOUBAO_IMAGE_TO_PROMPT_RESULT_SCHEMA_ID =
  'results.volcengine.doubao.image-prompt-draft';
export const DOUBAO_VISION_USAGE_SCHEMA_ID =
  'usage.volcengine.ark.chat-completions';
export const DOUBAO_VISION_CONSTRAINT_SET_ID =
  'constraints.volcengine.doubao.single-controlled-image';

const visionParameterFields: ParameterSchemaV2['fields'] = [
  {
    fieldId: 'detail',
    labelId: 'provider.parameter.image_detail',
    groupId: 'provider.parameter.input',
    order: 10,
    valueType: 'enum',
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false,
    options: ['low', 'high', 'xhigh']
  },
  {
    fieldId: 'max_tokens',
    labelId: 'provider.parameter.max_tokens',
    groupId: 'provider.parameter.output',
    order: 20,
    valueType: 'integer',
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false,
    minimum: 1,
    unitId: 'token'
  },
  {
    fieldId: 'stream',
    labelId: 'provider.parameter.stream',
    order: 100,
    valueType: 'boolean',
    exposure: 'adapter_derived',
    defaultPolicy: 'derive_in_adapter',
    required: true
  },
  {
    fieldId: 'thinking',
    labelId: 'provider.parameter.thinking',
    order: 110,
    valueType: 'enum',
    exposure: 'adapter_derived',
    defaultPolicy: 'derive_in_adapter',
    required: true,
    options: ['disabled']
  },
  {
    fieldId: 'response_format',
    labelId: 'provider.parameter.response_format',
    order: 120,
    valueType: 'enum',
    exposure: 'adapter_derived',
    defaultPolicy: 'derive_in_adapter',
    required: true,
    options: ['unicomp_image_observations_v1']
  }
];

export const doubaoImageUnderstandingParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: DOUBAO_IMAGE_UNDERSTANDING_PARAMETER_SCHEMA_ID,
  revision: 1,
  productFeature: 'image_understanding',
  fields: visionParameterFields
};

export const doubaoImageToPromptParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: DOUBAO_IMAGE_TO_PROMPT_PARAMETER_SCHEMA_ID,
  revision: 1,
  productFeature: 'image_to_prompt',
  fields: visionParameterFields.map((field) => ({ ...field }))
};

export const doubaoVisionUsageSchema: UsageSchemaV1 = createUsageSchema({
  id: toUsageSchemaId(DOUBAO_VISION_USAGE_SCHEMA_ID),
  revision: 1,
  completenessRule: 'all_required_metrics',
  conflictPolicy: 'mark_invalid_response',
  metrics: [
    tokenMetric('completion_tokens', true),
    tokenMetric('prompt_tokens', true),
    tokenMetric('total_tokens', true),
    tokenMetric('cached_tokens', false),
    tokenMetric('reasoning_tokens', false)
  ]
});

export const seedanceVideoUsageSchema: UsageSchemaV1 = createUsageSchema({
  id: toUsageSchemaId(SEEDANCE_VIDEO_USAGE_SCHEMA_ID),
  revision: 1,
  completenessRule: 'all_required_metrics',
  conflictPolicy: 'mark_invalid_response',
  metrics: [
    videoUsageMetric('completion_tokens', 'token', true),
    videoUsageMetric('total_tokens', 'token', true),
    videoUsageMetric('web_search_calls', 'request', false)
  ]
});

export interface SeedanceSeedRangeDeclarationV1 {
  readonly minimum: number;
  readonly maximum: number;
}

export interface SeedanceVideoFeatureDeclarationV1 {
  readonly resolutions?: readonly string[];
  readonly ratios?: readonly string[];
  readonly durations?: readonly number[];
  readonly frames?: readonly number[];
  readonly seedRange?: SeedanceSeedRangeDeclarationV1;
  readonly supportsCameraFixed?: boolean;
  readonly supportsWatermark?: boolean;
  readonly supportsGenerateAudio?: boolean;
  readonly supportsReturnLastFrame?: boolean;
}

export interface SeedanceVideoProfileDeclarationV1 {
  readonly textToVideo?: SeedanceVideoFeatureDeclarationV1;
  readonly imageToVideo?: SeedanceVideoFeatureDeclarationV1;
}

export interface SeedanceVideoModelContractV1 {
  readonly definition: ProviderModelDefinition;
  readonly parameterSchemas: readonly ParameterSchemaV2[];
}

export const volcengineProviderPackageDescriptor: ProviderPackageDescriptor = {
  packageId: VOLCENGINE_PROVIDER_PACKAGE_ID,
  packageVersion: VOLCENGINE_PROVIDER_PACKAGE_VERSION,
  displayName: 'Volcengine Ark',
  credentialSchemas: [
    {
      schemaId: VOLCENGINE_CREDENTIAL_SCHEMA_ID,
      version: 1,
      fields: [
        {
          key: 'api_key',
          label: 'Ark API key',
          secret: true,
          required: true,
          kind: 'token'
        }
      ]
    }
  ],
  endpointPolicies: [
    {
      policyId: VOLCENGINE_ENDPOINT_POLICY_ID,
      revision: 1,
      allowedSchemes: ['https'],
      allowedHosts: ['ark.cn-beijing.volces.com'],
      allowedPorts: [443],
      allowedPathPrefixes: ['/api/v3'],
      redirectPolicy: 'deny',
      proxyPolicy: 'system',
      allowLoopback: false,
      allowPrivateNetwork: false,
      allowLoopbackHttp: false,
      dnsRebindingProtection: 'required',
      fixedBaseUrl: VOLCENGINE_OFFICIAL_BASE_URL
    }
  ],
  adapters: [
    {
      adapterId: DOUBAO_VISION_ADAPTER_ID,
      adapterVersion: DOUBAO_VISION_ADAPTER_VERSION,
      protocolId: DOUBAO_VISION_PROTOCOL_ID,
      protocolVersion: DOUBAO_VISION_PROTOCOL_VERSION,
      operations: ['submit', 'cancel']
    },
    {
      adapterId: SEEDANCE_VIDEO_ADAPTER_ID,
      adapterVersion: SEEDANCE_VIDEO_ADAPTER_VERSION,
      protocolId: SEEDANCE_VIDEO_PROTOCOL_ID,
      protocolVersion: SEEDANCE_VIDEO_PROTOCOL_VERSION,
      operations: ['submit', 'query', 'cancel', 'receive_result']
    }
  ],
  templates: [
    {
      templateId: VOLCENGINE_OFFICIAL_TEMPLATE_ID,
      kind: 'official',
      displayName: 'Volcengine Ark Official',
      baseUrlMode: 'fixed',
      credentialSchemaId: VOLCENGINE_CREDENTIAL_SCHEMA_ID,
      credentialSchemaVersion: 1,
      connectionPolicyId: 'connection.volcengine.ark.official',
      connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.volcengine.ark.manual-endpoint',
      discoveryPolicyRevision: 1,
      endpointPolicyId: VOLCENGINE_ENDPOINT_POLICY_ID,
      endpointPolicyRevision: 1,
      adapterBindings: [
        {
          adapterId: DOUBAO_VISION_ADAPTER_ID,
          adapterVersion: DOUBAO_VISION_ADAPTER_VERSION
        },
        {
          adapterId: SEEDANCE_VIDEO_ADAPTER_ID,
          adapterVersion: SEEDANCE_VIDEO_ADAPTER_VERSION
        }
      ],
      freeConnectionValidation: false,
      modelDiscoveryKind: 'manual_exact'
    }
  ]
};

export function createDoubaoVisionModelDefinition(
  providerModelKey: string
): ProviderModelDefinition {
  const exactKey = requireProviderModelKey(providerModelKey);
  const suffix = createHash('sha256').update(exactKey, 'utf8').digest('hex').slice(0, 20);
  return {
    schemaVersion: 1,
    definitionId: `definition.volcengine.doubao-vision.${suffix}`,
    packageId: VOLCENGINE_PROVIDER_PACKAGE_ID,
    packageVersion: VOLCENGINE_PROVIDER_PACKAGE_VERSION,
    providerModelKey: exactKey,
    profileTemplates: [
      {
        templateId: `profile-template.volcengine.doubao-vision.${suffix}`,
        adapterKey: DOUBAO_VISION_ADAPTER_ID,
        protocolDefinitionId: DOUBAO_VISION_PROTOCOL_ID,
        sourceDocumentRevision: DOUBAO_VISION_SOURCE_DOCUMENT_REVISION,
        features: [
          {
            productFeature: 'image_understanding',
            internalPurpose: 'image_understanding',
            parameterSchemaId: DOUBAO_IMAGE_UNDERSTANDING_PARAMETER_SCHEMA_ID,
            resultSchemaId: DOUBAO_IMAGE_UNDERSTANDING_RESULT_SCHEMA_ID,
            usageSchemaId: DOUBAO_VISION_USAGE_SCHEMA_ID,
            constraintSetId: DOUBAO_VISION_CONSTRAINT_SET_ID
          },
          {
            productFeature: 'image_to_prompt',
            internalPurpose: 'image_to_prompt',
            parameterSchemaId: DOUBAO_IMAGE_TO_PROMPT_PARAMETER_SCHEMA_ID,
            resultSchemaId: DOUBAO_IMAGE_TO_PROMPT_RESULT_SCHEMA_ID,
            usageSchemaId: DOUBAO_VISION_USAGE_SCHEMA_ID,
            constraintSetId: DOUBAO_VISION_CONSTRAINT_SET_ID
          }
        ]
      }
    ]
  };
}

export function createSeedanceVideoModelContract(
  providerModelKey: string,
  declaration: SeedanceVideoProfileDeclarationV1
): SeedanceVideoModelContractV1 {
  const exactKey = requireProviderModelKey(providerModelKey);
  const normalized = normalizeSeedanceDeclaration(declaration);
  if (!normalized.textToVideo && !normalized.imageToVideo) {
    throw new TypeError('Seedance Profile must declare at least one video feature');
  }
  const contractHash = createHash('sha256')
    .update(`${exactKey}\n${canonicalJson(normalized)}`, 'utf8')
    .digest('hex')
    .slice(0, 20);
  const parameterSchemas: ParameterSchemaV2[] = [];
  const features: ProviderModelDefinition['profileTemplates'][number]['features'][number][] = [];
  for (const [feature, featureDeclaration] of [
    ['text_to_video', normalized.textToVideo],
    ['image_to_video', normalized.imageToVideo]
  ] as const) {
    if (!featureDeclaration) continue;
    const parameterSchemaId =
      `parameters.volcengine.seedance.${feature}.${contractHash}`;
    parameterSchemas.push({
      schemaVersion: 2,
      schemaId: parameterSchemaId,
      revision: 1,
      productFeature: feature,
      fields: seedanceParameterFields(featureDeclaration)
    });
    features.push({
      productFeature: feature,
      internalPurpose: feature === 'text_to_video'
        ? 'video_generation'
        : 'reference_to_video',
      parameterSchemaId,
      resultSchemaId: SEEDANCE_VIDEO_RESULT_SCHEMA_ID,
      usageSchemaId: SEEDANCE_VIDEO_USAGE_SCHEMA_ID,
      constraintSetId: feature === 'text_to_video'
        ? SEEDANCE_TEXT_TO_VIDEO_CONSTRAINT_SET_ID
        : SEEDANCE_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID
    });
  }
  return {
    definition: {
      schemaVersion: 1,
      definitionId: `definition.volcengine.seedance-video.${contractHash}`,
      packageId: VOLCENGINE_PROVIDER_PACKAGE_ID,
      packageVersion: VOLCENGINE_PROVIDER_PACKAGE_VERSION,
      providerModelKey: exactKey,
      profileTemplates: [
        {
          templateId: `profile-template.volcengine.seedance-video.${contractHash}`,
          adapterKey: SEEDANCE_VIDEO_ADAPTER_ID,
          protocolDefinitionId: SEEDANCE_VIDEO_PROTOCOL_ID,
          sourceDocumentRevision: SEEDANCE_VIDEO_SOURCE_DOCUMENT_REVISION,
          features
        }
      ]
    },
    parameterSchemas
  };
}

export function createSeedanceVideoModelDefinition(
  providerModelKey: string,
  declaration: SeedanceVideoProfileDeclarationV1
): ProviderModelDefinition {
  return createSeedanceVideoModelContract(providerModelKey, declaration).definition;
}

function requireProviderModelKey(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 512 ||
    /[\u0000-\u001f\u007f\s]/u.test(normalized)
  ) {
    throw new TypeError('Volcengine Endpoint/Model ID is invalid');
  }
  return normalized;
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

function videoUsageMetric(
  metricId: string,
  unit: string,
  requiredForComplete: boolean
) {
  return {
    metricId,
    allowedUnits: [unit],
    numericKind: 'integer' as const,
    aggregation: 'final_authoritative' as const,
    requiredForComplete,
    allowedStages: ['poll', 'result'] as const
  };
}

function normalizeSeedanceDeclaration(
  declaration: SeedanceVideoProfileDeclarationV1
): SeedanceVideoProfileDeclarationV1 {
  if (!isPlainRecord(declaration as unknown)) {
    throw new TypeError('Seedance Profile declaration is invalid');
  }
  const keys = Object.keys(declaration);
  if (keys.some((key) => !['textToVideo', 'imageToVideo'].includes(key))) {
    throw new TypeError('Seedance Profile declaration contains unknown fields');
  }
  return {
    ...(declaration.textToVideo
      ? { textToVideo: normalizeSeedanceFeature(declaration.textToVideo) }
      : {}),
    ...(declaration.imageToVideo
      ? { imageToVideo: normalizeSeedanceFeature(declaration.imageToVideo) }
      : {})
  };
}

function normalizeSeedanceFeature(
  declaration: SeedanceVideoFeatureDeclarationV1
): SeedanceVideoFeatureDeclarationV1 {
  if (!isPlainRecord(declaration as unknown)) {
    throw new TypeError('Seedance feature declaration is invalid');
  }
  const allowed = new Set([
    'resolutions',
    'ratios',
    'durations',
    'frames',
    'seedRange',
    'supportsCameraFixed',
    'supportsWatermark',
    'supportsGenerateAudio',
    'supportsReturnLastFrame'
  ]);
  if (Object.keys(declaration).some((key) => !allowed.has(key))) {
    throw new TypeError('Seedance feature declaration contains unknown fields');
  }
  const resolutions = normalizeStringOptions(declaration.resolutions, 'resolution');
  const ratios = normalizeStringOptions(declaration.ratios, 'ratio');
  const durations = normalizeIntegerOptions(declaration.durations, 'duration');
  const frames = normalizeIntegerOptions(declaration.frames, 'frames');
  const seedRange = declaration.seedRange === undefined
    ? undefined
    : normalizeSeedRange(declaration.seedRange);
  return {
    ...(resolutions ? { resolutions } : {}),
    ...(ratios ? { ratios } : {}),
    ...(durations ? { durations } : {}),
    ...(frames ? { frames } : {}),
    ...(seedRange ? { seedRange } : {}),
    ...booleanDeclaration(declaration, 'supportsCameraFixed'),
    ...booleanDeclaration(declaration, 'supportsWatermark'),
    ...booleanDeclaration(declaration, 'supportsGenerateAudio'),
    ...booleanDeclaration(declaration, 'supportsReturnLastFrame')
  };
}

function seedanceParameterFields(
  declaration: SeedanceVideoFeatureDeclarationV1
): readonly ParameterFieldSchemaV2[] {
  const fields: ParameterFieldSchemaV2[] = [];
  let order = 10;
  const add = (field: Omit<ParameterFieldSchemaV2, 'order'>) => {
    fields.push({ ...field, order });
    order += 10;
  };
  if (declaration.resolutions) add(enumField('resolution', declaration.resolutions));
  if (declaration.ratios) add(enumField('ratio', declaration.ratios));
  if (declaration.durations) add(enumField('duration', declaration.durations, 'second'));
  if (declaration.frames) add(enumField('frames', declaration.frames, 'frame'));
  if (declaration.seedRange) {
    add({
      fieldId: 'seed',
      labelId: 'provider.parameter.seed',
      groupId: 'provider.parameter.generation',
      valueType: 'integer',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      minimum: declaration.seedRange.minimum,
      maximum: declaration.seedRange.maximum
    });
  }
  for (const [flag, fieldId] of [
    [declaration.supportsCameraFixed, 'camera_fixed'],
    [declaration.supportsWatermark, 'watermark'],
    [declaration.supportsGenerateAudio, 'generate_audio'],
    [declaration.supportsReturnLastFrame, 'return_last_frame']
  ] as const) {
    if (flag) add(booleanField(fieldId));
  }
  return fields;
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
    ...(unitId ? { unitId } : {})
  };
}

function booleanField(
  fieldId: string
): Omit<ParameterFieldSchemaV2, 'order'> {
  return {
    fieldId,
    labelId: `provider.parameter.${fieldId}`,
    groupId: 'provider.parameter.generation',
    valueType: 'boolean',
    exposure: 'user_optional',
    defaultPolicy: 'omit_use_provider_default',
    required: false
  };
}

function normalizeStringOptions(
  value: readonly string[] | undefined,
  label: string
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new TypeError(`Seedance ${label} options are invalid`);
  }
  const normalized = value.map((item) => {
    if (
      typeof item !== 'string' ||
      item.trim() !== item ||
      item.length < 1 ||
      item.length > 64 ||
      /[\u0000-\u001f\u007f]/u.test(item)
    ) {
      throw new TypeError(`Seedance ${label} option is invalid`);
    }
    return item;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`Seedance ${label} options must be unique`);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function normalizeIntegerOptions(
  value: readonly number[] | undefined,
  label: string
): readonly number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new TypeError(`Seedance ${label} options are invalid`);
  }
  const normalized = value.map((item) => {
    if (!Number.isSafeInteger(item) || item < 1) {
      throw new TypeError(`Seedance ${label} option is invalid`);
    }
    return item;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`Seedance ${label} options must be unique`);
  }
  return [...normalized].sort((left, right) => left - right);
}

function normalizeSeedRange(
  value: SeedanceSeedRangeDeclarationV1
): SeedanceSeedRangeDeclarationV1 {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => !['minimum', 'maximum'].includes(key)) ||
    !Number.isSafeInteger(value.minimum) ||
    !Number.isSafeInteger(value.maximum) ||
    value.minimum < 0 ||
    value.minimum > value.maximum
  ) {
    throw new TypeError('Seedance seed range is invalid');
  }
  return { minimum: value.minimum, maximum: value.maximum };
}

function booleanDeclaration<
  T extends keyof SeedanceVideoFeatureDeclarationV1
>(
  value: SeedanceVideoFeatureDeclarationV1,
  key: T
): Partial<SeedanceVideoFeatureDeclarationV1> {
  const flag = value[key];
  if (flag !== undefined && typeof flag !== 'boolean') {
    throw new TypeError(`Seedance ${String(key)} declaration is invalid`);
  }
  return flag === undefined ? {} : { [key]: flag };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
