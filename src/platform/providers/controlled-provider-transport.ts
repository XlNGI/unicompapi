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
