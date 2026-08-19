import { describe, expect, it } from 'vitest';
import { isAutosaveDiagnosticsEvent } from '../../src/shared/autosave-diagnostics-ipc';

const validEvent = {
  surface: 'image_generation',
  draftId: 'image-draft-1234-abcd',
  phase: 'retrying',
  hasInFlight: false,
  hasPending: true,
  retryAttempt: 2,
  errorCode: 'workspace_storage_error'
} as const;

describe('autosave diagnostics IPC contract', () => {
  it('accepts only bounded operational metadata', () => {
    expect(isAutosaveDiagnosticsEvent(validEvent)).toBe(true);
    expect(isAutosaveDiagnosticsEvent({
      ...validEvent,
      surface: 'video_generation',
      draftId: 'video-draft-1234-abcd',
      phase: 'saved',
      retryAttempt: 0,
      errorCode: undefined
    })).toBe(true);
  });

  it.each([
    ['prompt', 'private prompt'],
    ['path', 'C:\\private\\input.png'],
    ['token', 'secret-token'],
    ['parameterValues', { seed: 123 }]
  ])('rejects the extra %s field instead of logging it', (field, value) => {
    expect(isAutosaveDiagnosticsEvent({
      ...validEvent,
      [field]: value
    })).toBe(false);
  });

  it('rejects unbounded identities, retry counts and error codes', () => {
    expect(isAutosaveDiagnosticsEvent({
      ...validEvent,
      draftId: 'C:\\private\\draft.json'
    })).toBe(false);
    expect(isAutosaveDiagnosticsEvent({
      ...validEvent,
      retryAttempt: 6
    })).toBe(false);
    expect(isAutosaveDiagnosticsEvent({
      ...validEvent,
      errorCode: 'contains private details'
    })).toBe(false);
  });
});
