import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { ProxyMode } from '../../domain';

export type ControlledProviderTransportMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE';

export interface ControlledProviderTransportRequest<
  Method extends ControlledProviderTransportMethod =
    ControlledProviderTransportMethod
> {
  readonly method: Method;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly proxy: ProxyMode;
  readonly redirect: 'manual';
  readonly dnsRebindingProtection: 'required';
  readonly endpointSecurity?: {
    readonly allowedOrigin?: string;
    readonly allowLoopback: boolean;
    readonly allowPrivateNetwork: boolean;
  };
}

export interface ControlledProviderTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ControlledProviderTransport<
  Method extends ControlledProviderTransportMethod =
    ControlledProviderTransportMethod
> {
  send(
    request: ControlledProviderTransportRequest<Method>
  ): Promise<ControlledProviderTransportResponse>;
}

export interface ControlledProviderResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface ControlledProviderDnsResolver {
  resolve(hostname: string): Promise<readonly ControlledProviderResolvedAddress[]>;
}

export class NodeControlledProviderDnsResolver implements ControlledProviderDnsResolver {
  async resolve(hostname: string): Promise<readonly ControlledProviderResolvedAddress[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => ({
      address,
      family: family === 6 ? 6 : 4
    }));
  }
}

export interface ControlledProviderTransportExecution {
  readonly request: ControlledProviderTransportRequest;
  readonly target: {
    readonly origin: string;
    readonly hostname: string;
    readonly port: number;
    readonly addresses: readonly ControlledProviderResolvedAddress[];
  };
}

export interface ControlledProviderTransportExecutorResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | AsyncIterable<Uint8Array>;
}

export interface ControlledProviderTransportExecutor {
  execute(
    input: ControlledProviderTransportExecution
  ): Promise<ControlledProviderTransportExecutorResponse>;
}

export type ControlledProviderTransportErrorCode =
  | 'invalid_request'
  | 'dns_unavailable'
  | 'endpoint_address_denied'
  | 'timeout'
  | 'cancelled'
  | 'response_too_large'
  | 'network_error';

export class ControlledProviderTransportError extends Error {
  constructor(readonly code: ControlledProviderTransportErrorCode) {
    super(`Controlled provider transport failed: ${code}`);
    this.name = 'ControlledProviderTransportError';
  }
}

/**
 * Resolves and freezes the complete target address set before an executor can
 * open a connection. Executors must connect only to one of target.addresses.
 */
export class GuardedControlledProviderTransport<
  Method extends ControlledProviderTransportMethod = ControlledProviderTransportMethod
> implements ControlledProviderTransport<Method> {
  constructor(
    private readonly dns: ControlledProviderDnsResolver,
    private readonly executor: ControlledProviderTransportExecutor
  ) {}

  async send(
    request: ControlledProviderTransportRequest<Method>
  ): Promise<ControlledProviderTransportResponse> {
    const validated = validateRequest(request);
    if (request.signal.aborted) {
      throw new ControlledProviderTransportError('cancelled');
    }
    const addresses = await this.resolveAddresses(validated.url.hostname);
    validateAddresses(addresses, request.endpointSecurity);

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, request.timeoutMs);
    try {
      const response = await this.executor.execute({
        request: {
          ...request,
          headers: { ...request.headers },
          ...(request.body ? { body: Uint8Array.from(request.body) } : {}),
          signal: controller.signal
        },
        target: {
          origin: validated.url.origin,
          hostname: validated.url.hostname,
          port: validated.port,
          addresses: addresses.map((address) => ({ ...address }))
        }
      });
      return {
        status: validateStatus(response.status),
        headers: validateHeaders(response.headers),
        body: await readBounded(response.body, request.maxResponseBytes, controller)
      };
    } catch (error) {
      if (error instanceof ControlledProviderTransportError) throw error;
      if (request.signal.aborted) {
        throw new ControlledProviderTransportError('cancelled');
      }
      if (controller.signal.aborted) {
        throw new ControlledProviderTransportError('timeout');
      }
      throw new ControlledProviderTransportError('network_error');
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', abort);
    }
  }

  private async resolveAddresses(
    hostname: string
  ): Promise<readonly ControlledProviderResolvedAddress[]> {
    const literalFamily = isIP(hostname);
    if (literalFamily === 4 || literalFamily === 6) {
      return [{ address: hostname, family: literalFamily }];
    }
    try {
      const resolved = await this.dns.resolve(hostname);
      const unique = new Map<string, ControlledProviderResolvedAddress>();
      for (const item of resolved) {
        if (isIP(item.address) !== item.family) {
          throw new ControlledProviderTransportError('dns_unavailable');
        }
        unique.set(`${item.family}:${item.address.toLowerCase()}`, {
          address: item.address,
          family: item.family
        });
      }
      if (unique.size === 0) {
        throw new ControlledProviderTransportError('dns_unavailable');
      }
      return [...unique.values()];
    } catch (error) {
      if (error instanceof ControlledProviderTransportError) throw error;
      throw new ControlledProviderTransportError('dns_unavailable');
    }
  }
}

