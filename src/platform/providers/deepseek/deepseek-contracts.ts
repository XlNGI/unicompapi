import {
  createUsageSchema,
  toUsageSchemaId,
  type ParameterSchemaV2,
  type ProviderModelDefinition,
  type ProviderPackageDescriptor,
  type UsageSchemaV1
} from '../../../domain';

export const DEEPSEEK_PROVIDER_PACKAGE_ID = 'provider-package-deepseek';
export const DEEPSEEK_PROVIDER_PACKAGE_VERSION = '1.0.0';
export const DEEPSEEK_OFFICIAL_TEMPLATE_ID = 'deepseek-official';
export const DEEPSEEK_CREDENTIAL_SCHEMA_ID = 'credential.deepseek.api-key';
export const DEEPSEEK_ENDPOINT_POLICY_ID = 'endpoint.deepseek.official';
export const DEEPSEEK_CHAT_ADAPTER_ID = 'deepseek.chat';
export const DEEPSEEK_CHAT_ADAPTER_VERSION = '2026-08-03';
export const DEEPSEEK_CHAT_PROTOCOL_ID = 'deepseek.chat-completions';
export const DEEPSEEK_CHAT_PROTOCOL_VERSION = '2026-08-03';
export const DEEPSEEK_OFFICIAL_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_SOURCE_DOCUMENT_REVISION =
  'deepseek-api-docs@2026-08-03';

export const DEEPSEEK_MODEL_KEYS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro'
] as const;
export type DeepSeekModelKey = (typeof DEEPSEEK_MODEL_KEYS)[number];

export const DEEPSEEK_CHAT_PARAMETER_SCHEMA_ID =
  'parameters.deepseek.chat';
export const DEEPSEEK_REASONING_PARAMETER_SCHEMA_ID =
  'parameters.deepseek.reasoning';
export const DEEPSEEK_RESULT_SCHEMA_ID = 'results.deepseek.chat';
export const DEEPSEEK_USAGE_SCHEMA_ID = 'usage.deepseek.chat-completions';
export const DEEPSEEK_CONSTRAINT_SET_ID = 'constraints.deepseek.text';

export const deepSeekChatParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: DEEPSEEK_CHAT_PARAMETER_SCHEMA_ID,
  revision: 1,
  productFeature: 'text_chat',
  fields: [
    {
      fieldId: 'max_tokens',
      labelId: 'provider.parameter.max_tokens',
      groupId: 'provider.parameter.output',
      order: 10,
      valueType: 'integer',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      minimum: 1,
      unitId: 'token'
    },
    {
      fieldId: 'temperature',
      labelId: 'provider.parameter.temperature',
      groupId: 'provider.parameter.sampling',
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
      groupId: 'provider.parameter.sampling',
      order: 30,
      valueType: 'number',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      minimum: 0,
      maximum: 1
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
      fieldId: 'include_usage',
      labelId: 'provider.parameter.include_usage',
      order: 110,
      valueType: 'boolean',
      exposure: 'adapter_derived',
      defaultPolicy: 'derive_in_adapter',
      required: true
    },
    {
      fieldId: 'thinking',
      labelId: 'provider.parameter.thinking',
      order: 120,
      valueType: 'enum',
      exposure: 'adapter_derived',
      defaultPolicy: 'derive_in_adapter',
      required: true,
      options: ['disabled']
    }
  ]
};

export const deepSeekReasoningParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: DEEPSEEK_REASONING_PARAMETER_SCHEMA_ID,
  revision: 1,
  productFeature: 'text_reasoning',
  fields: [
    {
      fieldId: 'max_tokens',
      labelId: 'provider.parameter.max_tokens',
      groupId: 'provider.parameter.output',
      order: 10,
      valueType: 'integer',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      minimum: 1,
      unitId: 'token'
    },
    {
      fieldId: 'reasoning_effort',
      labelId: 'provider.parameter.reasoning_effort',
      groupId: 'provider.parameter.reasoning',
      order: 20,
      valueType: 'enum',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      options: ['low', 'high', 'max']
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
      fieldId: 'include_usage',
      labelId: 'provider.parameter.include_usage',
      order: 110,
      valueType: 'boolean',
      exposure: 'adapter_derived',
      defaultPolicy: 'derive_in_adapter',
      required: true
    },
    {
      fieldId: 'thinking',
      labelId: 'provider.parameter.thinking',
      order: 120,
      valueType: 'enum',
      exposure: 'adapter_derived',
      defaultPolicy: 'derive_in_adapter',
      required: true,
      options: ['enabled']
    }
  ]
};

export const deepSeekUsageSchema: UsageSchemaV1 = createUsageSchema({
  id: toUsageSchemaId(DEEPSEEK_USAGE_SCHEMA_ID),
  revision: 1,
  completenessRule: 'all_required_metrics',
  conflictPolicy: 'mark_invalid_response',
  metrics: [
    usageMetric('completion_tokens', true),
    usageMetric('prompt_tokens', true),
    usageMetric('total_tokens', true),
    usageMetric('prompt_cache_hit_tokens', false),
    usageMetric('prompt_cache_miss_tokens', false),
    usageMetric('reasoning_tokens', false)
  ]
});

