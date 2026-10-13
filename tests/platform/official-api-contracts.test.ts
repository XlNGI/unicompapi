import { describe, expect, it } from 'vitest';
import { getOfficialApiContract, listOfficialApiContracts, officialRequestProperties, officialRequestRequiredParameters, validateOfficialParameterValue, type OfficialApiContract } from '../../src/platform/providers/contracts/official-api-contracts';
import { matchesJsonValueSchema } from '../../src/domain';
import { buildBoundTextParameterSchema, mapBoundTextParameters } from '../../src/platform/providers/contracts/bound-text-contract';

describe('retained official API contracts', () => {
  it('retains source-backed vendor contracts without connection or credential ownership', () => {
    const contracts = listOfficialApiContracts();
    expect(contracts.length).toBeGreaterThanOrEqual(11);
    const deepSeek = getOfficialApiContract('official.deepseek.v4.chat', 1);
    expect(deepSeek.authority).toBe('model_vendor');
    expect(deepSeek.sources.every(source => /^https:\/\//.test(source.url) && /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true);
    expect(officialRequestProperties(deepSeek)).toHaveProperty('max_tokens');
    expect(() => validateOfficialParameterValue(deepSeek, 'max_tokens', 393216)).not.toThrow();
    expect(() => validateOfficialParameterValue(deepSeek, 'max_tokens', 393217)).toThrow();
  });
  it('projects a Kimi contract into one dynamic schema and maps parameters without model-name inference', () => {
    const binding = { schemaVersion: 1 as const, contractId: 'official.moonshot.kimi-k3.chat', contractRevision: 1, rules: [] };
    const schema = buildBoundTextParameterSchema(binding, 'text_reasoning');
    expect(schema.fields.some(field => field.fieldId === 'reasoning_effort')).toBe(true);
    expect(schema.fields.some(field => field.fieldId === 'model')).toBe(false);
    expect(schema.fields.some(field => field.fieldId === 'temperature' || field.fieldId === 'n')).toBe(false);
    expect(() => validateOfficialParameterValue(getOfficialApiContract(binding.contractId, binding.contractRevision), 'n', 2)).toThrow();
    expect(mapBoundTextParameters(binding, 'text_reasoning', { reasoning_effort: 'high' })).toEqual({ reasoning_effort: 'high' });
    expect(() => mapBoundTextParameters(binding, 'text_reasoning', { reasoning_effort: 'medium' })).toThrow();
  });
  it('validates GLM tool choices against the documented auto-only union', () => {
    const binding = { schemaVersion: 1 as const, contractId: 'official.zhipu.glm-5.2.chat', contractRevision: 1, rules: [] };
    expect(mapBoundTextParameters(binding, 'text_chat', { tool_choice: 'auto' })).toEqual({ tool_choice: 'auto' });
    expect(() => mapBoundTextParameters(binding, 'text_chat', { tool_choice: 'required' })).toThrow();
  });
  it('validates nested format and stop values before dispatch', () => {
    const binding = { schemaVersion: 1 as const, contractId: 'official.moonshot.kimi-k3.chat', contractRevision: 1, rules: [] };
    expect(() => mapBoundTextParameters(binding, 'text_chat', { response_format: { type: 'json_schema' } })).toThrow();
    expect(mapBoundTextParameters(binding, 'text_chat', { stop: ['END'] })).toEqual({ stop: ['END'] });
    expect(() => mapBoundTextParameters(binding, 'text_chat', { stop: ['a', 'b', 'c', 'd', 'e', 'f'] })).toThrow();
  });
  it('rejects a changed official contract pin and prevents caller mutation of the retained catalog', () => {
    const binding = { schemaVersion: 1 as const, contractId: 'official.moonshot.kimi-k3.chat', contractRevision: 1, rules: [], contractFingerprint: '0'.repeat(64) };
    expect(() => buildBoundTextParameterSchema(binding, 'text_chat')).toThrow('official_contract_changed');
    const copy = listOfficialApiContracts();
    (copy[0].modelKeys as string[]).push('invented');
    expect(listOfficialApiContracts()[0].modelKeys).not.toContain('invented');
  });

  it('keeps every constraint when the same field occurs in multiple allOf members', () => {
    const contract: OfficialApiContract = { ...getOfficialApiContract('official.deepseek.v4.chat', 1),
      requestSchema: { allOf: [
        { type: 'object', properties: { max_tokens: { type: 'integer', minimum: 1, maximum: 64 } } },
        { type: 'object', properties: { max_tokens: { type: 'integer', maximum: 128 } } }
      ] } };
    const field = officialRequestProperties(contract).max_tokens;
    expect(matchesJsonValueSchema(64, field)).toBe(true);
    expect(matchesJsonValueSchema(65, field)).toBe(false);
    expect(matchesJsonValueSchema(0, field)).toBe(false);
    expect(() => validateOfficialParameterValue(contract, 'max_tokens', 65)).toThrow();
  });

  it('enforces the same documented GLM precision at the vendor and product validation boundaries', () => {
    const contract = getOfficialApiContract('official.zhipu.glm-5.2.chat', 1);
    const binding = { schemaVersion: 1 as const, contractId: contract.id, contractRevision: contract.revision, rules: [] };
    expect(() => validateOfficialParameterValue(contract, 'temperature', 0.12)).not.toThrow();
    expect(() => validateOfficialParameterValue(contract, 'temperature', 0.123)).toThrow();
    expect(() => mapBoundTextParameters(binding, 'text_chat', { temperature: 0.123 })).toThrow();
    expect(mapBoundTextParameters(binding, 'text_chat', { temperature: 0.12 })).toEqual({ temperature: 0.12 });
  });

  it('rejects incompatible Kimi K2.6 forcing and temperature without changing the source contract', () => {
    const contract = getOfficialApiContract('official.moonshot.kimi-k2.6.chat', 1);
    const binding = { schemaVersion: 1 as const, contractId: contract.id, contractRevision: contract.revision, rules: [] };
    expect(() => mapBoundTextParameters(binding, 'text_chat', { tool_choice: 'required' })).toThrow();
    expect(() => mapBoundTextParameters(binding, 'text_chat', { temperature: 0.6 })).toThrow('temperature_thinking_mismatch');
    expect(mapBoundTextParameters(binding, 'text_chat', { thinking: { type: 'disabled' }, temperature: 0.6 }))
      .toEqual({ thinking: { type: 'disabled' }, temperature: 0.6 });
    expect(() => mapBoundTextParameters(binding, 'text_chat', { thinking: { type: 'disabled' }, temperature: 1 })).toThrow();
  });

  it('retains request requirements and response definitions from machine readable official sources', () => {
    const kimi = getOfficialApiContract('official.moonshot.kimi-k3.chat', 1);
    expect([...officialRequestRequiredParameters(kimi)]).toEqual(expect.arrayContaining(['model', 'messages']));
    expect(kimi.responseSchemas?.['application/json']).toHaveProperty('$ref', '#/components/schemas/ChatCompletionResponse');
    expect(kimi.definitions).toHaveProperty('ChatCompletionResponse');
    const h3 = getOfficialApiContract('official.minimax.MiniMax-H3.video', 1);
    expect([...officialRequestRequiredParameters(h3)]).toEqual(expect.arrayContaining(['model', 'content', 'resolution', 'duration']));
    expect(h3.endpointPath).toBe('/v2/video_generation');
    expect(h3.definitions).toHaveProperty('VideoGenerationV2Resp');
  });

  it('enforces thinking and tool forcing together before dispatch', () => {
    const binding = { schemaVersion: 1 as const, contractId: 'official.deepseek.v4.chat', contractRevision: 1, rules: [] };
    expect(() => mapBoundTextParameters(binding, 'text_chat', { tool_choice: 'required' })).toThrow('requires_non_thinking');
    expect(mapBoundTextParameters(binding, 'text_chat', { tool_choice: 'required', thinking: { type: 'disabled' } }))
      .toEqual({ tool_choice: 'required', thinking: { type: 'disabled' } });
    expect(mapBoundTextParameters(binding, 'text_chat', { tool_choice: 'required', reasoning_effort: 'none' }))
      .toEqual({ tool_choice: 'required', reasoning_effort: 'none' });
  });

  it('keeps first-frame and reference-video inputs separate and uses exact vendor model IDs', () => {
    const first = getOfficialApiContract('official.vidu.viduq3-turbo.image-video', 1);
    const reference = getOfficialApiContract('official.vidu.viduq3-turbo.reference-video', 1);
    expect(first.endpointPath).toBe('/ent/v2/img2video');
    expect(() => validateOfficialParameterValue(first, 'images', 'synthetic-image')).not.toThrow();
    expect(() => validateOfficialParameterValue(first, 'images', ['synthetic-image'])).toThrow();
    expect(() => validateOfficialParameterValue(reference, 'images', ['synthetic-image'])).not.toThrow();
    expect(getOfficialApiContract('official.volcengine.seedream-5-lite.image', 1).modelKeys).toContain('doubao-seedream-5-0-260128');
    expect(getOfficialApiContract('official.volcengine.seedance-2.0-fast.video', 1).modelKeys).toContain('doubao-seedance-2-0-fast-260128');
  });
});
