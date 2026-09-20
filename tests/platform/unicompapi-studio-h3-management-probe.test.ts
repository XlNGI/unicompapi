import { describe, expect, it } from 'vitest';
import {
  createProviderConnection,
  toConnectionId,
  toIsoTimestamp,
  toProviderId,
  type ProviderConnection,
  type StructuredCredentialRecord
} from '../../src/domain';
import {
  UNICOMPAPI_STUDIO_H3_BASE_URL,
  UNICOMPAPI_STUDIO_H3_CREDENTIAL_SCHEMA_ID,
  UNICOMPAPI_STUDIO_H3_ENDPOINT_POLICY_ID,
  UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_VERSION,
  UNICOMPAPI_STUDIO_H3_TEMPLATE_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION,
  UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION,
  UnicompapiStudioH3ManagementAdapter,
  UnicompapiStudioH3SharedRuntime,
  UnicompapiStudioH3TransportFailure,
  type UnicompapiStudioH3HttpTransport,
  type UnicompapiStudioH3HttpTransportRequest,
  type UnicompapiStudioH3HttpTransportResponse,
  type UnicompapiStudioH3SafeLogEvent
} from '../../src/platform';

const observedAt = toIsoTimestamp('2026-09-20T16:00:00.000Z');
const credential: StructuredCredentialRecord = {
  schemaId: UNICOMPAPI_STUDIO_H3_CREDENTIAL_SCHEMA_ID,
  schemaVersion: 1,
  values: { api_key: 'probe-studio-h3-key' }
};

describe('UniCompAPI Studio H3 account probe', () => {
  it('validates a draft connection against GET /models containing minimax-h3', async () => {
    const fixture = probeFixture();
    fixture.transport.responses.push(jsonResponse({
      data: [
        { id: 'minimax-h3', variant: 'fl2va' },
        { id: 'minimax-h3', variant: 'ref2va' }
      ]
    }));

    const result = await fixture.adapter.validateConnection({
      connection: managementConnection('saved', 'saved'),
      credentials: credential
    });

    expect(result).toEqual({
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid',
      observedAt
    });
    expect(fixture.transport.requests).toHaveLength(1);
    const request = fixture.transport.requests[0];
    expect(request.method).toBe('GET');
    const url = new URL(request.url);
    expect(url.origin).toBe('https://unicompapi.com');
    expect(url.pathname).toBe('/studio/h3/v1/models');
    expect(request.headers.authorization).toBe('Bearer probe-studio-h3-key');
    expect(JSON.stringify(fixture.logs)).not.toMatch(/probe-studio-h3-key/);
  });

  it('maps HTTP 401 to invalid credentials', async () => {
    const fixture = probeFixture();
    fixture.transport.responses.push(jsonResponse({}, 401));
    await expect(fixture.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    })).resolves.toMatchObject({
      state: 'unavailable',
      credentialState: 'invalid',
      safeCode: 'authentication_failed'
    });
  });

  it('maps rate limiting and network failures to verification_unavailable', async () => {
    const limited = probeFixture();
    limited.transport.responses.push(jsonResponse({}, 429));
    await expect(limited.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    })).resolves.toMatchObject({
      credentialState: 'verification_unavailable',
      safeCode: 'rate_limited'
    });

    const offline = probeFixture();
    offline.transport.failures.push(new UnicompapiStudioH3TransportFailure('network'));
    await expect(offline.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    })).resolves.toMatchObject({
      credentialState: 'verification_unavailable',
      safeCode: 'network_error'
    });
  });

  it('rejects a catalog without minimax-h3', async () => {
    const fixture = probeFixture();
    fixture.transport.responses.push(jsonResponse({ data: [{ id: 'other-model' }] }));
    await expect(fixture.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    })).resolves.toMatchObject({
      credentialState: 'verification_unavailable',
      safeCode: 'invalid_response'
    });
  });

  it('refuses disabled connections without firing any HTTP request', async () => {
    const fixture = probeFixture();
    const result = await fixture.adapter.validateConnection({
      connection: managementConnection('disabled', 'valid'),
      credentials: credential
    });
    expect(result).toMatchObject({
      safeCode: 'protocol_mismatch'
    });
    expect(fixture.transport.requests).toHaveLength(0);
  });
});

function probeFixture() {
  const transport = new SyntheticProbeTransport();
  const logs: UnicompapiStudioH3SafeLogEvent[] = [];
  const runtime = new UnicompapiStudioH3SharedRuntime({
    transport,
    logger: (event) => logs.push(event),
    defaultTimeoutMs: 10_000,
    now: () => 1_000
  });
  return {
    transport,
    logs,
    adapter: new UnicompapiStudioH3ManagementAdapter(runtime, () => observedAt)
  };
}

class SyntheticProbeTransport implements UnicompapiStudioH3HttpTransport {
  readonly requests: UnicompapiStudioH3HttpTransportRequest[] = [];
  readonly responses: UnicompapiStudioH3HttpTransportResponse[] = [];
  readonly failures: unknown[] = [];

  async send(
    request: UnicompapiStudioH3HttpTransportRequest
  ): Promise<UnicompapiStudioH3HttpTransportResponse> {
    this.requests.push({
      ...request,
      headers: { ...request.headers },
      body: Uint8Array.from(request.body)
    });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const response = this.responses.shift();
    if (!response) throw new Error('Synthetic UniCompAPI Studio H3 response is missing');
    return response;
  }
}

function managementConnection(
  state: ProviderConnection['state'],
  credentialState: ProviderConnection['credentialState']
): ProviderConnection {
  return createProviderConnection({
    id: toConnectionId('connection-studio-h3-probe'),
    providerId: toProviderId('provider-studio-h3-probe'),
    name: 'UniCompAPI Studio H3 probe',
    endpoint: `${UNICOMPAPI_STUDIO_H3_BASE_URL}/`,
    packageId: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
    packageVersion: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_VERSION,
    templateId: UNICOMPAPI_STUDIO_H3_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: UNICOMPAPI_STUDIO_H3_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-studio-h3-probe',
    connectionPolicyId: 'connection.unicompapi-studio-h3.test',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.unicompapi-studio-h3.packaged-catalog',
    discoveryPolicyRevision: 1,
    endpointPolicyId: UNICOMPAPI_STUDIO_H3_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-studio-h3-probe',
    connectionRevision: 1,
    adapterBindings: [{
      adapterId: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
      adapterVersion: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION,
      protocolId: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
      protocolVersion: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION
    }],
    state,
    identityState: 'unverified',
    credentialState,
    createdAt: observedAt,
    updatedAt: observedAt
  });
}

function jsonResponse(
  value: unknown,
  status = 200
): UnicompapiStudioH3HttpTransportResponse {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.byteLength)
    },
    body
  };
}
