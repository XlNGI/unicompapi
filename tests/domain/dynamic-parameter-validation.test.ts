import { describe, expect, it } from 'vitest';
import {
  validateDynamicParameterValue,
  validateDynamicParameterValues,
  type DynamicParameterField
} from '../../src/components/dynamic-parameter-validation';

const requiredSize: DynamicParameterField = {
  fieldId: 'size',
  labelId: 'provider.parameter.size',
  valueType: 'enum',
  required: true,
  options: ['1024x1024']
};

describe('dynamic parameter validation', () => {
  it('requires visible required fields without rejecting valid false and zero', () => {
    expect(validateDynamicParameterValue(requiredSize, undefined)).toContain('必填');
    expect(validateDynamicParameterValues([
      { fieldId: 'audio', labelId: 'audio', valueType: 'boolean', required: true },
      { fieldId: 'seed', labelId: 'seed', valueType: 'integer', required: true, minimum: 0 }
    ], { audio: false, seed: 0 }).valid).toBe(true);
  });

  it('rejects invalid numeric arrays and range violations before submit', () => {
    expect(validateDynamicParameterValue({
      fieldId: 'frames', labelId: 'frames', valueType: 'number_array', required: false,
      minimum: 1, maximum: 10
    }, [1, Number.NaN])).toContain('有效数字');
    expect(validateDynamicParameterValue({
      fieldId: 'duration', labelId: 'duration', valueType: 'integer', required: true,
      minimum: 3, maximum: 15
    }, 2)).toContain('不能小于');
  });

  it('accepts a valid enum and plain object', () => {
    expect(validateDynamicParameterValues([
      requiredSize,
      { fieldId: 'metadata', labelId: 'metadata', valueType: 'object', required: false }
    ], { size: '1024x1024', metadata: { source: 'ui' } }).valid).toBe(true);
  });
});
