import { type ProviderPackageDescriptor } from '../../../domain';
import {
  NEWAPI_ADAPTER_VERSION,
  NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_CHAT_PROTOCOL_ID,
  NEWAPI_IMAGE_ADAPTER_ID,
  NEWAPI_IMAGE_PROTOCOL_ID,
  NEWAPI_PROTOCOL_VERSION,
  NEWAPI_VIDEO_ADAPTER_ID,
  NEWAPI_VIDEO_PROTOCOL_ID
} from './newapi-contracts';

export const UNICOMPAPI_PROVIDER_PACKAGE_ID = 'provider-package-unicompapi';
export const UNICOMPAPI_PROVIDER_PACKAGE_VERSION = '1.0.0';
export const UNICOMPAPI_OFFICIAL_TEMPLATE_ID = 'unicompapi-official';
export const UNICOMPAPI_CREDENTIAL_SCHEMA_ID = 'credential.unicompapi.api-key';
export const UNICOMPAPI_ENDPOINT_POLICY_ID = 'endpoint.unicompapi.official';
export const UNICOMPAPI_OFFICIAL_BASE_URL = 'https://unicompapi.com/v1';
// Preserve the legacy fixed-endpoint identifiers above for existing connections.
// They do not identify this relay as a model vendor or its schemas as vendor contracts.
export const UNICOMPAPI_WWW_TEMPLATE_ID = 'unicompapi-www-relay';
export const UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID = 'provider-package-unicompapi-www';
export const UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID = 'credential.unicompapi.www.api-key';
export const UNICOMPAPI_WWW_ENDPOINT_POLICY_ID = 'endpoint.unicompapi.www-relay';
export const UNICOMPAPI_WWW_BASE_URL = 'https://www.unicompapi.com/v1';

export const unicompapiProviderPackageDescriptor: ProviderPackageDescriptor = {
  packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
  packageVersion: UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
  displayName: 'UniCompAPI',
  credentialSchemas: [
    {
      schemaId: UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
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
      policyId: UNICOMPAPI_ENDPOINT_POLICY_ID,
      revision: 1,
      allowedSchemes: ['https'],
      allowedHosts: ['unicompapi.com'],
      allowedPorts: [443],
      allowedPathPrefixes: ['/v1'],
      redirectPolicy: 'deny',
      proxyPolicy: 'system',
      allowLoopback: false,
      allowPrivateNetwork: false,
      allowLoopbackHttp: false,
      dnsRebindingProtection: 'required',
      fixedBaseUrl: UNICOMPAPI_OFFICIAL_BASE_URL
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
      templateId: UNICOMPAPI_OFFICIAL_TEMPLATE_ID,
      kind: 'official',
      serviceRole: 'relay',
      displayName: 'unicompapi.com',
      baseUrlMode: 'fixed',
      credentialSchemaId: UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
      credentialSchemaVersion: 1,
      connectionPolicyId: 'connection.unicompapi.official',
      connectionPolicyRevision: 1,
      discoveryPolicyId: 'discovery.unicompapi.models',
      discoveryPolicyRevision: 1,
      endpointPolicyId: UNICOMPAPI_ENDPOINT_POLICY_ID,
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

/** WWW media uses a dedicated quote/submit adapter behind the shared transport identity. */
export const unicompapiWwwProviderPackageDescriptor: ProviderPackageDescriptor = {
  packageId: UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID, packageVersion: UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
  displayName: 'UniCompAPI WWW',
  credentialSchemas: [{ schemaId: UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID, version: 1,
    fields: [{ key: 'api_key', label: 'API key', secret: true, required: true, kind: 'token' }] }],
  endpointPolicies: [{ policyId: UNICOMPAPI_WWW_ENDPOINT_POLICY_ID, revision: 1, allowedSchemes: ['https'],
    allowedHosts: ['www.unicompapi.com'], allowedPorts: [443], allowedPathPrefixes: ['/v1'], redirectPolicy: 'deny', proxyPolicy: 'system',
    allowLoopback: false, allowPrivateNetwork: false, allowLoopbackHttp: false, dnsRebindingProtection: 'required', fixedBaseUrl: UNICOMPAPI_WWW_BASE_URL }],
  adapters: unicompapiProviderPackageDescriptor.adapters.filter(adapter => adapter.adapterId === NEWAPI_CHAT_ADAPTER_ID || adapter.adapterId === NEWAPI_VIDEO_ADAPTER_ID),
  templates: [{ templateId: UNICOMPAPI_WWW_TEMPLATE_ID, kind: 'official', serviceRole: 'relay', displayName: 'www.unicompapi.com', baseUrlMode: 'fixed',
    credentialSchemaId: UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID, credentialSchemaVersion: 1,
    connectionPolicyId: 'connection.unicompapi.www-relay', connectionPolicyRevision: 1, discoveryPolicyId: 'discovery.unicompapi.www-models', discoveryPolicyRevision: 1,
    endpointPolicyId: UNICOMPAPI_WWW_ENDPOINT_POLICY_ID, endpointPolicyRevision: 1,
    adapterBindings: [{ adapterId: NEWAPI_CHAT_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION },
      { adapterId: NEWAPI_VIDEO_ADAPTER_ID, adapterVersion: NEWAPI_ADAPTER_VERSION }], freeConnectionValidation: true, modelDiscoveryKind: 'catalog' }]
};
