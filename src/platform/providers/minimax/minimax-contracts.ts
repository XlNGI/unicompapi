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

export const MINIMAX_H3_PROVIDER_PACKAGE_ID = 'provider-package-minimax-h3';
export const MINIMAX_H3_PROVIDER_PACKAGE_VERSION = '1.0.0';
export const MINIMAX_H3_CN_TEMPLATE_ID = 'minimax-h3-official-cn';
export const MINIMAX_H3_GLOBAL_TEMPLATE_ID = 'minimax-h3-official-global';
export const MINIMAX_H3_CREDENTIAL_SCHEMA_ID = 'credential.minimax-h3.api-key';
export const MINIMAX_H3_CN_ENDPOINT_POLICY_ID = 'endpoint.minimax-h3.official-cn';
export const MINIMAX_H3_GLOBAL_ENDPOINT_POLICY_ID =
  'endpoint.minimax-h3.official-global';
export const MINIMAX_H3_CN_BASE_URL = 'https://api.minimaxi.com';
export const MINIMAX_H3_GLOBAL_BASE_URL = 'https://api.minimax.io';
export const MINIMAX_H3_ALLOWED_HOSTS = [
  'api.minimaxi.com',
  'api.minimax.io'
] as const;

export const MINIMAX_H3_VIDEO_ADAPTER_ID = 'minimax.h3-video';
export const MINIMAX_H3_VIDEO_ADAPTER_VERSION = '2026-09-20';
export const MINIMAX_H3_VIDEO_PROTOCOL_ID = 'minimax.api.v2.video-generation';
export const MINIMAX_H3_VIDEO_PROTOCOL_VERSION = '2026-09-20';
export const MINIMAX_H3_VIDEO_SOURCE_DOCUMENT_REVISION =
  'minimax-h3-video-docs@2026-09-20';
export const MINIMAX_H3_VIDEO_RESULT_SCHEMA_ID = 'results.minimax-h3.video';
export const MINIMAX_H3_VIDEO_USAGE_SCHEMA_ID = 'usage.minimax-h3.video';
export const MINIMAX_H3_TEXT_TO_VIDEO_CONSTRAINT_SET_ID =
  'constraints.minimax-h3.text-only';
export const MINIMAX_H3_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID =
  'constraints.minimax-h3.single-controlled-first-frame';

export const frozenMiniMaxH3ModelKeys = [
  'MiniMax-H3',
  'MiniMax-H3-Max'
] as const;
export type FrozenMiniMaxH3ModelKey = (typeof frozenMiniMaxH3ModelKeys)[number];

export const MINIMAX_H3_ASPECT_RATIOS = [
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16'
] as const;

export const minimaxH3VideoUsageSchema: UsageSchemaV1 = createUsageSchema({
  id: toUsageSchemaId(MINIMAX_H3_VIDEO_USAGE_SCHEMA_ID),
  revision: 1,
  completenessRule: 'all_required_metrics',
  conflictPolicy: 'mark_invalid_response',
  metrics: [
    usageMetric('output_seconds', 'second', 'integer', true),
    usageMetric('input_seconds', 'second', 'integer', false),
    usageMetric('total_seconds', 'second', 'integer', false),
    usageMetric('input_image_count', 'count', 'integer', false),
    usageMetric('prompt_tokens', 'token', 'integer', false),
    usageMetric('completion_tokens', 'token', 'integer', false),
    usageMetric('total_tokens', 'token', 'integer', false)
  ]
});

export interface MiniMaxVideoModelContractV1 {
  readonly definition: ProviderModelDefinition;
  readonly parameterSchemas: readonly ParameterSchemaV2[];
}

const frozenDeclarations: Record<
  FrozenMiniMaxH3ModelKey,
  {
    readonly resolutions: readonly string[];
    readonly durations: readonly number[];
  }
> = {
  'MiniMax-H3': {
    resolutions: ['768P', '2K'],
    durations: inclusiveRange(4, 15)
  },
  'MiniMax-H3-Max': {
    resolutions: ['480P', '768P'],
    durations: inclusiveRange(5, 15)
  }
};

