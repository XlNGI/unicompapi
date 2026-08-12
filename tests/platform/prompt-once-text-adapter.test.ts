import { describe, expect, it } from 'vitest';
import {
  createProviderExecutionRouteSnapshot,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toUsageSchemaId
} from '../../src/domain';
import {
  DEEPSEEK_CHAT_ADAPTER_ID,
  DEEPSEEK_CHAT_ADAPTER_VERSION,
  DEEPSEEK_CONSTRAINT_SET_ID,
  DEEPSEEK_ENDPOINT_POLICY_ID,
  DEEPSEEK_PROVIDER_PACKAGE_ID,
  DEEPSEEK_PROVIDER_PACKAGE_VERSION,
  DEEPSEEK_REASONING_PARAMETER_SCHEMA_ID,
  DEEPSEEK_RESULT_SCHEMA_ID,
  DEEPSEEK_USAGE_SCHEMA_ID,
  NEWAPI_ADAPTER_VERSION,
  NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_CHAT_RESULT_SCHEMA_ID,
  NEWAPI_CHAT_USAGE_SCHEMA_ID,
  NEWAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID,
  NEWAPI_ENDPOINT_POLICY_ID,
  NEWAPI_PROVIDER_PACKAGE_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION,
  NEWAPI_TEXT_CONSTRAINT_SET_ID,
  UNICOMPAPI_ENDPOINT_POLICY_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
  newApiDefaultTextReasoningParameterSchema,
  parsePromptOnceCompletion,
  parsePromptOnceResponse,
  serializePromptOnceRequest,
  validatePromptOnceRoute
} from '../../src/platform';

describe('prompt_once text adapter contract', () => {
  it('serializes one complete reasoning prompt with stream disabled', () => {
    const body = JSON.parse(new TextDecoder().decode(
      serializePromptOnceRequest(route(), 'Complete prompt', {
        max_tokens: 256,
        reasoning_effort: 'high'
      })
    ));
    expect(body).toEqual({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Complete prompt' }],
      max_tokens: 256,
      reasoning_effort: 'high',
      stream: false,
      thinking: { type: 'enabled' }
    });
    expect(body).not.toHaveProperty('stream_options');
    expect(() => serializePromptOnceRequest(openAiRoute(), 'Complete prompt', {
      n: 2
    })).toThrow('can only control output length and reasoning effort');
  });

  it('parses one ordinary JSON completion and rejects streamed envelopes', () => {
    const response = new TextEncoder().encode(JSON.stringify({
      id: 'completion-1',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-v4-flash',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Enhanced prompt' }
      }]
    }));
    expect(parsePromptOnceResponse(response, 'deepseek-v4-flash'))
      .toBe('Enhanced prompt');
    expect(() => parsePromptOnceResponse(
      new TextEncoder().encode(JSON.stringify({
        object: 'chat.completion.chunk',
        choices: []
      })),
      'deepseek-v4-flash'
    )).toThrow('shape is invalid');
    expect(() => parsePromptOnceResponse(
      new TextEncoder().encode(JSON.stringify({
        object: 'chat.completion',
        model: 'deepseek-v4-flash',
        choices: [{
          index: 0,
          finish_reason: 'length',
          message: { role: 'assistant', content: 'Truncated prompt' }
        }]
      })),
      'deepseek-v4-flash'
    )).toThrow('finish reason is invalid');
  });

  it('maps ordinary JSON usage without retaining the raw response', () => {
    const completion = parsePromptOnceCompletion(
      new TextEncoder().encode(JSON.stringify({
        object: 'chat.completion',
        model: 'reasoning-model',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Enhanced prompt' }
        }],
        usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 }
      })),
      'reasoning-model',
      'openai_compatible'
    );
    expect(completion).toEqual({
      content: 'Enhanced prompt',
      usageStatus: 'reported',
      usageFacts: [
        { metricId: 'completion_tokens', quantity: '5', unit: 'token', source: 'provider_body' },
        { metricId: 'prompt_tokens', quantity: '8', unit: 'token', source: 'provider_body' },
        { metricId: 'total_tokens', quantity: '13', unit: 'token', source: 'provider_body' }
      ]
    });
  });

  it('rejects route identity and response contract changes before dispatch', () => {
    const valid = route();
    for (const changed of [
      { ...valid, packageVersion: '9.0.0' },
      { ...valid, endpointPolicyId: 'endpoint.deepseek.changed' },
      { ...valid, parameterSchemaRevision: 2 },
      { ...valid, resultSchemaId: 'results.changed' },
      { ...valid, usageSchemaRevision: 2 },
      { ...valid, constraintSetRevision: 2 }
    ]) {
      expect(() => validatePromptOnceRoute(changed)).toThrow('route mismatch');
    }
  });

  it('accepts the current NewAPI and UniCompAPI reasoning route revisions', () => {
    expect(validatePromptOnceRoute(openAiRoute())).toMatchObject({
      packageId: NEWAPI_PROVIDER_PACKAGE_ID,
      parameterSchemaRevision: newApiDefaultTextReasoningParameterSchema.revision
    });
    expect(validatePromptOnceRoute(openAiRoute(true))).toMatchObject({
      packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
      endpointPolicyId: UNICOMPAPI_ENDPOINT_POLICY_ID
    });
  });
});