function validateRequest(request: ControlledProviderTransportRequest): {
  readonly url: URL;
  readonly port: number;
} {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new ControlledProviderTransportError('invalid_request');
  }
  const allowedOrigin = request.endpointSecurity?.allowedOrigin;
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    request.redirect !== 'manual' ||
    request.dnsRebindingProtection !== 'required' ||
    (allowedOrigin !== undefined && url.origin !== allowedOrigin) ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    !Number.isSafeInteger(request.maxResponseBytes) ||
    request.maxResponseBytes < 1 ||
    (request.body !== undefined && request.body.byteLength > 64 * 1024 * 1024)
  ) {
    throw new ControlledProviderTransportError('invalid_request');
  }
  validateHeaders(request.headers);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ControlledProviderTransportError('invalid_request');
  }
  return { url, port };
}

function validateAddresses(
  addresses: readonly ControlledProviderResolvedAddress[],
  security: ControlledProviderTransportRequest['endpointSecurity']
): void {
  for (const address of addresses) {
    const classification = classifyAddress(address);
    const allowed = classification === 'public' ||
      (classification === 'loopback' && security?.allowLoopback === true) ||
      (classification === 'private' && security?.allowPrivateNetwork === true);
    if (!allowed) {
      throw new ControlledProviderTransportError('endpoint_address_denied');
    }
  }
}

function classifyAddress(
  address: ControlledProviderResolvedAddress
): 'public' | 'private' | 'loopback' {
  if (address.family === 4) {
    if (loopbackIpv4Addresses.check(address.address, 'ipv4')) return 'loopback';
    return nonPublicIpv4Addresses.check(address.address, 'ipv4') ? 'private' : 'public';
  }
  if (loopbackIpv6Addresses.check(address.address, 'ipv6')) return 'loopback';
  return nonPublicIpv6Addresses.check(address.address, 'ipv6') ? 'private' : 'public';
}

const loopbackIpv4Addresses = new BlockList();
loopbackIpv4Addresses.addSubnet('127.0.0.0', 8, 'ipv4');
const loopbackIpv6Addresses = new BlockList();
loopbackIpv6Addresses.addAddress('::1', 'ipv6');

const nonPublicIpv4Addresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  nonPublicIpv4Addresses.addSubnet(address, prefix, 'ipv4');
}
const nonPublicIpv6Addresses = new BlockList();
for (const [address, prefix] of [
  ['::', 128],
  ['::ffff:0:0', 96],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  nonPublicIpv6Addresses.addSubnet(address, prefix, 'ipv6');
}

function validateStatus(status: number): number {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    throw new ControlledProviderTransportError('network_error');
  }
  return status;
}

function validateHeaders(
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ||
      typeof value !== 'string' ||
      value.length > 65_536 ||
      /[\r\n\0]/.test(value)
    ) {
      throw new ControlledProviderTransportError('invalid_request');
    }
    result[name.toLowerCase()] = value;
  }
  return result;
}

async function readBounded(
  source: Uint8Array | AsyncIterable<Uint8Array>,
  maximumBytes: number,
  controller: AbortController
): Promise<Uint8Array> {
  if (source instanceof Uint8Array) {
    if (source.byteLength > maximumBytes) {
      controller.abort();
      throw new ControlledProviderTransportError('response_too_large');
    }
    return Uint8Array.from(source);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) {
      throw new ControlledProviderTransportError('network_error');
    }
    total += chunk.byteLength;
    if (total > maximumBytes) {
      controller.abort();
      throw new ControlledProviderTransportError('response_too_large');
    }
    chunks.push(Uint8Array.from(chunk));
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