export const minimaxH3ProviderPackageDescriptor: ProviderPackageDescriptor = {
  packageId: MINIMAX_H3_PROVIDER_PACKAGE_ID,
  packageVersion: MINIMAX_H3_PROVIDER_PACKAGE_VERSION,
  displayName: 'MiniMax',
  credentialSchemas: [
    {
      schemaId: MINIMAX_H3_CREDENTIAL_SCHEMA_ID,
      version: 1,
      fields: [
        {
          key: 'api_key',
          label: 'MiniMax API Key',
          secret: true,
          required: true,
          kind: 'token'
        }
      ]
    }
  ],
  endpointPolicies: [
    officialEndpointPolicy(
      MINIMAX_H3_CN_ENDPOINT_POLICY_ID,
      'api.minimaxi.com',
      MINIMAX_H3_CN_BASE_URL
    ),
    officialEndpointPolicy(
      MINIMAX_H3_GLOBAL_ENDPOINT_POLICY_ID,
      'api.minimax.io',
      MINIMAX_H3_GLOBAL_BASE_URL
    )
  ],
  adapters: [
    {
      adapterId: MINIMAX_H3_VIDEO_ADAPTER_ID,
      adapterVersion: MINIMAX_H3_VIDEO_ADAPTER_VERSION,
      protocolId: MINIMAX_H3_VIDEO_PROTOCOL_ID,
      protocolVersion: MINIMAX_H3_VIDEO_PROTOCOL_VERSION,
      operations: ['validate_connection', 'submit', 'query', 'cancel', 'receive_result']
    }
  ],
  templates: [
    officialTemplate(
      MINIMAX_H3_CN_TEMPLATE_ID,
      'MiniMax H3 Official (China)',
      'connection.minimax-h3.official-cn',
      MINIMAX_H3_CN_ENDPOINT_POLICY_ID
    ),
    officialTemplate(
      MINIMAX_H3_GLOBAL_TEMPLATE_ID,
      'MiniMax H3 Official (Global)',
      'connection.minimax-h3.official-global',
      MINIMAX_H3_GLOBAL_ENDPOINT_POLICY_ID
    )
  ]
};

export function createMiniMaxVideoModelContract(
  providerModelKey: string
): MiniMaxVideoModelContractV1 {
  const exactKey = requireFrozenModelKey(providerModelKey);
  const declaration = frozenDeclarations[exactKey];
  const normalized = {
    resolutions: normalizeStringOptions(declaration.resolutions, 'resolution'),
    durations: normalizeIntegerOptions(declaration.durations, 'duration'),
    aspectRatios: normalizeStringOptions(MINIMAX_H3_ASPECT_RATIOS, 'aspect ratio')
  };
  const contractHash = createHash('sha256')
    .update(`${exactKey}\n${canonicalJson(normalized)}`, 'utf8')
    .digest('hex')
    .slice(0, 20);
  const parameterSchemas: ParameterSchemaV2[] = [];
  const features: ProviderModelDefinition['profileTemplates'][number]['features'][number][] = [];
  for (const feature of ['text_to_video', 'image_to_video'] as const) {
    const parameterSchemaId = `parameters.minimax-h3.${feature}.${contractHash}`;
    parameterSchemas.push({
      schemaVersion: 2,
      schemaId: parameterSchemaId,
      revision: 1,
      productFeature: feature,
      fields: parameterFields(normalized, feature)
    });
    features.push({
      productFeature: feature,
      internalPurpose: feature === 'text_to_video'
        ? 'video_generation'
        : 'reference_to_video',
      parameterSchemaId,
      resultSchemaId: MINIMAX_H3_VIDEO_RESULT_SCHEMA_ID,
      usageSchemaId: MINIMAX_H3_VIDEO_USAGE_SCHEMA_ID,
      constraintSetId: feature === 'text_to_video'
        ? MINIMAX_H3_TEXT_TO_VIDEO_CONSTRAINT_SET_ID
        : MINIMAX_H3_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID
    });
  }
  return {
    definition: {
      schemaVersion: 1,
      definitionId: `definition.minimax-h3.video.${contractHash}`,
      packageId: MINIMAX_H3_PROVIDER_PACKAGE_ID,
      packageVersion: MINIMAX_H3_PROVIDER_PACKAGE_VERSION,
      providerModelKey: exactKey,
      profileTemplates: [
        {
          templateId: `profile-template.minimax-h3.video.${contractHash}`,
          adapterKey: MINIMAX_H3_VIDEO_ADAPTER_ID,
          protocolDefinitionId: MINIMAX_H3_VIDEO_PROTOCOL_ID,
          sourceDocumentRevision: MINIMAX_H3_VIDEO_SOURCE_DOCUMENT_REVISION,
          features
        }
      ]
    },
    parameterSchemas
  };
}

export const minimaxH3PackagedModelContracts: readonly MiniMaxVideoModelContractV1[] =
  frozenMiniMaxH3ModelKeys.map(createMiniMaxVideoModelContract);

export const minimaxH3PackagedParameterSchemas: readonly ParameterSchemaV2[] =
  minimaxH3PackagedModelContracts.flatMap((contract) => contract.parameterSchemas);

export function isMiniMaxH3OfficialTemplate(templateId: string): boolean {
  return (
    templateId === MINIMAX_H3_CN_TEMPLATE_ID ||
    templateId === MINIMAX_H3_GLOBAL_TEMPLATE_ID
  );
}

export function isMiniMaxH3EndpointPolicy(policyId: string): boolean {
  return (
    policyId === MINIMAX_H3_CN_ENDPOINT_POLICY_ID ||
    policyId === MINIMAX_H3_GLOBAL_ENDPOINT_POLICY_ID
  );
}

