import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProviderConnection,
  toIsoTimestamp,
  toProviderId,
  type ProxyMode
} from '../../src/domain';
import {
  SecureCredentialVault,
  ViduProviderPackage,
  ViduSharedRuntime,
  ViduTransportFailure,
  type CredentialProtector,
  type ViduHttpTransport,
  type ViduHttpTransportRequest,
  type ViduHttpTransportResponse,
  type ViduSafeLogEvent
} from '../../src/platform';
import { createUserViduRegistryRecords } from '../fixtures/vidu-user-registry';

const roots: string[] = [];
const token = 'synthetic-token-that-must-never-be-logged';

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('ViduSharedRuntime', () => {
  it('accepts a clean-registry provider ID while rejecting a foreign binding', async () => {
    const fixture = await createFixture();
    const runtime = runtimeFor(fixture);
    expect(fixture.connection.providerId).not.toBe('provider-vidu');
    fixture.transport.responses.push(response(200, { data: [] }));

    await expect(
      runtime.request({
        connection: fixture.connection,
        binding: fixture.imageBinding,
        method: 'POST',
        path: '/ent/v1/images/generations',
        authScheme: 'bearer'
      })
    ).resolves.toMatchObject({ status: 200 });

    await expect(
      runtime.request({
        connection: fixture.connection,
        binding: {
          ...fixture.imageBinding,
          providerId: toProviderId('provider-foreign')
        },
        method: 'POST',
        path: '/ent/v1/images/generations',
        authScheme: 'bearer'
      })
    ).rejects.toMatchObject({ code: 'protocol_mismatch' });
    expect(fixture.transport.requests).toHaveLength(1);
  });

  it('uses the credential only inside the vault callback and emits path-free safe logs', async () => {
    const fixture = await createFixture();
    const logs: ViduSafeLogEvent[] = [];
    fixture.transport.responses.push(response(200, { credits: 1 }));
    const runtime = runtimeFor(fixture, { logger: (event) => logs.push(event) });

    const result = await runtime.request({
      connection: fixture.connection,
      method: 'GET',
      path: '/ent/v2/credits',
      authScheme: 'token'
    });

    expect(result.status).toBe(200);
    expect(fixture.transport.requests[0].headers.authorization).toBe(
      `Token ${token}`
    );
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(token);
    expect(serializedLogs).not.toContain('Authorization');
    expect(serializedLogs).not.toContain('api.vidu.cn');
    expect(serializedLogs).not.toContain('/ent/v2/credits');
    expect(serializedLogs).not.toContain('credits');
  });

  it('rejects insecure, foreign and cross-protocol endpoints before transport', async () => {
    const fixture = await createFixture();
    const runtime = runtimeFor(fixture);
    const foreign = createProviderConnection({
      ...fixture.connection,
      endpoint: 'https://foreign.invalid'
    });
    await expect(
      runtime.request({
        connection: foreign,
        method: 'GET',
        path: '/ent/v2/credits',
        authScheme: 'token'
      })
    ).rejects.toMatchObject({ code: 'endpoint_not_allowed' });
    const insecure = createProviderConnection({
      ...fixture.connection,
      endpoint: 'http://api.vidu.cn'
    });
    await expect(
      runtime.request({
        connection: insecure,
        method: 'GET',
        path: '/ent/v2/credits',
        authScheme: 'token'
      })
    ).rejects.toMatchObject({ code: 'insecure_transport' });
    await expect(
      runtime.request({
        connection: fixture.connection,
        binding: fixture.imageBinding,
        method: 'POST',
        path: '/ent/v2/reference2video',
        authScheme: 'none'
      })
    ).rejects.toMatchObject({ code: 'endpoint_not_allowed' });
    expect(fixture.transport.requests).toHaveLength(0);
  });

  it('propagates the controlled proxy, timeout and cancellation policy', async () => {
    const fixture = await createFixture();
    const proxy: ProxyMode = {
      kind: 'custom',
      protocol: 'https',
      host: 'proxy.synthetic.invalid',
      port: 8443,
      authenticationConfigured: true
    };
    fixture.transport.failures.push(new ViduTransportFailure('timeout'));
    const runtime = runtimeFor(fixture, { proxy: () => proxy });
    await expect(
      runtime.request({
        connection: fixture.connection,
        method: 'GET',
        path: '/ent/v2/credits',
        authScheme: 'token',
        timeoutMs: 4321
      })
    ).rejects.toMatchObject({ code: 'timeout', retryability: 'retryable' });
    expect(fixture.transport.requests[0]).toMatchObject({
      proxy,
      timeoutMs: 4321,
      redirect: 'manual'
    });

    fixture.transport.waitForAbort = true;
    await expect(
      runtime.request({
        connection: fixture.connection,
        method: 'GET',
        path: '/ent/v2/credits',
        authScheme: 'token',
        timeoutMs: 5
      })
    ).rejects.toMatchObject({ code: 'timeout', retryability: 'retryable' });
    const request = runtime.request({
      connection: fixture.connection,
      method: 'GET',
      path: '/ent/v2/credits',
      authScheme: 'token',
      timeoutMs: 5000
    });
    await Promise.resolve();
    expect(runtime.activeRequestCount).toBe(1);
    runtime.dispose();
    await expect(request).rejects.toMatchObject({ code: 'cancelled' });
    expect(runtime.activeRequestCount).toBe(0);
    await expect(
      runtime.request({
        connection: fixture.connection,
        method: 'GET',
        path: '/ent/v2/credits',
        authScheme: 'token'
      })
    ).rejects.toMatchObject({ code: 'runtime_shutting_down' });
  });

  it('rejects redirects and oversized responses and preserves rate-limit facts', async () => {
    const fixture = await createFixture();
    const runtime = runtimeFor(fixture);
    fixture.transport.responses.push({
      status: 302,
      headers: { location: 'https://signed.invalid/secret?token=value' },
      body: new Uint8Array()
    });
    await expect(credits(runtime, fixture)).rejects.toMatchObject({
      code: 'redirect_not_allowed'
    });
    fixture.transport.responses.push({
      status: 200,
      headers: { 'content-length': '999' },
      body: new Uint8Array([1])
    });
    await expect(
      runtime.request({
        connection: fixture.connection,
        method: 'GET',
        path: '/ent/v2/credits',
        authScheme: 'token',
        maxResponseBytes: 8
      })
    ).rejects.toMatchObject({ code: 'response_too_large' });
    fixture.transport.responses.push({
      status: 429,
      headers: { 'retry-after': '3' },
      body: bytes({ internal: 'must not escape' })
    });
    await expect(credits(runtime, fixture)).rejects.toMatchObject({
      code: 'rate_limited',
      retryability: 'retryable',
      retryAfterMs: 3000,
      message: 'Vidu rate limited the operation'
    });
  });

  it('does not compare encoded wire length with a decoded response body', async () => {
    const fixture = await createFixture();
    const runtime = runtimeFor(fixture);
    const body = bytes({ credits: 1 });
    fixture.transport.responses.push({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': '8'
      },
      body
    });

    await expect(credits(runtime, fixture)).resolves.toMatchObject({
      status: 200,
      body
    });
  });

  it('validates the connection through credits without exposing the response', async () => {
    const fixture = await createFixture();
    fixture.transport.responses.push(response(200, {
      balance: 'private-synthetic-account-fact'
    }));
    const packageRuntime = new ViduProviderPackage({
      credentialVault: fixture.vault,
      transport: fixture.transport
    });
    await expect(
      packageRuntime.connectionValidation.validate(fixture.connection)
    ).resolves.toEqual({
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid',
      observedAt: expect.any(String)
    });
    expect(JSON.stringify(fixture.transport.requests[0])).not.toContain(
      'private-synthetic-account-fact'
    );

    fixture.transport.responses.push(response(401, { error: 'bad token' }));
    await expect(
      packageRuntime.connectionValidation.validate(fixture.connection)
    ).resolves.toMatchObject({
      state: 'unavailable',
      identityState: 'verification_failed',
      credentialState: 'invalid'
    });
    packageRuntime.dispose();
  });

  it('reads production structured_record tokens for authenticated requests', async () => {
    const fixture = await createStructuredFixture();
    fixture.transport.responses.push(response(200, {
      data: [{ url: 'https://cdn.example.com/result.png' }]
    }));
    const runtime = runtimeFor(fixture);

    await expect(
      runtime.request({
        connection: fixture.connection,
        binding: fixture.imageBinding,
        method: 'POST',
        path: '/ent/v1/images/generations',
        body: new TextEncoder().encode(JSON.stringify({ prompt: 'cat', n: 1 })),
        contentType: 'application/json',
        authScheme: 'bearer',
        maxResponseBytes: 2 * 1024 * 1024
      })
    ).resolves.toMatchObject({ status: 200 });

    expect(fixture.transport.requests[0].headers.authorization).toBe(
      `Bearer ${token}`
    );
  });

  it('maps CreditInsufficient 400 responses to a definitive credit error', async () => {
    const fixture = await createStructuredFixture();
    fixture.transport.responses.push(response(400, {
      code: 400,
      reason: 'CreditInsufficient',
      message: 'insufficient credits',
      metadata: { trace_id: '0123456789abcdef0123456789abcdef' }
    }));
    const runtime = runtimeFor(fixture);

    await expect(
      runtime.request({
        connection: fixture.connection,
        binding: fixture.imageBinding,
        method: 'POST',
        path: '/ent/v1/images/generations',
        body: new TextEncoder().encode(JSON.stringify({ prompt: 'cat', n: 1 })),
        contentType: 'application/json',
        authScheme: 'bearer',
        maxResponseBytes: 2 * 1024 * 1024
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'credit_insufficient',
        message: 'Vidu credits are insufficient'
      })
    );
  });

  it('maps missing credentials and transport failures to stable sanitized errors', async () => {
    const fixture = await createFixture();
    const missingCredential = createProviderConnection({
      ...fixture.connection,
      credentialReference: undefined,
      credentialState: 'not_configured'
    });
    const runtime = runtimeFor(fixture);
    await expect(
      runtime.request({
        connection: missingCredential,
        method: 'GET',
        path: '/ent/v2/credits',
        authScheme: 'token'
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'credential_unavailable',
        message: 'The Vidu credential is unavailable'
      })
    );
    fixture.transport.failures.push(new Error('secret low-level path C:\\private'));
    await expect(credits(runtime, fixture)).rejects.toEqual(
      expect.objectContaining({
        code: 'network_error',
        message: 'The Vidu network request failed'
      })
    );
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vidu-runtime-'));
  roots.push(root);
  const vault = new SecureCredentialVault(
    path.join(root, 'credentials.json'),
    reversibleProtector()
  );
  const credentialReference = 'credential-vidu-runtime';
  await vault.save(credentialReference, token);
  const frozen = createUserViduRegistryRecords();
  const connection = createProviderConnection({
    ...frozen.connections[0],
    endpoint: 'https://api.vidu.cn',
    state: 'saved',
    credentialState: 'saved',
    credentialReference,
    updatedAt: toIsoTimestamp('2026-07-28T12:00:00.000Z')
  });
  return {
    vault,
    transport: new FixtureTransport(),
    connection,
    imageBinding: frozen.protocolBindings[1]
  };
}

async function createStructuredFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vidu-runtime-'));
  roots.push(root);
  const vault = new SecureCredentialVault(
    path.join(root, 'credentials.json'),
    reversibleProtector()
  );
  const credentialReference = 'credential-vidu-runtime-structured';
  await vault.saveRecord(credentialReference, {
    schemaId: 'credential.vidu.token',
    schemaVersion: 1,
    values: { token }
  });
  const frozen = createUserViduRegistryRecords();
  const connection = createProviderConnection({
    ...frozen.connections[0],
    endpoint: 'https://api.vidu.cn',
    state: 'saved',
    credentialState: 'saved',
    credentialReference,
    updatedAt: toIsoTimestamp('2026-07-28T12:00:00.000Z')
  });
  return {
    vault,
    transport: new FixtureTransport(),
    connection,
    imageBinding: frozen.protocolBindings.find(
      (binding) => binding.protocolId === 'vidu.ent.v1.images'
    ) ?? frozen.protocolBindings[1]
  };
}

function runtimeFor(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: Partial<{
    readonly logger: (event: ViduSafeLogEvent) => void;
    readonly proxy: () => ProxyMode;
  }> = {}
) {
  return new ViduSharedRuntime({
    credentialVault: fixture.vault,
    transport: fixture.transport,
    ...overrides
  });
}

function credits(
  runtime: ViduSharedRuntime,
  fixture: Awaited<ReturnType<typeof createFixture>>
) {
  return runtime.request({
    connection: fixture.connection,
    method: 'GET',
    path: '/ent/v2/credits',
    authScheme: 'token'
  });
}

class FixtureTransport implements ViduHttpTransport {
  readonly requests: ViduHttpTransportRequest[] = [];
  readonly responses: ViduHttpTransportResponse[] = [];
  readonly failures: unknown[] = [];
  waitForAbort = false;

  async send(
    request: ViduHttpTransportRequest
  ): Promise<ViduHttpTransportResponse> {
    this.requests.push(request);
    const failure = this.failures.shift();
    if (failure) throw failure;
    if (this.waitForAbort) {
      if (request.signal.aborted) {
        throw new ViduTransportFailure('cancelled');
      }
      return new Promise((_, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(new ViduTransportFailure('cancelled')),
          { once: true }
        );
      });
    }
    return this.responses.shift() ?? response(200, {});
  }
}

function response(
  status: number,
  body: Record<string, unknown>
): ViduHttpTransportResponse {
  const value = bytes(body);
  return {
    status,
    headers: { 'content-type': 'application/json', 'content-length': String(value.length) },
    body: value
  };
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function reversibleProtector(): CredentialProtector {
  return {
    isAvailable: () => true,
    protect: (value) => Buffer.from(value, 'utf8'),
    unprotect: (value) => Buffer.from(value).toString('utf8')
  };
}
