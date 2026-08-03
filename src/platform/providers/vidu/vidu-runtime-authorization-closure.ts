export const VIDU_RUNTIME_AUTHORIZATION_CLOSED_MESSAGE =
  'Vidu runtime authorization is closed until a formal authorization contract is approved';

export class ViduRuntimeAuthorizationClosedError extends Error {
  readonly code = 'runtime_authorization_closed' as const;

  constructor() {
    super(VIDU_RUNTIME_AUTHORIZATION_CLOSED_MESSAGE);
    this.name = 'ViduRuntimeAuthorizationClosedError';
  }
}

/**
 * The historical live-validation flow is a capability record, not runtime
 * authorization. Keep the old channel closed until the authorization ledger
 * contract exists; callers must fail before constructing an HTTP request.
 */
export function denyViduRuntimeAuthorization(): void {
  throw new ViduRuntimeAuthorizationClosedError();
}
