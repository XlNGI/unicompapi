export const autosaveDiagnosticsIpcChannel = 'autosave-diagnostics:record';

export interface AutosaveDiagnosticsEventDto {
  readonly surface: 'image_generation' | 'video_generation';
  readonly draftId: string;
  readonly phase:
    | 'saved'
    | 'pending'
    | 'saving'
    | 'retrying'
    | 'failed'
    | 'conflict';
  readonly hasInFlight: boolean;
  readonly hasPending: boolean;
  readonly retryAttempt: number;
  readonly errorCode?: string;
}

export interface AutosaveDiagnosticsApi {
  record(event: AutosaveDiagnosticsEventDto): void;
}

export function isAutosaveDiagnosticsEvent(
  value: unknown
): value is AutosaveDiagnosticsEventDto {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'surface',
    'draftId',
    'phase',
    'hasInFlight',
    'hasPending',
    'retryAttempt',
    'errorCode'
  ]);
  if (Object.keys(event).some((key) => !allowedKeys.has(key))) return false;
  return (
    (event.surface === 'image_generation' || event.surface === 'video_generation') &&
    typeof event.draftId === 'string' &&
    event.draftId.length > 0 &&
    event.draftId.length <= 128 &&
    /^(?:image-draft|draft-quick|video-draft)-[a-zA-Z0-9-]+$/.test(event.draftId) &&
    ['saved', 'pending', 'saving', 'retrying', 'failed', 'conflict']
      .includes(String(event.phase)) &&
    typeof event.hasInFlight === 'boolean' &&
    typeof event.hasPending === 'boolean' &&
    Number.isInteger(event.retryAttempt) &&
    Number(event.retryAttempt) >= 0 &&
    Number(event.retryAttempt) <= 5 &&
    (event.errorCode === undefined ||
      (typeof event.errorCode === 'string' &&
        /^[a-z][a-z0-9_]{0,63}$/.test(event.errorCode)))
  );
}
