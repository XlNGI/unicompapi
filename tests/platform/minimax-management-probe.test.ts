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
  MINIMAX_H3_CN_BASE_URL,
  MINIMAX_H3_CN_ENDPOINT_POLICY_ID,
  MINIMAX_H3_CN_TEMPLATE_ID,
  MINIMAX_H3_CREDENTIAL_SCHEMA_ID,
  MINIMAX_H3_GLOBAL_BASE_URL,
  MINIMAX_H3_GLOBAL_ENDPOINT_POLICY_ID,
  MINIMAX_H3_GLOBAL_TEMPLATE_ID,
  MINIMAX_H3_PROVIDER_PACKAGE_ID,
  MINIMAX_H3_PROVIDER_PACKAGE_VERSION,
  MINIMAX_H3_VIDEO_ADAPTER_ID,
  MINIMAX_H3_VIDEO_ADAPTER_VERSION,
  MINIMAX_H3_VIDEO_PROTOCOL_ID,
  MINIMAX_H3_VIDEO_PROTOCOL_VERSION,
  MiniMaxManagementAdapter,
  MiniMaxSharedRuntime,
  MiniMaxTransportFailure,
  type MiniMaxHttpTransport,
  type MiniMaxHttpTransportRequest,
  type MiniMaxHttpTransportResponse,
  type MiniMaxSafeLogEvent
} from '../../src/platform';

const observedAt = toIsoTimestamp('2026-09-20T02:00:00.000Z');
const credential: StructuredCredentialRecord = {
  schemaId: MINIMAX_H3_CREDENTIAL_SCHEMA_ID,
  schemaVersion: 1,
  values: { api_key: 'probe-minimax-key' }
};

describe('minimax account probe', () => {
  it('validates a draft connection against the free files retrieve endpoint', async () => {
    const fixture = probeFixture();
    fixture.transport.responses.push(jsonResponse({
      base_resp: { status_code: 2042, status_msg: 'file not found' }
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
    const url = new URL(request.url);
    expect(url.origin).toBe(MINIMAX_H3_CN_BASE_URL);
    expect(url.pathname).toBe('/v1/files/retrieve');
    expect(url.searchParams.get('file_id')).toBe('0');
    expect(request.headers.authorization).toBe('Bearer probe-minimax-key');
    expect(JSON.stringify(fixture.logs)).not.toMatch(/probe-minimax-key/);
  });

  it('uses the selected official origin for the global template', async () => {
    const fixture = probeFixture();
    fixture.transport.responses.push(jsonResponse({
      base_resp: { status_code: 2042, status_msg: 'file not found' }
    }, 404));
    await fixture.adapter.validateConnection({
      connection: managementConnection('saved', 'saved', 'global'),
      credentials: credential
    });
    expect(new URL(fixture.transport.requests[0].url).origin)
      .toBe(MINIMAX_H3_GLOBAL_BASE_URL);
  });

  it('maps HTTP 401 and auth business codes to invalid credentials', async () => {
    const http401 = probeFixture();
    http401.transport.responses.push(jsonResponse({}, 401));
    await expect(http401.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    })).resolves.toMatchObject({
      state: 'unavailable',
      credentialState: 'invalid',
      safeCode: 'authentication_failed'
    });

    const business = probeFixture();
    business.transport.responses.push(jsonResponse({
      base_resp: { status_code: 1004, status_msg: 'invalid api key' }
    }));
    await expect(business.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    })).resolves.toMatchObject({
      credentialState: 'invalid',
      safeCode: 'authentication_failed'
    });
  });

  it('maps business code 1008 to a valid credential on an unavailable account', async () => {
    const fixture = probeFixture();
    fixture.transport.responses.push(jsonResponse({
      base_resp: { status_code: 1008, status_msg: 'insufficient balance' }
    }));
    await expect(fixture.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    })).resolves.toMatchObject({
      state: 'unavailable',
      credentialState: 'valid',
      safeCode: 'account_unavailable'
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
    offline.transport.failures.push(new MiniMaxTransportFailure('network'));
    await expect(offline.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    })).resolves.toMatchObject({
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
      safeCode: 'protocol_mismatch'
    });
    expect(fixture.transport.requests).toHaveLength(0);
  });
});

function probeFixture() {
  const transport = new SyntheticProbeTransport();
  const logs: MiniMaxSafeLogEvent[] = [];
  const runtime = new MiniMaxSharedRuntime({
    transport,
    logger: (event) => logs.push(event),
    defaultTimeoutMs: 10_000,
    now: () => 1_000
  });
  return {
    transport,
    logs,
    adapter: new MiniMaxManagementAdapter(runtime, () => observedAt)
  };
}

class SyntheticProbeTransport implements MiniMaxHttpTransport {
  readonly requests: MiniMaxHttpTransportRequest[] = [];
  readonly responses: MiniMaxHttpTransportResponse[] = [];
  readonly failures: unknown[] = [];

  async send(request: MiniMaxHttpTransportRequest): Promise<MiniMaxHttpTransportResponse> {
    this.requests.push({
      ...request,
      headers: { ...request.headers },
      body: Uint8Array.from(request.body)
    });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const response = this.responses.shift();
    if (!response) throw new Error('Synthetic MiniMax response is missing');
    return response;
  }
}

function managementConnection(
  state: ProviderConnection['state'],
  credentialState: ProviderConnection['credentialState'],
  region: 'cn' | 'global' = 'cn'
): ProviderConnection {
  const cn = region === 'cn';
  return createProviderConnection({
    id: toConnectionId('connection-minimax-probe'),
    providerId: toProviderId('provider-minimax-probe'),
    name: 'MiniMax probe',
    endpoint: `${cn ? MINIMAX_H3_CN_BASE_URL : MINIMAX_H3_GLOBAL_BASE_URL}/`,
    packageId: MINIMAX_H3_PROVIDER_PACKAGE_ID,
    packageVersion: MINIMAX_H3_PROVIDER_PACKAGE_VERSION,
    templateId: cn ? MINIMAX_H3_CN_TEMPLATE_ID : MINIMAX_H3_GLOBAL_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: MINIMAX_H3_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-minimax-probe',
    connectionPolicyId: cn
      ? 'connection.minimax-h3.official-cn'
      : 'connection.minimax-h3.official-global',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.minimax-h3.packaged-catalog',
    discoveryPolicyRevision: 1,
    endpointPolicyId: cn
      ? MINIMAX_H3_CN_ENDPOINT_POLICY_ID
      : MINIMAX_H3_GLOBAL_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-minimax-probe',
    connectionRevision: 1,
    adapterBindings: [{
      adapterId: MINIMAX_H3_VIDEO_ADAPTER_ID,
      adapterVersion: MINIMAX_H3_VIDEO_ADAPTER_VERSION,
      protocolId: MINIMAX_H3_VIDEO_PROTOCOL_ID,
      protocolVersion: MINIMAX_H3_VIDEO_PROTOCOL_VERSION
    }],
    state,
    identityState: 'unverified',
    credentialState,
    createdAt: observedAt,
    updatedAt: observedAt
  });
}

function jsonResponse(value: unknown, status = 200): MiniMaxHttpTransportResponse {
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
