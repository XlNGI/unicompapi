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
  VIDU_CREDENTIAL_SCHEMA_ID,
  VIDU_ENDPOINT_POLICY_ID,
  VIDU_OFFICIAL_BASE_URL,
  VIDU_OFFICIAL_TEMPLATE_ID,
  VIDU_PROVIDER_PACKAGE_ID,
  VIDU_PROVIDER_PACKAGE_VERSION,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
  VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
  VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION,
  ViduManagementAdapter,
  ViduSharedRuntime,
  ViduTransportFailure,
  type ViduHttpTransport,
  type ViduHttpTransportRequest,
  type ViduHttpTransportResponse,
  type ViduSafeLogEvent
} from '../../src/platform';

const observedAt = toIsoTimestamp('2026-08-05T02:00:00.000Z');
const credential: StructuredCredentialRecord = {
  schemaId: VIDU_CREDENTIAL_SCHEMA_ID,
  schemaVersion: 1,
  values: { token: 'probe-vidu-token' }
};

describe('vidu credits probe', () => {
  it('validates a draft connection against the free credits endpoint', async () => {
    const fixture = probeFixture();
    fixture.transport.responses.push(jsonResponse({
      remaining_credits: 12
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
    expect(request.url).toBe(`${VIDU_OFFICIAL_BASE_URL}/ent/v2/credits`);
    expect(request.headers.authorization).toBe('Token probe-vidu-token');
    expect(JSON.stringify(fixture.logs)).not.toMatch(/probe-vidu-token/);
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
    fixture.transport.failures.push(new ViduTransportFailure('network'));
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
  const logs: ViduSafeLogEvent[] = [];
  const runtime = new ViduSharedRuntime({
    transport,
    logger: (event) => logs.push(event),
    defaultTimeoutMs: 10_000,
    now: () => 1_000
  });
  return {
    transport,
    logs,
    adapter: new ViduManagementAdapter(runtime, () => observedAt)
  };
}

class SyntheticProbeTransport implements ViduHttpTransport {
  readonly requests: ViduHttpTransportRequest[] = [];
  readonly responses: ViduHttpTransportResponse[] = [];
  readonly failures: unknown[] = [];

  async send(request: ViduHttpTransportRequest): Promise<ViduHttpTransportResponse> {
    this.requests.push({
      ...request,
      headers: { ...request.headers },
      body: request.body ? Uint8Array.from(request.body) : undefined
    });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const response = this.responses.shift();
    if (!response) throw new Error('Synthetic Vidu response is missing');
    return response;
  }
}

function managementConnection(
  state: ProviderConnection['state'],
  credentialState: ProviderConnection['credentialState']
): ProviderConnection {
  return createProviderConnection({
    id: toConnectionId('connection-vidu-probe'),
    providerId: toProviderId('provider-vidu-probe'),
    name: 'Vidu probe',
    endpoint: VIDU_OFFICIAL_BASE_URL,
    packageId: VIDU_PROVIDER_PACKAGE_ID,
    packageVersion: VIDU_PROVIDER_PACKAGE_VERSION,
    templateId: VIDU_OFFICIAL_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: VIDU_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-vidu-probe',
    connectionPolicyId: 'connection.vidu.official',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.vidu.packaged-catalog',
    discoveryPolicyRevision: 1,
    endpointPolicyId: VIDU_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-vidu-probe',
    connectionRevision: 1,
    adapterBindings: [{
      adapterId: VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
      adapterVersion: VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
      protocolId: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
      protocolVersion: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION
    }],
    state,
    identityState: 'unverified',
    credentialState,
    createdAt: observedAt,
    updatedAt: observedAt
  });
}

function jsonResponse(value: unknown, status = 200): ViduHttpTransportResponse {
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
