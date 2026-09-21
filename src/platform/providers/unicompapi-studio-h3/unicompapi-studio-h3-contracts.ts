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

export const UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID =
  'provider-package-unicompapi-studio-h3';
export const UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_VERSION = '0.1.0-test';
export const UNICOMPAPI_STUDIO_H3_TEMPLATE_ID = 'unicompapi-studio-h3-test';
export const UNICOMPAPI_STUDIO_H3_CREDENTIAL_SCHEMA_ID =
  'credential.unicompapi-studio-h3.api-key';
export const UNICOMPAPI_STUDIO_H3_ENDPOINT_POLICY_ID =
  'endpoint.unicompapi-studio-h3.fixed';
export const UNICOMPAPI_STUDIO_H3_BASE_URL = 'https://unicompapi.com/studio/h3/v1';
export const UNICOMPAPI_STUDIO_H3_ALLOWED_HOSTS = ['unicompapi.com'] as const;
export const UNICOMPAPI_STUDIO_H3_PATH_PREFIX = '/studio/h3/v1';

export const UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID = 'unicompapi.studio-h3-video';
export const UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION = '2026-09-20-test';
export const UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID = 'unicompapi.studio.h3.videos';
export const UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION = '2026-09-20-test';
export const UNICOMPAPI_STUDIO_H3_VIDEO_SOURCE_DOCUMENT_REVISION =
  'unicompapi-studio-h3-live-probe@2026-09-20';
export const UNICOMPAPI_STUDIO_H3_VIDEO_RESULT_SCHEMA_ID =
  'results.unicompapi-studio-h3.video';
export const UNICOMPAPI_STUDIO_H3_VIDEO_USAGE_SCHEMA_ID =
  'usage.unicompapi-studio-h3.video';
export const UNICOMPAPI_STUDIO_H3_TEXT_TO_VIDEO_CONSTRAINT_SET_ID =
  'constraints.unicompapi-studio-h3.text-only';

export const UNICOMPAPI_STUDIO_H3_MODEL_KEY = 'minimax-h3';
export const UNICOMPAPI_STUDIO_H3_VARIANT = 'fl2va';
export const frozenUnicompapiStudioH3ModelKeys = [
  UNICOMPAPI_STUDIO_H3_MODEL_KEY
] as const;
export type FrozenUnicompapiStudioH3ModelKey =
  (typeof frozenUnicompapiStudioH3ModelKeys)[number];

export const UNICOMPAPI_STUDIO_H3_DURATIONS = [
  4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
] as const;
export const UNICOMPAPI_STUDIO_H3_ASPECT_RATIOS = [
  '16:9',
  '9:16',
  '21:9',
  '4:3',
  '1:1',
  '3:4'
] as const;
export const UNICOMPAPI_STUDIO_H3_GENERATION_MODES = [
  'base-lossless',
  'base-balanced',
  'base-fast'
] as const;

export const unicompapiStudioH3VideoUsageSchema: UsageSchemaV1 = createUsageSchema({
  id: toUsageSchemaId(UNICOMPAPI_STUDIO_H3_VIDEO_USAGE_SCHEMA_ID),
  revision: 1,
  completenessRule: 'all_required_metrics',
  conflictPolicy: 'mark_invalid_response',
  metrics: [
    {
      metricId: 'output_seconds',
      allowedUnits: ['second'],
      numericKind: 'integer',
      aggregation: 'final_authoritative',
      requiredForComplete: true,
      allowedStages: ['poll', 'result']
    }
  ]
});

export interface UnicompapiStudioH3VideoModelContractV1 {
  readonly definition: ProviderModelDefinition;
  readonly parameterSchemas: readonly ParameterSchemaV2[];
}

