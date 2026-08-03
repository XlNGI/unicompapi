import { createHash } from 'node:crypto';
import {
  createUsageSchema,
  toUsageSchemaId,
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
