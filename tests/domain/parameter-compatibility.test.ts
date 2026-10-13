import { describe, expect, it } from 'vitest';
import { buildCompatibleParameterSchema, mapCompatibleParameterValues, parseModelApiContractBinding,
  type ModelApiContractBindingV1, type ParameterSchemaV2 } from '../../src/domain';

const base: ParameterSchemaV2 = {
  schemaVersion: 2, schemaId: 'parameters.synthetic.official', revision: 1, productFeature: 'text_chat', fields: [
    { fieldId: 'output_limit', labelId: 'output_limit', order: 10, valueType: 'integer', minimum: 1, maximum: 8192,
      exposure: 'user_optional', defaultPolicy: 'omit_use_provider_default', required: false },
    { fieldId: 'effort', labelId: 'effort', order: 20, valueType: 'enum', options: ['low', 'medium', 'high'],
      exposure: 'user_optional', defaultPolicy: 'omit_use_provider_default', required: false },
    { fieldId: 'thinking', labelId: 'thinking', order: 30, valueType: 'boolean',
      exposure: 'user_optional', defaultPolicy: 'omit_use_provider_default', required: false }
  ]
};
const binding = (rules: ModelApiContractBindingV1['rules']): ModelApiContractBindingV1 => ({
  schemaVersion: 1, contractId: 'contract.synthetic.official', contractRevision: 1, rules
});

describe('declarative parameter compatibility foundation', () => {
  it('uses the same narrowed schema for validation and deterministic field/enum mapping', () => {
    const configuration = binding([
      { fieldId: 'output_limit', maximum: 2048, targetPath: ['relay_limit'] },
      { fieldId: 'effort', options: ['low', 'high'], enumMappings: [{ from: 'low', to: 'small' }, { from: 'high', to: 'large' }] },
      { fieldId: 'thinking', targetPath: ['vendor', 'thinking'] }
    ]);
    const schema = buildCompatibleParameterSchema(base, configuration);
    const values = { output_limit: 1024, effort: 'high', thinking: false };
    expect(mapCompatibleParameterValues(schema, configuration, values)).toEqual({ relay_limit: 1024, effort: 'large', vendor: { thinking: false } });
    expect(() => mapCompatibleParameterValues(schema, configuration, { output_limit: 2049 })).toThrow();
    expect(() => mapCompatibleParameterValues(schema, configuration, { effort: 'medium' })).toThrow();
    expect(base.fields[0].maximum).toBe(8192);
    expect(values).toEqual({ output_limit: 1024, effort: 'high', thinking: false });
  });
  it('omits unsupported optional fields from UI schema and rejects supplied stale values', () => {
    const configuration = binding([{ fieldId: 'thinking', unsupported: true }]);
    const schema = buildCompatibleParameterSchema(base, configuration);
    expect(schema.fields.some(field => field.fieldId === 'thinking')).toBe(false);
    expect(mapCompatibleParameterValues(schema, configuration, {})).toEqual({});
    expect(() => mapCompatibleParameterValues(schema, configuration, { thinking: true })).toThrowError(expect.objectContaining({ code: 'unsupported_parameter' }));
  });
  it.each([
    [{ fieldId: 'output_limit', minimum: 0 }],
    [{ fieldId: 'output_limit', maximum: 8193 }],
    [{ fieldId: 'effort', options: ['invented'] }],
    [{ fieldId: 'effort', enumMappings: [{ from: 'low', to: 'small' }] }],
    [{ fieldId: 'not_declared', unsupported: true }]
  ])('rejects ungrounded widening or incomplete compatibility rules (%j)', rule => {
    expect(() => buildCompatibleParameterSchema(base, binding([rule]))).toThrow();
  });
  it.each(['model', 'tools', 'headers', 'authorization', '__proto__', 'constructor'])('rejects reserved mapping target %s', target => {
    expect(() => parseModelApiContractBinding(binding([{ fieldId: 'output_limit', targetPath: [target] }]))).toThrow();
  });
  it('rejects mappings with overlapping nested paths before dispatch', () => {
    expect(() => buildCompatibleParameterSchema(base, binding([
      { fieldId: 'output_limit', targetPath: ['vendor'] }, { fieldId: 'thinking', targetPath: ['vendor', 'thinking'] }
    ]))).toThrowError(expect.objectContaining({ code: 'mapping_conflict' }));
  });
  it('does not remove required parameters or add arbitrary execution rules', () => {
    const required = { ...base, fields: [{ ...base.fields[0], exposure: 'user_required' as const, required: true }] };
    expect(() => buildCompatibleParameterSchema(required, binding([{ fieldId: 'output_limit', unsupported: true }]))).toThrow();
    expect(() => parseModelApiContractBinding({ ...binding([]), script: 'anything' })).toThrow();
    expect(() => parseModelApiContractBinding(binding(Array.from({ length: 65 }, (_, index) => ({ fieldId: `field${index}` }))))).toThrow();
  });
  it('keeps provider defaults omitted and applies the one-result product projection separately', () => {
    const official = { ...base, fields: [{ ...base.fields[0], fieldId: 'n', minimum: 1, maximum: 8 }] };
    const configuration = binding([]);
    const schema = buildCompatibleParameterSchema(official, configuration);
    expect(official.fields[0].maximum).toBe(8);
    expect(schema.fields[0].maximum).toBe(1);
    expect(mapCompatibleParameterValues(schema, configuration, {})).toEqual({});
    expect(() => mapCompatibleParameterValues(schema, configuration, { n: 2 })).toThrow();
  });
});
