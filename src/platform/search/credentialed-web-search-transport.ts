import type { ProxyMode, StructuredCredentialRecord } from '../../domain';
import {
  CredentialNotFoundError,
  CredentialPayloadKindError,
  CredentialUnreadableError,
  CredentialVaultUnavailableError,
  type SecureCredentialVault
} from '../providers/credential-vault';
import {
  ControlledProviderTransportError,
  type ControlledProviderTransport
} from '../providers/controlled-provider-transport';
import {
  WebSearchTransportError,
  type WebSearchTransport,
  type WebSearchTransportResult
} from './web-research';

export interface WebSearchCredentialPort {
  useCredential<T>(operation: (credential: string) => Promise<T>): Promise<T>;
}

export class SecureVaultWebSearchCredentialPort implements WebSearchCredentialPort {
  constructor(
    private readonly vault: SecureCredentialVault,
    private readonly credentialReference: string,
    private readonly fieldKey: string
  ) {}

  async useCredential<T>(operation: (credential: string) => Promise<T>): Promise<T> {
    try {
      return await this.vault.useRecord(
        this.credentialReference,
        async (record) => operation(readCredentialField(record, this.fieldKey))
      );
    } catch (error) {
      if (
        error instanceof CredentialNotFoundError ||
        error instanceof CredentialPayloadKindError ||
        error instanceof CredentialUnreadableError ||
        error instanceof CredentialVaultUnavailableError
      ) {
        throw new WebSearchTransportError('credential_unavailable');
      }
      throw error;
    }
  }
}

export interface WebSearchProviderAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly endpointOrigin: string;
  createRequest(input: {
    readonly query: string;
    readonly allowedDomains: readonly string[];
    readonly maxResults: number;
    readonly credential: string;
  }): {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: Uint8Array;
  };
  parseResponse(input: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  }): readonly WebSearchTransportResult[];
}

export class CredentialedWebSearchTransport implements WebSearchTransport {
  constructor(private readonly options: {
    readonly transport: ControlledProviderTransport<'GET' | 'POST'>;
    readonly credentials: WebSearchCredentialPort;
    readonly adapter: WebSearchProviderAdapter;
    readonly proxy: () => Promise<ProxyMode> | ProxyMode;
    readonly timeoutMs?: number;
    readonly maxResponseBytes?: number;
  }) {
    requireHttpsOrigin(options.adapter.endpointOrigin);
  }

  async search(input: {
    readonly query: string;
    readonly allowedDomains: readonly string[];
    readonly maxResults: number;
    readonly signal: AbortSignal;
  }): Promise<readonly WebSearchTransportResult[]> {
    try {
      return await this.options.credentials.useCredential(async (credential) => {
        const request = this.options.adapter.createRequest({
          query: input.query,
          allowedDomains: input.allowedDomains,
          maxResults: input.maxResults,
          credential
        });
        const endpoint = new URL(request.path, this.options.adapter.endpointOrigin);
        if (endpoint.origin !== this.options.adapter.endpointOrigin || endpoint.protocol !== 'https:') {
          throw new WebSearchTransportError('invalid_request');
        }
        const response = await this.options.transport.send({
          method: request.method,
          url: endpoint.toString(),
          headers: request.headers,
          ...(request.body ? { body: request.body } : {}),
          signal: input.signal,
          timeoutMs: this.options.timeoutMs ?? 15_000,
          maxResponseBytes: this.options.maxResponseBytes ?? 1_000_000,
          proxy: await this.options.proxy(),
          redirect: 'manual',
          dnsRebindingProtection: 'required',
          endpointSecurity: {
            allowedOrigin: this.options.adapter.endpointOrigin,
            allowLoopback: false,
            allowPrivateNetwork: false
          }
        });
        if (response.status === 401 || response.status === 403) {
          throw new WebSearchTransportError('authentication_failed');
        }
        if (response.status === 429) {
          throw new WebSearchTransportError('rate_limited');
        }
        if (response.status < 200 || response.status >= 300) {
          throw new WebSearchTransportError('network_error');
        }
        try {
          return this.options.adapter.parseResponse(response);
        } catch (error) {
          if (error instanceof WebSearchTransportError) throw error;
          throw new WebSearchTransportError('response_invalid');
        }
      });
    } catch (error) {
      if (error instanceof WebSearchTransportError) throw error;
      if (error instanceof ControlledProviderTransportError) {
        throw new WebSearchTransportError(mapControlledTransportFailure(error.code));
      }
      throw new WebSearchTransportError('network_error');
    }
  }
}

export class UnconfiguredWebSearchTransport implements WebSearchTransport {
  async search(): Promise<readonly WebSearchTransportResult[]> {
    throw new WebSearchTransportError('provider_unconfigured');
  }
}

function requireHttpsOrigin(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Web search endpoint origin is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('Web search endpoint must be a fixed HTTPS origin');
  }
}

function readCredentialField(record: StructuredCredentialRecord, fieldKey: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fieldKey)) {
    throw new WebSearchTransportError('credential_unavailable');
  }
  const value = record.values[fieldKey];
  if (!value) throw new WebSearchTransportError('credential_unavailable');
  return value;
}

function mapControlledTransportFailure(
  code: ControlledProviderTransportError['code']
): ConstructorParameters<typeof WebSearchTransportError>[0] {
  if (code === 'endpoint_address_denied') return 'dns_unavailable';
  return code;
}