function route() {
  return createProviderExecutionRouteSnapshot({
    id: toProviderExecutionRouteSnapshotId('route-prompt-once'),
    projectId: toProjectId('project-prompt-once'),
    packageId: DEEPSEEK_PROVIDER_PACKAGE_ID,
    packageVersion: DEEPSEEK_PROVIDER_PACKAGE_VERSION,
    adapterKey: DEEPSEEK_CHAT_ADAPTER_ID,
    adapterVersion: DEEPSEEK_CHAT_ADAPTER_VERSION,
    providerId: toProviderId('provider-prompt-once'),
    connectionId: toConnectionId('connection-prompt-once'),
    connectionRevision: 1,
    connectionConfigVersionId: 'connection-config-prompt-once',
    endpointPolicyId: DEEPSEEK_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    credentialVersionId: 'credential-version-prompt-once',
    modelId: toModelId('model-prompt-once'),
    providerModelKey: 'deepseek-v4-flash',
    modelRevision: 1,
    profileId: 'profile-prompt-once',
    profileRevision: 1,
    protocolBindingId: toProtocolBindingId('protocol-binding-prompt-once'),
    protocolBindingRevision: 1,
    productFeature: 'text_reasoning',
    internalPurpose: 'text_execution',
    featureMappingVersion: 1,
    parameterSchemaId: DEEPSEEK_REASONING_PARAMETER_SCHEMA_ID,
    parameterSchemaRevision: 1,
    resultSchemaId: DEEPSEEK_RESULT_SCHEMA_ID,
    resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId(DEEPSEEK_USAGE_SCHEMA_ID),
    usageSchemaRevision: 1,
    constraintSetId: DEEPSEEK_CONSTRAINT_SET_ID,
    constraintSetRevision: 1,
    runtimePolicyId: 'runtime.prompt-once',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: 'claim-prompt-once',
    createdAt: toIsoTimestamp('2026-08-12T00:00:00.000Z')
  });
}

function openAiRoute(unicomp = false) {
  return createProviderExecutionRouteSnapshot({
    ...route(),
    id: toProviderExecutionRouteSnapshotId(
      unicomp ? 'route-prompt-once-unicompapi' : 'route-prompt-once-newapi'
    ),
    packageId: unicomp ? UNICOMPAPI_PROVIDER_PACKAGE_ID : NEWAPI_PROVIDER_PACKAGE_ID,
    packageVersion: unicomp
      ? UNICOMPAPI_PROVIDER_PACKAGE_VERSION
      : NEWAPI_PROVIDER_PACKAGE_VERSION,
    adapterKey: NEWAPI_CHAT_ADAPTER_ID,
    adapterVersion: NEWAPI_ADAPTER_VERSION,
    endpointPolicyId: unicomp ? UNICOMPAPI_ENDPOINT_POLICY_ID : NEWAPI_ENDPOINT_POLICY_ID,
    providerModelKey: 'reasoning-model',
    parameterSchemaId: NEWAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID,
    parameterSchemaRevision: newApiDefaultTextReasoningParameterSchema.revision,
    resultSchemaId: NEWAPI_CHAT_RESULT_SCHEMA_ID,
    usageSchemaId: toUsageSchemaId(NEWAPI_CHAT_USAGE_SCHEMA_ID),
    constraintSetId: NEWAPI_TEXT_CONSTRAINT_SET_ID
  });
}