export const deepSeekProviderPackageDescriptor: ProviderPackageDescriptor = {
  packageId: DEEPSEEK_PROVIDER_PACKAGE_ID,
  packageVersion: DEEPSEEK_PROVIDER_PACKAGE_VERSION,
  displayName: 'DeepSeek',
  credentialSchemas: [
    {
      schemaId: DEEPSEEK_CREDENTIAL_SCHEMA_ID,
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
      policyId: DEEPSEEK_ENDPOINT_POLICY_ID,
      revision: 1,
      allowedSchemes: ['https'],
      allowedHosts: ['api.deepseek.com'],
      allowedPorts: [443],
      allowedPathPrefixes: ['/'],
      redirectPolicy: 'deny',
      proxyPolicy: 'system',
      allowLoopback: false,
      allowPrivateNetwork: false,
      allowLoopbackHttp: false,
      dnsRebindingProtection: 'required',
      fixedBaseUrl: DEEPSEEK_OFFICIAL_BASE_URL
    }
  ],
  adapters: [
    {
      adapterId: DEEPSEEK_CHAT_ADAPTER_ID,
      adapterVersion: DEEPSEEK_CHAT_ADAPTER_VERSION,
      protocolId: DEEPSEEK_CHAT_PROTOCOL_ID,
      protocolVersion: DEEPSEEK_CHAT_PROTOCOL_VERSION,
      operations: ['validate_connection', 'discover_models', 'submit', 'cancel']
    }
  ],
  templates: [
    {
      templateId: DEEPSEEK_OFFICIAL_TEMPLATE_ID,
      kind: 'official',
      displayName: 'DeepSeek Official',
      baseUrlMode: 'fixed',
      credentialSchemaId: DEEPSEEK_CREDENTIAL_SCHEMA_ID,
      credentialSchemaVersion: 1,
      connectionPolicyId: 'connection.deepseek.official',
      connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.deepseek.models',
      discoveryPolicyRevision: 1,
      endpointPolicyId: DEEPSEEK_ENDPOINT_POLICY_ID,
      endpointPolicyRevision: 1,
      adapterBindings: [
        {
          adapterId: DEEPSEEK_CHAT_ADAPTER_ID,
          adapterVersion: DEEPSEEK_CHAT_ADAPTER_VERSION
        }
      ],
      freeConnectionValidation: true,
      modelDiscoveryKind: 'catalog'
    }
  ]
};

export const deepSeekModelDefinitions: readonly ProviderModelDefinition[] =
  DEEPSEEK_MODEL_KEYS.map((providerModelKey) => ({
    schemaVersion: 1,
    definitionId: `definition.deepseek.${providerModelKey}`,
    packageId: DEEPSEEK_PROVIDER_PACKAGE_ID,
    packageVersion: DEEPSEEK_PROVIDER_PACKAGE_VERSION,
    providerModelKey,
    profileTemplates: [
      {
        templateId: `profile-template.deepseek.${providerModelKey}`,
        adapterKey: DEEPSEEK_CHAT_ADAPTER_ID,
        protocolDefinitionId: DEEPSEEK_CHAT_PROTOCOL_ID,
        sourceDocumentRevision: DEEPSEEK_SOURCE_DOCUMENT_REVISION,
        features: [
          {
            productFeature: 'text_chat',
            internalPurpose: 'text_execution',
            parameterSchemaId: DEEPSEEK_CHAT_PARAMETER_SCHEMA_ID,
            resultSchemaId: DEEPSEEK_RESULT_SCHEMA_ID,
            usageSchemaId: DEEPSEEK_USAGE_SCHEMA_ID,
            constraintSetId: DEEPSEEK_CONSTRAINT_SET_ID
          },
          {
            productFeature: 'text_reasoning',
            internalPurpose: 'text_execution',
            parameterSchemaId: DEEPSEEK_REASONING_PARAMETER_SCHEMA_ID,
            resultSchemaId: DEEPSEEK_RESULT_SCHEMA_ID,
            usageSchemaId: DEEPSEEK_USAGE_SCHEMA_ID,
            constraintSetId: DEEPSEEK_CONSTRAINT_SET_ID
          }
        ]
      }
    ]
  }));

export function isDeepSeekModelKey(value: unknown): value is DeepSeekModelKey {
  return DEEPSEEK_MODEL_KEYS.includes(value as DeepSeekModelKey);
}

function usageMetric(metricId: string, requiredForComplete: boolean) {
  return {
    metricId,
    allowedUnits: ['token'],
    numericKind: 'integer' as const,
    aggregation: 'final_authoritative' as const,
    requiredForComplete,
    allowedStages: ['result'] as const
  };
}
