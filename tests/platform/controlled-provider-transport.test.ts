import { describe, expect, it, vi } from 'vitest';
import {
  ControlledProviderTransportError,
  GuardedControlledProviderTransport,
  type ControlledProviderDnsResolver,
  type ControlledProviderTransportExecutor,
  type ControlledProviderTransportRequest
} from '../../src/platform';

describe('guarded controlled provider transport', () => {
  it('freezes the complete public DNS set before a bounded synthetic execution', async () => {
    const dns: ControlledProviderDnsResolver = {
      resolve: vi.fn(async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '8.8.8.8', family: 4 }
      ] as const)
    };
    const executions: Parameters<ControlledProviderTransportExecutor['execute']>[0][] = [];
    const executor: ControlledProviderTransportExecutor = {
      async execute(input) {
        executions.push(input);
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: chunks(new Uint8Array([1, 2]), new Uint8Array([3]))
        };
      }
    };
    const transport = new GuardedControlledProviderTransport(dns, executor);

    await expect(transport.send(request())).resolves.toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array([1, 2, 3])
    });
    expect(dns.resolve).toHaveBeenCalledWith('provider.example');
    expect(executions).toHaveLength(1);
    expect(executions[0].target).toEqual({
      origin: 'https://provider.example',
      hostname: 'provider.example',
      port: 443,
      addresses: [
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 }
      ]
    });
    expect(executions[0].request.signal).not.toBe(request().signal);
  });

  it('fails closed on any rebinding address before the executor can observe credentials', async () => {
    const executor = syntheticExecutor();
    const transport = new GuardedControlledProviderTransport(
      resolver([
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 }
      ]),
      executor
    );

    await expect(transport.send(request())).rejects.toMatchObject({
      code: 'endpoint_address_denied',
      message: 'Controlled provider transport failed: endpoint_address_denied'
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('allows explicit loopback or private policy while keeping literal targets DNS-free', async () => {
    const dns = resolver([]);
    const executor = syntheticExecutor();
    const transport = new GuardedControlledProviderTransport(dns, executor);

    await transport.send(request({
      url: 'http://127.0.0.1:8787/v1/models',
      endpointSecurity: {
        allowedOrigin: 'http://127.0.0.1:8787',
        allowLoopback: true,
        allowPrivateNetwork: false
      }
    }));
    expect(dns.resolve).not.toHaveBeenCalled();
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        addresses: [{ address: '127.0.0.1', family: 4 }]
      })
    }));

    const privateTransport = new GuardedControlledProviderTransport(
      resolver([{ address: '10.20.30.40', family: 4 }]),
      syntheticExecutor()
    );
    await expect(privateTransport.send(request({
      endpointSecurity: {
        allowedOrigin: 'https://provider.example',
        allowLoopback: false,
        allowPrivateNetwork: true
      }
    }))).resolves.toMatchObject({ status: 204 });
  });

  it('bounds responses and maps cancellation, timeout and executor details to safe codes', async () => {
    const oversized = new GuardedControlledProviderTransport(
      resolver([{ address: '8.8.4.4', family: 4 }]),
      {
        async execute() {
          return {
            status: 200,
            headers: {},
            body: chunks(new Uint8Array([1, 2]), new Uint8Array([3, 4]))
          };
        }
      }
    );
    await expect(oversized.send(request({ maxResponseBytes: 3 })))
      .rejects.toMatchObject({ code: 'response_too_large' });

    const cancelledController = new AbortController();
    cancelledController.abort();
    await expect(oversized.send(request({ signal: cancelledController.signal })))
      .rejects.toMatchObject({ code: 'cancelled' });

    const timeout = new GuardedControlledProviderTransport(
      resolver([{ address: '8.8.4.4', family: 4 }]),
      {
        execute(input) {
          return new Promise((_resolve, reject) => {
            input.request.signal.addEventListener('abort', () => {
              reject(new Error('private path C:\\secret and bearer value'));
            }, { once: true });
          });
        }
      }
    );
    await expect(timeout.send(request({ timeoutMs: 5 }))).rejects.toEqual(
      new ControlledProviderTransportError('timeout')
    );

    const failed = new GuardedControlledProviderTransport(
      resolver([{ address: '8.8.4.4', family: 4 }]),
      {
        async execute() {
          throw new Error('private path C:\\secret and bearer value');
        }
      }
    );
    await expect(failed.send(request())).rejects.toEqual(
      new ControlledProviderTransportError('network_error')
    );
  });
});

function request(
  overrides: Partial<ControlledProviderTransportRequest> = {}
): ControlledProviderTransportRequest {
  return {
    method: 'POST',
    url: 'https://provider.example/v1/generate',
    headers: {
      authorization: 'synthetic-credential',
      'content-type': 'application/json'
    },
    body: new Uint8Array([123, 125]),
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    maxResponseBytes: 1024,
    proxy: { kind: 'direct' },
    redirect: 'manual',
    dnsRebindingProtection: 'required',
    endpointSecurity: {
      allowedOrigin: 'https://provider.example',
      allowLoopback: false,
      allowPrivateNetwork: false
    },
    ...overrides
  };
}

function resolver(
  addresses: readonly { readonly address: string; readonly family: 4 | 6 }[]
): ControlledProviderDnsResolver & { resolve: ReturnType<typeof vi.fn> } {
  return { resolve: vi.fn(async () => addresses) };
}

function syntheticExecutor(): ControlledProviderTransportExecutor & {
  execute: ReturnType<typeof vi.fn>;
} {
  return {
    execute: vi.fn(async () => ({
      status: 204,
      headers: {},
      body: new Uint8Array()
    }))
  };
}

async function* chunks(...values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}
