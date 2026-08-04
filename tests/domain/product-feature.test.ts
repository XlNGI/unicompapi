import { describe, expect, it } from 'vitest';
import {
  productFeatureToInternalPurpose,
  productFeatures,
  projectParameterSchema,
  validateParameterSchemaV2,
  validateParameterValues,
  validateProductFeatureRequest,
  type ParameterSchemaV2
} from '../../src/domain';

const schema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: 'schema-image-v2',
  revision: 1,
  productFeature: 'text_to_image',
  fields: [
    {
      fieldId: 'prompt',
      labelId: 'prompt.label',
      order: 0,
      valueType: 'string',
      exposure: 'user_required',
      defaultPolicy: 'require_user_value',
      required: true
    },
    {
      fieldId: 'aspect_ratio',
      labelId: 'aspect_ratio.label',
      order: 1,
      valueType: 'enum',
      exposure: 'user_optional',
      defaultPolicy: 'omit_use_provider_default',
      required: false,
      options: ['1:1', '16:9']
    },
    {
      fieldId: 'model_internal',
      labelId: 'model_internal.label',
      order: 2,
      valueType: 'string',
      exposure: 'internal',
      defaultPolicy: 'derive_in_adapter',
      required: false,
      secret: true
    }
  ]
};

describe('ProductFeature and ParameterSchema V2 contracts', () => {
  it('freezes the product feature list and explicit internal-purpose mapping', () => {
    expect(productFeatures).toEqual([
      'text_chat',
      'text_reasoning',
      'image_understanding',
      'image_to_prompt',
      'text_to_image',
      'reference_to_image',
      'image_edit',
      'text_to_video',
      'image_to_video'
    ]);
    expect(productFeatureToInternalPurpose('text_to_image')).toBe('image_generation');
    expect(productFeatureToInternalPurpose('image_to_video')).toBe('reference_to_video');
    expect(productFeatureToInternalPurpose('text_chat')).toBe('text_execution');
  });

  it('projects required-only and full fields without inventing defaults or exposing internals', () => {
    expect(projectParameterSchema(schema, 'required_only').fields.map((field) => field.fieldId))
      .toEqual(['prompt']);
    expect(projectParameterSchema(schema, 'full').fields.map((field) => field.fieldId))
      .toEqual(['prompt', 'aspect_ratio']);
    expect(validateParameterValues(schema, 'required_only', { prompt: 'hello' }))
      .toEqual({ prompt: 'hello' });
    expect(validateParameterValues(schema, 'full', { prompt: 'hello' }))
      .toEqual({ prompt: 'hello' });
  });

  it('rejects missing, unknown, invalid and quick-page optional parameters', () => {
    expect(() => validateParameterValues(schema, 'required_only', {})).toThrow('missing');
    expect(() => validateParameterValues(schema, 'required_only', {
      prompt: 'hello',
      aspect_ratio: '1:1'
    })).toThrow('not part');
    expect(() => validateParameterValues(schema, 'full', {
      prompt: 'hello',
      aspect_ratio: '4:3'
    })).toThrow('invalid value');
    expect(() => validateParameterValues(schema, 'full', {
      prompt: 'hello',
      model_internal: 'should-not-be-accepted'
    })).toThrow('not part');
  });

  it('rejects unsafe schema exposure and invalid versions', () => {
    expect(() => validateParameterSchemaV2({
      ...schema,
      schemaVersion: 1 as never
    })).toThrow('metadata');
    expect(() => validateParameterSchemaV2({
      ...schema,
      fields: [{
        ...schema.fields[0],
        exposure: 'user_required',
        required: false
      }]
    })).toThrow('explicit value');
    expect(() => validateParameterSchemaV2({
      ...schema,
      fields: [{
        ...schema.fields[0],
        exposure: 'internal',
        defaultPolicy: 'omit_use_provider_default'
      }]
    })).toThrow('adapter-derived');
  });

  it('validates optional display metadata without exposing internal controls', () => {
    const displayed = validateParameterSchemaV2({
      ...schema,
      revision: 2,
      fields: schema.fields.map((field) => field.fieldId === 'aspect_ratio'
        ? {
            ...field,
            display: {
              label: '画面比例',
              description: '决定生成图片的宽高关系。',
              groupLabel: '画面',
              note: '不选择时使用服务商默认值。',
              optionLabels: [
                { value: '1:1', label: '方形' },
                { value: '16:9', label: '宽屏' }
              ],
              visibleWhen: {
                fieldId: 'prompt',
                operator: 'not_equals' as const,
                value: ''
              }
            }
          }
        : field)
    });
    expect(projectParameterSchema(displayed, 'full')).toMatchObject({
      revision: 2,
      fields: [
        { fieldId: 'prompt' },
        { fieldId: 'aspect_ratio', display: { label: '画面比例' } }
      ]
    });
    expect(projectParameterSchema(displayed, 'full').fields).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldId: 'model_internal' })])
    );
    expect(() => validateParameterSchemaV2({
      ...schema,
      fields: schema.fields.map((field) => field.fieldId === 'aspect_ratio'
        ? { ...field, display: { description: 'x'.repeat(501) } }
        : field)
    })).toThrow('display text');
    expect(() => validateParameterSchemaV2({
      ...schema,
      fields: schema.fields.map((field) => field.fieldId === 'aspect_ratio'
        ? {
            ...field,
            display: { optionLabels: [{ value: '4:3', label: '旧电视' }] }
          }
        : field)
    })).toThrow('option display');
    expect(() => validateParameterSchemaV2({
      ...schema,
      fields: schema.fields.map((field) => field.fieldId === 'aspect_ratio'
        ? {
            ...field,
            display: {
              visibleWhen: {
                fieldId: 'model_internal',
                operator: 'equals' as const,
                value: 'hidden'
              }
            }
          }
        : field)
    })).toThrow('unavailable field');
  });

  it('enforces pure-text quick image and quick video boundaries', () => {
    expect(() => validateProductFeatureRequest({
      productFeature: 'text_to_image',
      surface: 'quick',
      imageCount: 0,
      contextCount: 0
    })).not.toThrow();
    expect(() => validateProductFeatureRequest({
      productFeature: 'text_to_video',
      surface: 'quick',
      videoCount: 0,
      contextCount: 0
    })).not.toThrow();
    expect(() => validateProductFeatureRequest({
      productFeature: 'text_to_image',
      surface: 'quick',
      imageCount: 1
    })).toThrow('reference media');
    expect(() => validateProductFeatureRequest({
      productFeature: 'text_to_video',
      surface: 'quick',
      imageCount: 1
    })).toThrow('reference media');
    expect(() => validateProductFeatureRequest({
      productFeature: 'text_to_image',
      surface: 'quick',
      contextCount: 1
    })).toThrow('conversation context');
  });

  it('enforces professional reference and single-image constraints', () => {
    expect(() => validateProductFeatureRequest({
      productFeature: 'reference_to_image',
      surface: 'professional',
      imageCount: 1
    })).not.toThrow();
    expect(() => validateProductFeatureRequest({
      productFeature: 'image_to_video',
      surface: 'professional',
      imageCount: 1
    })).not.toThrow();
    expect(() => validateProductFeatureRequest({
      productFeature: 'image_to_video',
      surface: 'professional',
      imageCount: 0
    })).toThrow('exactly one');
    expect(() => validateProductFeatureRequest({
      productFeature: 'image_to_video',
      surface: 'professional',
      imageCount: 2
    })).toThrow('exactly one');
    expect(() => validateProductFeatureRequest({
      productFeature: 'reference_to_image',
      surface: 'quick',
      imageCount: 1
    })).toThrow();
  });

  it('keeps image understanding, image-to-prompt and image editing distinct', () => {
    for (const productFeature of ['image_understanding', 'image_to_prompt', 'image_edit'] as const) {
      expect(() => validateProductFeatureRequest({
        productFeature,
        surface: 'professional',
        imageCount: 1
      })).not.toThrow();
      expect(() => validateProductFeatureRequest({
        productFeature,
        surface: 'professional',
        imageCount: 2
      })).toThrow('exactly one');
    }
  });
});
