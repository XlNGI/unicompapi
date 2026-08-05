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
  SEEDANCE_VIDEO_ADAPTER_ID,
  SEEDANCE_VIDEO_ADAPTER_VERSION,
  SEEDANCE_VIDEO_PROTOCOL_ID,
  SEEDANCE_VIDEO_PROTOCOL_VERSION,
  VOLCENGINE_CREDENTIAL_SCHEMA_ID,
  VOLCENGINE_ENDPOINT_POLICY_ID,
  VOLCENGINE_OFFICIAL_BASE_URL,
  VOLCENGINE_OFFICIAL_TEMPLATE_ID,
  VOLCENGINE_PROVIDER_PACKAGE_ID,
  VOLCENGINE_PROVIDER_PACKAGE_VERSION,
  VolcengineManagementAdapter,
  VolcengineSharedRuntime,
  VolcengineTransportFailure,
  type VolcengineHttpTransport,
  type VolcengineHttpTransportRequest,
  type VolcengineHttpTransportResponse,
  type VolcengineSafeLogEvent
} from '../../src/platform';

const observedAt = toIsoTimestamp('2026-08-05T02:00:00.000Z');
const credential: StructuredCredentialRecord = {
  schemaId: VOLCENGINE_CREDENTIAL_SCHEMA_ID,
  schemaVersion: 1,
  values: { api_key: 'probe-ark-key' }
};

describe('volcengine ark connectivity probe', () => {
  it('treats a synthetic task 404 as successful connectivity', async () => {
    const fixture = probeFixture();
    fixture.transport.responses.push(jsonResponse({
      error: { code: 'InvalidEndpointOrModel.NotFound', message: 'not found' }
    }, 404));

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
    expect(request.url).toBe(
      `${VOLCENGINE_OFFICIAL_BASE_URL}/contents/generations/tasks/unicomp-connectivity-probe`
    );
    expect(request.headers.authorization).toBe('Bearer probe-ark-key');
    expect(request.body.byteLength).toBe(0);
    expect(JSON.stringify(fixture.logs)).not.toMatch(/probe-ark-key/);
    expect(fixture.logs.map((entry) => entry.operation))
      .toEqual(['connection_probe', 'connection_probe']);
  });

  it('maps HTTP 401 to invalid credentials', async () => {
    const fixture = probeFixture();
    fixture.transport.responses.push(jsonResponse({}, 401));
    const result = await fixture.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    });
    expect(result).toMatchObject({
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'invalid',
      safeCode: 'authentication_failed',
      observedAt
    });
  });

  it('maps transport failures without treating credentials as invalid', async () => {
    const fixture = probeFixture();
    fixture.transport.failures.push(new VolcengineTransportFailure('network'));
    await expect(fixture.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    })).resolves.toMatchObject({
      state: 'unavailable',
      credentialState: 'verification_unavailable',
      safeCode: 'network_error'
    });
  });

  it('refuses disabled connections without firing any HTTP request', async () => {
    const fixture = probeFixture();
    const result = await fixture.adapter.validateConnection({
      connection: managementConnection('disabled', 'valid'),
      credentials: credential
    });
    expect(result).toMatchObject({
      state: 'unavailable',
      credentialState: 'verification_unavailable',
      safeCode: 'protocol_mismatch'
    });
    expect(fixture.transport.requests).toHaveLength(0);
  });
});

function probeFixture() {
  const transport = new SyntheticProbeTransport();
  const logs: VolcengineSafeLogEvent[] = [];
  const runtime = new VolcengineSharedRuntime({
    transport,
    logger: (event) => logs.push(event),
    defaultTimeoutMs: 10_000,
    now: () => 1_000
  });
  return {
    transport,
    logs,
    adapter: new VolcengineManagementAdapter(runtime, () => observedAt)
  };
}

class SyntheticProbeTransport implements VolcengineHttpTransport {
  readonly requests: VolcengineHttpTransportRequest[] = [];
  readonly responses: VolcengineHttpTransportResponse[] = [];
  readonly failures: unknown[] = [];

  async send(
    request: VolcengineHttpTransportRequest
  ): Promise<VolcengineHttpTransportResponse> {
    this.requests.push({
      ...request,
      headers: { ...request.headers },
      body: Uint8Array.from(request.body)
    });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const response = this.responses.shift();
    if (!response) throw new Error('Synthetic Volcengine response is missing');
    return response;
  }
}

function managementConnection(
  state: ProviderConnection['state'],
  credentialState: ProviderConnection['credentialState']
): ProviderConnection {
  return createProviderConnection({
    id: toConnectionId('connection-volcengine-probe'),
    providerId: toProviderId('provider-volcengine-probe'),
    name: 'Volcengine probe',
    endpoint: VOLCENGINE_OFFICIAL_BASE_URL,
    packageId: VOLCENGINE_PROVIDER_PACKAGE_ID,
    packageVersion: VOLCENGINE_PROVIDER_PACKAGE_VERSION,
    templateId: VOLCENGINE_OFFICIAL_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: VOLCENGINE_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-volcengine-probe',
    connectionPolicyId: 'connection.volcengine.ark.official',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.volcengine.ark.manual-endpoint',
    discoveryPolicyRevision: 1,
    endpointPolicyId: VOLCENGINE_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-volcengine-probe',
    connectionRevision: 1,
    adapterBindings: [{
      adapterId: SEEDANCE_VIDEO_ADAPTER_ID,
      adapterVersion: SEEDANCE_VIDEO_ADAPTER_VERSION,
      protocolId: SEEDANCE_VIDEO_PROTOCOL_ID,
      protocolVersion: SEEDANCE_VIDEO_PROTOCOL_VERSION
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
): VolcengineHttpTransportResponse {
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
