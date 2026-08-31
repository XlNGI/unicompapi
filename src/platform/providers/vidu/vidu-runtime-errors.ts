export const viduRuntimeErrorCodes = [
  'invalid_request',
  'protocol_mismatch',
  'endpoint_not_allowed',
  'insecure_transport',
  'credential_unavailable',
  'authentication_failed',
  'permission_denied',
  'credit_insufficient',
  'rate_limited',
  'provider_unavailable',
  'timeout',
  'cancelled',
  'response_too_large',
  'redirect_not_allowed',
  'invalid_response',
  'network_error',
  'proxy_unavailable',
  'runtime_shutting_down'
] as const;

export type ViduRuntimeErrorCode = (typeof viduRuntimeErrorCodes)[number];

export class ViduRuntimeError extends Error {
  constructor(
    readonly code: ViduRuntimeErrorCode,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown',
    readonly retryAfterMs?: number
  ) {
    super(messageForCode(code));
    this.name = 'ViduRuntimeError';
  }
}

export class ViduTransportFailure extends Error {
  constructor(
    readonly kind:
      | 'network'
      | 'timeout'
      | 'cancelled'
      | 'proxy_unavailable'
      | 'response_too_large'
  ) {
    super('Vidu transport failed');
    this.name = 'ViduTransportFailure';
  }
}

function messageForCode(code: ViduRuntimeErrorCode): string {
  const messages: Record<ViduRuntimeErrorCode, string> = {
    invalid_request: 'The Vidu request is invalid',
    protocol_mismatch: 'The Vidu protocol binding does not match the request',
    endpoint_not_allowed: 'The Vidu endpoint is not allowed',
    insecure_transport: 'The Vidu request requires HTTPS',
    credential_unavailable: 'The Vidu credential is unavailable',
    authentication_failed: 'Vidu authentication failed',
    permission_denied: 'Vidu denied this operation',
    credit_insufficient: 'Vidu credits are insufficient',
    rate_limited: 'Vidu rate limited the operation',
    provider_unavailable: 'Vidu is temporarily unavailable',
    timeout: 'The Vidu request timed out',
    cancelled: 'The Vidu request was cancelled',
    response_too_large: 'The Vidu response exceeded the allowed size',
    redirect_not_allowed: 'The Vidu API response redirected unexpectedly',
    invalid_response: 'The Vidu response was invalid',
    network_error: 'The Vidu network request failed',
    proxy_unavailable: 'The configured proxy could not be used',
    runtime_shutting_down: 'The Vidu runtime is shutting down'
  };
  return messages[code];
}
