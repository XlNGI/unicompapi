import { type ParameterFieldSchemaV2, type ParameterSchemaV2, type ProviderPackageDescriptor } from '../../../domain';
import {
  NEWAPI_ADAPTER_VERSION,
  NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_CHAT_PROTOCOL_ID,
  NEWAPI_PROTOCOL_VERSION,
  NEWAPI_CHAT_RESULT_SCHEMA_ID,
  NEWAPI_TEXT_CONSTRAINT_SET_ID,
  newApiChatUsageSchema
} from '../newapi/newapi-contracts';

export const KIMI_PROVIDER_PACKAGE_ID = 'provider-package-kimi';
export const KIMI_PROVIDER_PACKAGE_VERSION = '1.0.0';
export const KIMI_OFFICIAL_TEMPLATE_ID = 'kimi-official';
export const KIMI_CREDENTIAL_SCHEMA_ID = 'credential.kimi.api-key';
export const KIMI_ENDPOINT_POLICY_ID = 'endpoint.kimi.official';
export const KIMI_OFFICIAL_BASE_URL = 'https://api.moonshot.cn/v1';
export const KIMI_K3_TEXT_CHAT_PARAMETER_SCHEMA_ID = 'parameters.kimi.k3.text_chat';
export const KIMI_K3_TEXT_REASONING_PARAMETER_SCHEMA_ID = 'parameters.kimi.k3.text_reasoning';

function kimiField(
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

function createKimiK3Fields(): readonly ParameterFieldSchemaV2[] {
  return [
    kimiField('max_completion_tokens', 'integer', 10, { minimum: 1, maximum: 1_048_576 }),
    kimiField('reasoning_effort', 'enum', 20, { options: ['low', 'high', 'max'] }),
    kimiField('stop', 'string', 30),
    kimiField('response_format', 'object', 40),
    kimiField('tool_choice', 'string', 50),
    kimiField('parallel_tool_calls', 'boolean', 60),
    kimiField('user', 'string', 70),
    kimiField('metadata', 'object', 80)
  ];
}

export const kimiK3TextChatParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: KIMI_K3_TEXT_CHAT_PARAMETER_SCHEMA_ID,
  revision: 1,
  productFeature: 'text_chat',
  fields: createKimiK3Fields()
};

export const kimiK3TextReasoningParameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: KIMI_K3_TEXT_REASONING_PARAMETER_SCHEMA_ID,
  revision: 1,
  productFeature: 'text_reasoning',
  fields: createKimiK3Fields()
};

export const kimiProviderPackageDescriptor: ProviderPackageDescriptor = {
  packageId: KIMI_PROVIDER_PACKAGE_ID,
  packageVersion: KIMI_PROVIDER_PACKAGE_VERSION,
  displayName: 'Kimi',
  credentialSchemas: [{
    schemaId: KIMI_CREDENTIAL_SCHEMA_ID,
    version: 1,
    fields: [{ key: 'api_key', label: 'API key', secret: true, required: true, kind: 'token' }]
  }],
  endpointPolicies: [{
    policyId: KIMI_ENDPOINT_POLICY_ID,
    revision: 1,
    allowedSchemes: ['https'],
    allowedHosts: ['api.moonshot.cn'],
    allowedPorts: [443],
    allowedPathPrefixes: ['/v1'],
    redirectPolicy: 'deny',
    proxyPolicy: 'system',
    allowLoopback: false,
    allowPrivateNetwork: false,
    allowLoopbackHttp: false,
    dnsRebindingProtection: 'required',
    fixedBaseUrl: KIMI_OFFICIAL_BASE_URL
  }],
  adapters: [{
    adapterId: NEWAPI_CHAT_ADAPTER_ID,
    adapterVersion: NEWAPI_ADAPTER_VERSION,
    protocolId: NEWAPI_CHAT_PROTOCOL_ID,
    protocolVersion: NEWAPI_PROTOCOL_VERSION,
    operations: ['validate_connection', 'discover_models', 'submit', 'cancel']
  }],
  templates: [{
    templateId: KIMI_OFFICIAL_TEMPLATE_ID,
    kind: 'official',
    displayName: 'Kimi Official',
    baseUrlMode: 'fixed',
    credentialSchemaId: KIMI_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    connectionPolicyId: 'connection.kimi.official',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.kimi.models',
    discoveryPolicyRevision: 1,
    endpointPolicyId: KIMI_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    adapterBindings: [{ adapterId: NEWAPI_CHAT_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION }],
    freeConnectionValidation: true,
    modelDiscoveryKind: 'catalog'
  }]
};

export const kimiK3TextProviderContracts = [
  {
    parameterSchema: kimiK3TextChatParameterSchema,
    resultSchemaId: NEWAPI_CHAT_RESULT_SCHEMA_ID,
    resultSchemaRevision: 1,
    usageSchema: newApiChatUsageSchema,
    constraintSetId: NEWAPI_TEXT_CONSTRAINT_SET_ID,
    constraintSetRevision: 1,
    featureMappingVersion: 1
  },
  {
    parameterSchema: kimiK3TextReasoningParameterSchema,
    resultSchemaId: NEWAPI_CHAT_RESULT_SCHEMA_ID,
    resultSchemaRevision: 1,
    usageSchema: newApiChatUsageSchema,
    constraintSetId: NEWAPI_TEXT_CONSTRAINT_SET_ID,
    constraintSetRevision: 1,
    featureMappingVersion: 1
  }
] as const;
