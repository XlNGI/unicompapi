import { describe, expect, it } from 'vitest';
import {
  capabilityStates,
  createModelCapabilityEvidence,
  createProvider,
  createProviderConnection,
  createProviderModel,
  createRoutingPreference,
  toCapabilityEvidenceId,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProviderId,
  toRoutingPreferenceId
} from '../../src/domain';

const timestamp = toIsoTimestamp('2026-07-22T00:00:00.000Z');

describe('provider domain contracts', () => {
  it('keeps the seven required capability states', () => {
    expect(capabilityStates).toEqual([
      'verified_supported',
      'declared_supported',
      'user_confirmed',
      'unknown',
      'unsupported',
      'verification_failed',
      'restricted'
    ]);
  });

  it('creates provider, connection, model, evidence, and routing facts separately', () => {
    const provider = createProvider({
      id: toProviderId('provider-local'),
      name: 'Local provider',
      accessCategory: 'local',
      identityState: 'unverified',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const connection = createProviderConnection({
      id: toConnectionId('connection-local'),
      providerId: provider.id,
      name: 'Local connection',
      endpoint: 'http://127.0.0.1',
      state: 'saved',
      identityState: 'unverified',
      credentialState: 'not_configured',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const model = createProviderModel({
      id: toModelId('model-local'),
      providerId: provider.id,
      connectionId: connection.id,
      name: 'local-model-id',
      displayName: 'Local model',
      enabled: false,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const evidence = createModelCapabilityEvidence({
      id: toCapabilityEvidenceId('capability-local'),
      modelId: model.id,
      capability: 'image_generation',
      state: 'unknown',
      source: 'provider_declared',
      updatedAt: timestamp
    });
    const routing = createRoutingPreference({
      id: toRoutingPreferenceId('routing-local'),
      purpose: 'image_generation',
      modelId: model.id,
      priority: 0,
      enabled: false,
      updatedAt: timestamp
    });

    expect(connection.state).toBe('saved');
    expect(evidence.state).toBe('unknown');
    expect(routing.enabled).toBe(false);
  });
});