export function hostForMiniMaxH3EndpointPolicy(policyId: string): string | undefined {
  if (policyId === MINIMAX_H3_CN_ENDPOINT_POLICY_ID) return 'api.minimaxi.com';
  if (policyId === MINIMAX_H3_GLOBAL_ENDPOINT_POLICY_ID) return 'api.minimax.io';
  return undefined;
}

function officialEndpointPolicy(
  policyId: string,
  host: string,
  fixedBaseUrl: string
) {
  return {
    policyId,
    revision: 1,
    allowedSchemes: ['https'] as const,
    allowedHosts: [host],
    allowedPorts: [443],
    allowedPathPrefixes: ['/'],
    redirectPolicy: 'deny' as const,
    proxyPolicy: 'system' as const,
    allowLoopback: false,
    allowPrivateNetwork: false,
    allowLoopbackHttp: false,
    dnsRebindingProtection: 'required' as const,
    fixedBaseUrl
  };
}

function officialTemplate(
  templateId: string,
  displayName: string,
  connectionPolicyId: string,
  endpointPolicyId: string
) {
  return {
    templateId,
    kind: 'official' as const,
    displayName,
    baseUrlMode: 'fixed' as const,
    credentialSchemaId: MINIMAX_H3_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    connectionPolicyId,
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.minimax-h3.packaged-catalog',
    discoveryPolicyRevision: 1,
    endpointPolicyId,
    endpointPolicyRevision: 1,
    adapterBindings: [
      {
        adapterId: MINIMAX_H3_VIDEO_ADAPTER_ID,
        adapterVersion: MINIMAX_H3_VIDEO_ADAPTER_VERSION
      }
    ],
    freeConnectionValidation: true,
    modelDiscoveryKind: 'manual_exact' as const
  };
}

function parameterFields(
  declaration: {
    readonly resolutions: readonly string[];
    readonly durations: readonly number[];
    readonly aspectRatios: readonly string[];
  },
  feature: 'text_to_video' | 'image_to_video'
): readonly ParameterFieldSchemaV2[] {
  const fields: ParameterFieldSchemaV2[] = [
    requiredEnumField('resolution', declaration.resolutions, 10),
    requiredEnumField('duration', declaration.durations, 20, 'second')
  ];
  if (feature === 'text_to_video') {
    fields.push(requiredEnumField('aspect_ratio', declaration.aspectRatios, 30));
  }
  return fields;
}

function requiredEnumField(
  fieldId: string,
  options: readonly (string | number)[],
  order: number,
  unitId?: string
): ParameterFieldSchemaV2 {
  return {
    fieldId,
    labelId: `provider.parameter.${fieldId}`,
    groupId: 'provider.parameter.generation',
    order,
    valueType: 'enum',
    exposure: 'user_required',
    defaultPolicy: 'require_user_value',
    required: true,
    options: [...options],
    ...(unitId ? { unitId } : {})
  };
}

function requireFrozenModelKey(value: string): FrozenMiniMaxH3ModelKey {
  if ((frozenMiniMaxH3ModelKeys as readonly string[]).includes(value)) {
    return value as FrozenMiniMaxH3ModelKey;
  }
  throw new TypeError('MiniMax H3 exact model endpoint key is invalid');
}

function normalizeStringOptions(
  value: readonly string[],
  label: string
): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new TypeError(`MiniMax ${label} options are invalid`);
  }
  const normalized = value.map((item) => {
    if (
      typeof item !== 'string' ||
      item.trim() !== item ||
      item.length < 1 ||
      item.length > 64 ||
      /[\u0000-\u001f\u007f]/u.test(item)
    ) {
      throw new TypeError(`MiniMax ${label} option is invalid`);
    }
    return item;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`MiniMax ${label} options must be unique`);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function normalizeIntegerOptions(
  value: readonly number[],
  label: string
): readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new TypeError(`MiniMax ${label} options are invalid`);
  }
  const normalized = value.map((item) => {
    if (!Number.isSafeInteger(item) || item < 1) {
      throw new TypeError(`MiniMax ${label} option is invalid`);
    }
    return item;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`MiniMax ${label} options must be unique`);
  }
  return [...normalized].sort((left, right) => left - right);
}

function inclusiveRange(minimum: number, maximum: number): readonly number[] {
  const values: number[] = [];
  for (let value = minimum; value <= maximum; value += 1) values.push(value);
  return values;
}

function usageMetric(
  metricId: string,
  unit: string,
  numericKind: 'integer' | 'decimal',
  requiredForComplete: boolean
) {
  return {
    metricId,
    allowedUnits: [unit],
    numericKind,
    aggregation: 'final_authoritative' as const,
    requiredForComplete,
    allowedStages: ['poll', 'result'] as const
  };
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
