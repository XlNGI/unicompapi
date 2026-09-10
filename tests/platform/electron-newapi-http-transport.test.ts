import { net } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronNewApiHttpTransport } from '../../electron/ipc/management-adapters';
import {
  createProviderConnection,
  toConnectionId,
  toIsoTimestamp,
  toProviderId
} from '../../src/domain';
import {
  NEWAPI_COMPATIBLE_TEMPLATE_ID,
  NEWAPI_CREDENTIAL_SCHEMA_ID,
  NEWAPI_ENDPOINT_POLICY_ID,
  NEWAPI_PROVIDER_PACKAGE_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION,
  NewApiSharedRuntime,
  newApiProviderPackageDescriptor,
  type NewApiHttpTransportRequest,
  type NewApiSafeLogEvent
} from '../../src/platform';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

const encoder = new TextEncoder();
const syntheticCredential = 'synthetic-offline-credential';

beforeEach(() => vi.mocked(net.fetch).mockReset());

function request(maxResponseBytes = 1024): NewApiHttpTransportRequest {
  return {
    method: 'POST',
    url: 'https://gateway.example.test/v1/chat/completions',
    headers: { accept: 'text/event-stream' },
    body: encoder.encode('{"stream":true}'),
    signal: new AbortController().signal,
    timeoutMs: 1000,
    maxRequestBytes: 1024,
    maxResponseBytes,
    proxy: { kind: 'system_default' },
    redirect: 'manual',
    endpointSecurity: {
      allowedOrigin: 'https://gateway.example.test',
      allowPrivateNetwork: false,
      dnsRebindingProtection: 'required'
    }
  };
}

function connection() {
  const timestamp = toIsoTimestamp('2026-09-10T00:00:00.000Z');
  return createProviderConnection({
    id: toConnectionId('connection-transport-test'),
    providerId: toProviderId('provider-transport-test'),
    name: 'Synthetic transport',
    endpoint: 'https://gateway.example.test/v1',
    packageId: NEWAPI_PROVIDER_PACKAGE_ID,
    packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
    templateId: NEWAPI_COMPATIBLE_TEMPLATE_ID,
    templateKind: 'compatible_custom',
    credentialSchemaId: NEWAPI_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-transport-test',
    connectionPolicyId: 'connection.newapi.compatible',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.newapi.models',
    discoveryPolicyRevision: 1,
    endpointPolicyId: NEWAPI_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-transport-test',
    connectionRevision: 1,
    adapterBindings: newApiProviderPackageDescriptor.adapters.map((adapter) => ({
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      protocolId: adapter.protocolId,
      protocolVersion: adapter.protocolVersion
    })),
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: 'credential-reference-transport-test',
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

describe('Electron NewAPI chat transport', () => {
  it.each([400, 403])('buffers the HTTP %s error body even when the request asks for SSE', async (status) => {
    const body = JSON.stringify({ error: { code: 'invalid_request_error', param: 'messages' } });
    vi.mocked(net.fetch).mockResolvedValue(new Response(body, {
      status,
      headers: { 'content-type': 'application/json' }
    }));

    const response = await new ElectronNewApiHttpTransport().send(request());

    expect(response.status).toBe(status);
    expect(response.stream).toBeUndefined();
    expect(new TextDecoder().decode(response.body)).toBe(body);
  });

  it.each([
    { status: 400, code: 'invalid_request_error', expected: 'invalid_request' },
    { status: 403, code: 'permission_denied', expected: 'permission_denied' },
    { status: 400, code: 'model_not_found', expected: 'model_not_found' },
    { status: 400, code: 'bad_response_status_code', expected: 'upstream_rejected' }
  ])('classifies HTTP $status $code and logs only controlled upstream fields', async ({ status, code, expected }) => {
    const rawMessage = `Private prompt and attachment contents; ${syntheticCredential}`;
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({
      error: { code, type: 'invalid_request_error', param: 'messages', message: rawMessage }
    }), {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'Req-Transport-Test' }
    }));
    const logs: NewApiSafeLogEvent[] = [];
    const runtime = new NewApiSharedRuntime({
      transport: new ElectronNewApiHttpTransport(),
      logger: (event) => logs.push(event)
    });

    try {
      await expect(runtime.openChatStream({
        connection: connection(),
        credentials: {
          schemaId: NEWAPI_CREDENTIAL_SCHEMA_ID,
          schemaVersion: 1,
          values: { api_key: syntheticCredential }
        },
        body: encoder.encode('{"model":"synthetic-model","stream":true}')
      })).rejects.toMatchObject({ code: expected });

      const failed = logs.find((entry) => entry.event === 'request_failed');
      expect(failed).toMatchObject({
        operation: 'chat_stream',
        status,
        errorCode: expected,
        upstreamCode: code,
        upstreamType: 'invalid_request_error',
        upstreamParam: 'messages',
        requestId: 'req-transport-test'
      });
      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain(rawMessage);
      expect(serialized).not.toContain(syntheticCredential);
      expect(serialized).not.toContain('gateway.example.test');
      expect(serialized).not.toContain('synthetic-model');
      expect(runtime.activeRequestCount).toBe(0);
    } finally {
      runtime.dispose();
    }
  });

  it('returns an HTTP 200 stream before its response body completes', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; }
    });
    vi.mocked(net.fetch).mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }));

    const response = await new ElectronNewApiHttpTransport().send(request());

    expect(response.body).toBeUndefined();
    expect(response.stream).toBeDefined();
    const chunks: Uint8Array[] = [];
    const consume = (async () => {
      for await (const chunk of response.stream!) chunks.push(chunk);
    })();
    controller.enqueue(encoder.encode('data: first\n\n'));
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
    await consume;
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe('data: first\n\ndata: [DONE]\n\n');
  });

  it.each(['declared', 'received'] as const)('bounds %s error response bytes before returning a body', async (mode) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('oversized-response')); },
      cancel
    });
    vi.mocked(net.fetch).mockResolvedValue(new Response(body, {
      status: 400,
      headers: {
        'content-type': 'application/json',
        ...(mode === 'declared' ? { 'content-length': '18' } : {})
      }
    }));

    await expect(new ElectronNewApiHttpTransport().send(request(8)))
      .rejects.toMatchObject({ kind: 'response_too_large' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
