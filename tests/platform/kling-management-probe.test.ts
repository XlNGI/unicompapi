import { createHmac } from 'node:crypto';
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
  KLING_CREDENTIAL_SCHEMA_ID,
  KLING_ENDPOINT_POLICY_ID,
  KLING_OFFICIAL_BASE_URL,
  KLING_OFFICIAL_TEMPLATE_ID,
  KLING_PROVIDER_PACKAGE_ID,
  KLING_PROVIDER_PACKAGE_VERSION,
  KLING_VIDEO_ADAPTER_ID,
  KLING_VIDEO_ADAPTER_VERSION,
  KLING_VIDEO_PROTOCOL_ID,
  KLING_VIDEO_PROTOCOL_VERSION,
  KlingManagementAdapter,
  KlingSharedRuntime,
  KlingTransportFailure,
  mintKlingApiToken,
  type KlingHttpTransport,
  type KlingHttpTransportRequest,
  type KlingHttpTransportResponse,
  type KlingSafeLogEvent
} from '../../src/platform';

const observedAt = toIsoTimestamp('2026-08-05T02:00:00.000Z');
const credential: StructuredCredentialRecord = {
  schemaId: KLING_CREDENTIAL_SCHEMA_ID,
  schemaVersion: 1,
  values: { access_key: 'probe-ak', secret_key: 'probe-sk' }
};

describe('kling account probe', () => {
  it('mints an HS256 JWT matching the official Kling token contract', () => {
    const token = mintKlingApiToken(
      { accessKey: 'probe-ak', secretKey: 'probe-sk' },
      1_756_000_000_000
    );
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')))
      .toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
      .toEqual({
        iss: 'probe-ak',
        exp: 1_756_000_000 + 1_800,
        nbf: 1_756_000_000 - 5
      });
    const expected = createHmac('sha256', 'probe-sk')
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
    expect(token).not.toMatch(/probe-sk/);
    expect(() => mintKlingApiToken(
      { accessKey: 'probe-ak', secretKey: 'probe-sk' },
      Number.NaN
    )).toThrowError(/invalid/i);
  });

  it('validates a draft connection against the free account costs endpoint', async () => {
    const fixture = probeFixture();
    fixture.transport.responses.push(jsonResponse({
      code: 0,
      message: 'success',
      request_id: 'request-probe-1',
      data: { resource_pack_subscribe_infos: [] }
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
    expect(url.origin).toBe(KLING_OFFICIAL_BASE_URL);
    expect(url.pathname).toBe('/v1/account/costs');
    expect(url.searchParams.get('start_time')).toBe('0');
    expect(url.searchParams.get('end_time')).toBe('1000');
    expect(request.body.byteLength).toBe(0);
    const [, payload] = request.headers.authorization.replace(/^Bearer /u, '').split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).iss)
      .toBe('probe-ak');
    expect(JSON.stringify(fixture.logs)).not.toMatch(/probe-sk|probe-ak/);
    expect(fixture.logs.map((entry) => entry.operation))
      .toEqual(['account_costs', 'account_costs']);
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

  it.each([1000, 1001, 1002])(
    'maps business code %i to invalid credentials',
    async (businessCode) => {
      const fixture = probeFixture();
      fixture.transport.responses.push(jsonResponse({
        code: businessCode,
        message: 'authentication failed',
        request_id: 'request-probe-auth'
      }));
      const result = await fixture.adapter.validateConnection({
        connection: managementConnection('available', 'valid'),
        credentials: credential
      });
      expect(result).toMatchObject({
        state: 'unavailable',
        credentialState: 'invalid',
        safeCode: 'authentication_failed'
      });
    }
  );

  it('maps business code 1102 to a valid credential on an unavailable account', async () => {
    const fixture = probeFixture();
    fixture.transport.responses.push(jsonResponse({
      code: 1102,
      message: 'resource pack exhausted',
      request_id: 'request-probe-balance',
      data: { resource_pack_subscribe_infos: [] }
    }));
    const result = await fixture.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    });
    expect(result).toMatchObject({
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'valid',
      safeCode: 'account_unavailable',
      observedAt
    });
  });

  it('maps rate limiting and network failures to verification_unavailable', async () => {
    const limited = probeFixture();
    limited.transport.responses.push(jsonResponse({}, 429));
    await expect(limited.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    })).resolves.toMatchObject({
      state: 'unavailable',
      credentialState: 'verification_unavailable',
      safeCode: 'rate_limited'
    });

    const offline = probeFixture();
    offline.transport.failures.push(new KlingTransportFailure('network'));
    await expect(offline.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    })).resolves.toMatchObject({
      state: 'unavailable',
      credentialState: 'verification_unavailable',
      safeCode: 'network_error'
    });
  });

  it('rejects malformed envelopes without retrying the account', async () => {
    const fixture = probeFixture();
    fixture.transport.responses.push(jsonResponse({
      code: 0,
      message: 'success',
      request_id: 'request-probe-shape',
      data: [],
      extra: 'not allowed'
    }));
    await expect(fixture.adapter.validateConnection({
      connection: managementConnection('available', 'valid'),
      credentials: credential
    })).resolves.toMatchObject({
      state: 'unavailable',
      credentialState: 'verification_unavailable',
      safeCode: 'kling.invalid_response'
    });
    expect(fixture.transport.requests).toHaveLength(1);
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
  const logs: KlingSafeLogEvent[] = [];
  const runtime = new KlingSharedRuntime({
    transport,
    logger: (event) => logs.push(event),
    defaultTimeoutMs: 10_000,
    now: () => 1_000
  });
  return {
    transport,
    logs,
    adapter: new KlingManagementAdapter(runtime, () => observedAt)
  };
}

class SyntheticProbeTransport implements KlingHttpTransport {
  readonly requests: KlingHttpTransportRequest[] = [];
  readonly responses: KlingHttpTransportResponse[] = [];
  readonly failures: unknown[] = [];

  async send(request: KlingHttpTransportRequest): Promise<KlingHttpTransportResponse> {
    this.requests.push({
      ...request,
      headers: { ...request.headers },
      body: Uint8Array.from(request.body)
    });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const response = this.responses.shift();
    if (!response) throw new Error('Synthetic Kling response is missing');
    return response;
  }
}

function managementConnection(
  state: ProviderConnection['state'],
  credentialState: ProviderConnection['credentialState']
): ProviderConnection {
  return createProviderConnection({
    id: toConnectionId('connection-kling-probe'),
    providerId: toProviderId('provider-kling-probe'),
    name: 'Kling probe',
    endpoint: `${KLING_OFFICIAL_BASE_URL}/`,
    packageId: KLING_PROVIDER_PACKAGE_ID,
    packageVersion: KLING_PROVIDER_PACKAGE_VERSION,
    templateId: KLING_OFFICIAL_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: KLING_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-kling-probe',
    connectionPolicyId: 'connection.kling.official',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.kling.manual-exact',
    discoveryPolicyRevision: 1,
    endpointPolicyId: KLING_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-kling-probe',
    connectionRevision: 1,
    adapterBindings: [{
      adapterId: KLING_VIDEO_ADAPTER_ID,
      adapterVersion: KLING_VIDEO_ADAPTER_VERSION,
      protocolId: KLING_VIDEO_PROTOCOL_ID,
      protocolVersion: KLING_VIDEO_PROTOCOL_VERSION
    }],
    state,
    identityState: 'unverified',
    credentialState,
    createdAt: observedAt,
    updatedAt: observedAt
  });
}

function jsonResponse(value: unknown, status = 200): KlingHttpTransportResponse {
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
