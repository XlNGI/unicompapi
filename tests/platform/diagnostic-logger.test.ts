import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettingsValues } from '../../src/domain';
import {
  DiagnosticsService,
  diagnosticErrorName,
  normalizeDiagnosticEvent,
  toChatBlockedDiagnostic,
  toProviderDiagnostic
} from '../../src/platform';
import { FeatureSubmissionError } from '../../src/platform/providers/provider-feature-candidates';
import { RuntimeAuthorizationDeniedError } from '../../src/platform/providers/runtime-authorization-ledger';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('diagnostic event catalog', () => {
  it('keeps only allowlisted codes and scalar facts', () => {
    expect(normalizeDiagnosticEvent({
      code: 'provider.request_failed',
      facts: {
        operation: 'chat_stream',
        method: 'POST',
        status: 400,
        errorCode: 'newapi.invalid_response',
        elapsedMs: 12.6,
        requestBytes: 128,
        prompt: 'secret user prompt',
        token: 'sk-live-secret',
        path: 'C:\\\\Users\\\\Developer\\\\file.txt'
      }
    })).toEqual({
      code: 'provider.request_failed',
      category: 'networkErrors',
      level: 'error',
      facts: {
        operation: 'chat_stream',
        method: 'POST',
        status: 400,
        errorCode: 'newapi.invalid_response',
        elapsedMs: 13,
        requestBytes: 128
      }
    });
    expect(normalizeDiagnosticEvent({
      code: 'provider.request_started',
      facts: { operation: 'https://example.invalid/v1/chat', method: 'DELETE' }
    })).toEqual({
      code: 'provider.request_started',
      category: 'application',
      level: 'debug',
      facts: {}
    });
    expect(normalizeDiagnosticEvent({
      code: 'chat.request_blocked',
      facts: { reason: 'candidate_unavailable' }
    })?.facts).toEqual({ reason: 'candidate_unavailable' });
  });

  it('maps provider and chat gate errors without copying messages', () => {
    expect(toProviderDiagnostic({
      event: 'request_failed',
      operation: 'chat_stream',
      method: 'POST',
      status: 401,
      errorCode: 'unauthorized',
      elapsedMs: 8
    })).toMatchObject({
      code: 'provider.request_failed',
      facts: { operation: 'chat_stream', errorCode: 'unauthorized', status: 401 }
    });
    const blocked = toChatBlockedDiagnostic(
      new FeatureSubmissionError('candidate_unavailable', 'C:\\\\Users\\\\Developer\\\\secret.txt')
    );
    expect(blocked).toEqual({
      code: 'chat.request_blocked',
      facts: { reason: 'candidate_unavailable' }
    });
    expect(JSON.stringify(blocked)).not.toMatch(/Users|secret/i);
    expect(toChatBlockedDiagnostic(
      new RuntimeAuthorizationDeniedError('policy_blocked', 'authorization denied')
    )).toEqual({
      code: 'chat.request_blocked',
      facts: { reason: 'runtime_not_allowed' }
    });
    expect(toChatBlockedDiagnostic(new TypeError('bad json'))).toBeUndefined();
    expect(diagnosticErrorName(new FeatureSubmissionError('candidate_unavailable', 'hidden')))
      .toBe('FeatureSubmissionError');
  });

  it('writes structured events into the matching local log file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-diagnostic-'));
    roots.push(root);
    const service = new DiagnosticsService(root, () => '2026-09-24T00:00:00.000Z');
    const settings = createDefaultSettingsValues().diagnostics;
    await expect(service.writeEvent({
      code: 'chat.request_blocked',
      facts: { reason: 'candidate_unavailable', prompt: 'do not persist' }
    }, settings)).resolves.toEqual({ written: true, rotated: false });
    await expect(service.writeEvent({
      code: 'provider.request_started',
      facts: { operation: 'chat_stream', method: 'POST' }
    }, { ...settings, level: 'info' })).resolves.toEqual({ written: false, rotated: false });
    await expect(service.writeEvent({
      code: 'process.uncaught_exception',
      facts: { name: 'Error' }
    }, {
      ...settings,
      categories: { ...settings.categories, crashDiagnostics: false }
    })).resolves.toEqual({ written: false, rotated: false });
    const line = await readFile(path.join(root, 'logs', 'application.log'), 'utf8');
    expect(JSON.parse(line)).toEqual({
      at: '2026-09-24T00:00:00.000Z',
      category: 'application',
      level: 'warn',
      code: 'chat.request_blocked',
      facts: { reason: 'candidate_unavailable' }
    });
    expect(line).not.toMatch(/prompt|do not persist/i);
  });
});
