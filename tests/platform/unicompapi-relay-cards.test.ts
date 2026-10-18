import { describe, expect, it } from 'vitest';
import { createProviderConnection, toProviderId, toConnectionId, toIsoTimestamp } from '../../src/domain';
import { NewApiSharedRuntime } from '../../src/platform/providers/newapi/newapi-runtime';
import { ProviderPackageRegistry } from '../../src/platform/providers/provider-package-registry';
import { unicompapiProviderPackageDescriptor, unicompapiWwwProviderPackageDescriptor, UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID, UNICOMPAPI_PROVIDER_PACKAGE_ID, UNICOMPAPI_OFFICIAL_TEMPLATE_ID,
  UNICOMPAPI_WWW_TEMPLATE_ID, UNICOMPAPI_WWW_ENDPOINT_POLICY_ID, UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID,
  UNICOMPAPI_OFFICIAL_BASE_URL, UNICOMPAPI_WWW_BASE_URL } from '../../src/platform/providers/newapi/unicompapi-contracts';

describe('UniCompAPI relay connection cards', () => {
  it('publishes two independent relay cards with fixed domain policies', () => {
    const registry = new ProviderPackageRegistry([unicompapiProviderPackageDescriptor, unicompapiWwwProviderPackageDescriptor]);
    const templates = registry.listSafeTemplates();
    expect(templates).toHaveLength(2);
    expect(templates.map(template => template.serviceRole)).toEqual(['relay', 'relay']);
    expect(templates.map(template => template.displayName)).toEqual(['unicompapi.com', 'www.unicompapi.com']);
    const original = registry.resolveTemplate(UNICOMPAPI_PROVIDER_PACKAGE_ID, UNICOMPAPI_OFFICIAL_TEMPLATE_ID);
    const www = registry.resolveTemplate(UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID, UNICOMPAPI_WWW_TEMPLATE_ID);
    expect(registry.resolveEndpoint(original, undefined, false)).toBe(UNICOMPAPI_OFFICIAL_BASE_URL);
    expect(registry.resolveEndpoint(www, undefined, false)).toBe(UNICOMPAPI_WWW_BASE_URL);
    expect(() => registry.resolveEndpoint(original, UNICOMPAPI_WWW_BASE_URL, false)).toThrow();
    expect(() => registry.resolveEndpoint(www, UNICOMPAPI_OFFICIAL_BASE_URL, false)).toThrow();
    expect(original.endpointPolicy.policyId).not.toBe(www.endpointPolicy.policyId);
    expect(original.credentialSchema.schemaId).not.toBe(www.credentialSchema.schemaId);
    expect(www.adapters.map(adapter => adapter.adapterId)).toEqual(['newapi.chat', 'newapi.video']);
  });
  it('retains the WWW request identifier and sends one controlled idempotency key without a retry', async () => {
    const requests: { url: string; headers: Readonly<Record<string, string>> }[] = [];
    const now = toIsoTimestamp('2026-10-12T12:00:00.000Z');
    const connection = createProviderConnection({ id: toConnectionId('www-request-test'), providerId: toProviderId('www-provider-test'), name: 'Synthetic WWW',
      endpoint: UNICOMPAPI_WWW_BASE_URL, packageId: UNICOMPAPI_WWW_PROVIDER_PACKAGE_ID, packageVersion: '1.0.0', templateId: UNICOMPAPI_WWW_TEMPLATE_ID,
      templateKind: 'official', credentialSchemaId: UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID, credentialSchemaVersion: 1,
      credentialVersionId: 'www-credential-v1', credentialReference: 'www-credential-ref', connectionPolicyId: 'connection.unicompapi.www-relay',
      connectionPolicyRevision: 1, discoveryPolicyId: 'discovery.unicompapi.www-models', discoveryPolicyRevision: 1,
      endpointPolicyId: UNICOMPAPI_WWW_ENDPOINT_POLICY_ID, endpointPolicyRevision: 1, connectionConfigVersionId: 'www-config-v1', connectionRevision: 1,
      adapterBindings: [{ adapterId: 'newapi.chat', adapterVersion: '2026-08-03', protocolId: 'newapi.openai.chat-completions', protocolVersion: '2026-08-03' }],
      state: 'available', identityState: 'verified', credentialState: 'valid', createdAt: now, updatedAt: now });
    const runtime = new NewApiSharedRuntime({ transport: { send: async request => {
      requests.push(request);
      return { status: 200, headers: { 'content-type': 'text/event-stream', 'X-Unicomp-Request-Id': 'www-response-verified' }, stream: (async function* () { yield Buffer.from('data: [DONE]\n\n'); })() };
    } } });
    const session = await runtime.openChatStream({ connection, credentials: { schemaId: UNICOMPAPI_WWW_CREDENTIAL_SCHEMA_ID, schemaVersion: 1, values: { api_key: 'synthetic-public-test' } },
      body: new TextEncoder().encode('{}'), idempotencyKey: 'synthetic-www-request-v1' });
    expect(session.requestId).toBe('www-response-verified');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://www.unicompapi.com/v1/chat/completions');
    expect(requests[0].headers['Idempotency-Key']).toBe('synthetic-www-request-v1');
    session.close(); runtime.dispose();
  });
});