export const unicompapiStudioH3ProviderPackageDescriptor: ProviderPackageDescriptor = {
  packageId: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
  packageVersion: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_VERSION,
  displayName: 'UniCompAPI Studio H3 (测试)',
  credentialSchemas: [
    {
      schemaId: UNICOMPAPI_STUDIO_H3_CREDENTIAL_SCHEMA_ID,
      version: 1,
      fields: [
        {
          key: 'api_key',
          label: 'UniCompAPI Studio H3 API Key',
          secret: true,
          required: true,
          kind: 'token'
        }
      ]
    }
  ],
  endpointPolicies: [
    {
      policyId: UNICOMPAPI_STUDIO_H3_ENDPOINT_POLICY_ID,
      revision: 1,
      allowedSchemes: ['https'],
      allowedHosts: [...UNICOMPAPI_STUDIO_H3_ALLOWED_HOSTS],
      allowedPorts: [443],
      allowedPathPrefixes: [UNICOMPAPI_STUDIO_H3_PATH_PREFIX],
      redirectPolicy: 'deny',
      proxyPolicy: 'system',
      allowLoopback: false,
      allowPrivateNetwork: false,
      allowLoopbackHttp: false,
      dnsRebindingProtection: 'required',
      fixedBaseUrl: UNICOMPAPI_STUDIO_H3_BASE_URL
    }
  ],
  adapters: [
    {
      adapterId: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
      adapterVersion: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION,
      protocolId: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
      protocolVersion: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION,
      operations: ['validate_connection', 'submit', 'query', 'cancel', 'receive_result']
    }
  ],
  templates: [
    {
      templateId: UNICOMPAPI_STUDIO_H3_TEMPLATE_ID,
      kind: 'official',
      displayName: 'UniCompAPI Studio H3 (测试，可删除)',
      baseUrlMode: 'fixed',
      credentialSchemaId: UNICOMPAPI_STUDIO_H3_CREDENTIAL_SCHEMA_ID,
      credentialSchemaVersion: 1,
      connectionPolicyId: 'connection.unicompapi-studio-h3.test',
      connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.unicompapi-studio-h3.packaged-catalog',
      discoveryPolicyRevision: 1,
      endpointPolicyId: UNICOMPAPI_STUDIO_H3_ENDPOINT_POLICY_ID,
      endpointPolicyRevision: 1,
      adapterBindings: [
        {
          adapterId: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
          adapterVersion: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION
        }
      ],
      freeConnectionValidation: true,
      modelDiscoveryKind: 'manual_exact'
    }
  ]
};

export function createUnicompapiStudioH3VideoModelContract(
  providerModelKey: string
): UnicompapiStudioH3VideoModelContractV1 {
  if (providerModelKey !== UNICOMPAPI_STUDIO_H3_MODEL_KEY) {
    throw new TypeError('UniCompAPI Studio H3 exact model endpoint key is invalid');
  }
  const normalized = {
    durations: [...UNICOMPAPI_STUDIO_H3_DURATIONS],
    aspectRatios: [...UNICOMPAPI_STUDIO_H3_ASPECT_RATIOS],
    generationModes: [...UNICOMPAPI_STUDIO_H3_GENERATION_MODES]
  };
  const contractHash = createHash('sha256')
    .update(`${providerModelKey}\n${JSON.stringify(normalized)}`, 'utf8')
    .digest('hex')
    .slice(0, 20);
  const parameterSchemaId = `parameters.unicompapi-studio-h3.text_to_video.${contractHash}`;
  const parameterSchema: ParameterSchemaV2 = {
    schemaVersion: 2,
    schemaId: parameterSchemaId,
    revision: 1,
    productFeature: 'text_to_video',
    fields: parameterFields()
  };
  return {
    definition: {
      schemaVersion: 1,
      definitionId: `definition.unicompapi-studio-h3.video.${contractHash}`,
      packageId: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
      packageVersion: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_VERSION,
      providerModelKey,
      profileTemplates: [
        {
          templateId: `profile-template.unicompapi-studio-h3.video.${contractHash}`,
          adapterKey: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
          protocolDefinitionId: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
          sourceDocumentRevision: UNICOMPAPI_STUDIO_H3_VIDEO_SOURCE_DOCUMENT_REVISION,
          features: [
            {
              productFeature: 'text_to_video',
              internalPurpose: 'video_generation',
              parameterSchemaId,
              resultSchemaId: UNICOMPAPI_STUDIO_H3_VIDEO_RESULT_SCHEMA_ID,
              usageSchemaId: UNICOMPAPI_STUDIO_H3_VIDEO_USAGE_SCHEMA_ID,
              constraintSetId: UNICOMPAPI_STUDIO_H3_TEXT_TO_VIDEO_CONSTRAINT_SET_ID
            }
          ]
        }
      ]
    },
    parameterSchemas: [parameterSchema]
  };
}

export const unicompapiStudioH3PackagedModelContracts:
  readonly UnicompapiStudioH3VideoModelContractV1[] =
  frozenUnicompapiStudioH3ModelKeys.map(createUnicompapiStudioH3VideoModelContract);

export function isUnicompapiStudioH3OfficialTemplate(templateId: string): boolean {
  return templateId === UNICOMPAPI_STUDIO_H3_TEMPLATE_ID;
}

export function isUnicompapiStudioH3EndpointPolicy(policyId: string): boolean {
  return policyId === UNICOMPAPI_STUDIO_H3_ENDPOINT_POLICY_ID;
}

function parameterFields(): readonly ParameterFieldSchemaV2[] {
  return [
    requiredEnumField('generation_mode', [...UNICOMPAPI_STUDIO_H3_GENERATION_MODES], 10),
    requiredEnumField('duration', [...UNICOMPAPI_STUDIO_H3_DURATIONS], 20, 'second'),
    requiredEnumField('aspect_ratio', [...UNICOMPAPI_STUDIO_H3_ASPECT_RATIOS], 30)
  ];
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
