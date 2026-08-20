import { describe, expect, it } from 'vitest';
import {
  isKnownUniCompApiModel,
  uniCompApiModelFeatures,
  uniCompApiTextToImageParameterSchema,
  uniCompApiReferenceToImageParameterSchema,
  uniCompApiSupportsFeature,
  UNICOMPAPI_SEEDREAM_5_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_QWEN_IMAGE_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_QWEN_IMAGE_REFERENCE_TO_IMAGE_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_ID
} from '../../src/platform';

const currentCatalogModels = [
  'deepseek-r1-0528',
  'deepseek-v3',
  'deepseek-v3.2',
  'deepseek-v3.2-exp',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-fast-260128',
  'doubao-seedream-5-0-260128',
  'glm-4.6',
  'glm-4.7',
  'glm-5',
  'glm-5.1',
  'glm-5.2',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'happyhorse-1.0-i2v',
  'happyhorse-1.0-r2v',
  'happyhorse-1.0-t2v',
  'happyhorse-1.0-video-edit',
  'happyhorse-1.1-i2v',
  'happyhorse-1.1-r2v',
  'happyhorse-1.1-t2v',
  'kimi-k2.6',
  'kimi-k3',
  'kling-v3-turbo',
  'qwen-image',
  'qwen-image-edit-2509',
  'qwen3-235b-a22b',
  'qwen3-32b',
  'viduq3',
  'viduq3-mix',
  'viduq3-pro',
  'viduq3-turbo'
] as const;

describe('UniCompAPI model capability registry', () => {
  it('declares every current catalog model explicitly', () => {
    expect(currentCatalogModels.every(isKnownUniCompApiModel)).toBe(true);
    expect(new Set(currentCatalogModels).size).toBe(35);
  });

  it('keeps exact feature boundaries for image and video models', () => {
    expect(uniCompApiModelFeatures('qwen-image')).toEqual(['text_to_image']);
    expect(uniCompApiModelFeatures('qwen-image-edit-2509')).toEqual([
      'reference_to_image'
    ]);
    expect(uniCompApiModelFeatures('viduq3-pro')).toEqual(['text_to_video']);
    expect(uniCompApiModelFeatures('viduq3-turbo')).toEqual([
      'text_to_video',
      'image_to_video'
    ]);
    expect(uniCompApiModelFeatures('kimi-k3')).toEqual([
      'text_chat',
      'text_reasoning'
    ]);
    expect(uniCompApiModelFeatures('happyhorse-1.0-r2v')).toEqual([]);
  });

  it('keeps unknown manual model keys backward-compatible', () => {
    expect(uniCompApiSupportsFeature(
      UNICOMPAPI_PROVIDER_PACKAGE_ID,
      'manual-future-model',
      'text_chat'
    )).toBe(true);
  });

  it('binds model-specific official image parameters', () => {
    expect(
      uniCompApiTextToImageParameterSchema('doubao-seedream-5-0-260128')?.schemaId
    ).toBe(UNICOMPAPI_SEEDREAM_5_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID);
    expect(
      uniCompApiTextToImageParameterSchema('qwen-image')
    ).toMatchObject({
      schemaId: UNICOMPAPI_QWEN_IMAGE_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID,
      productFeature: 'text_to_image',
      fields: expect.arrayContaining([
        expect.objectContaining({ fieldId: 'negative_prompt' }),
        expect.objectContaining({ fieldId: 'prompt_extend' }),
        expect.objectContaining({ fieldId: 'seed', minimum: 0, maximum: 2_147_483_647 })
      ])
    });
    expect(
      uniCompApiReferenceToImageParameterSchema('qwen-image-edit-2509')
    ).toMatchObject({
      schemaId: UNICOMPAPI_QWEN_IMAGE_REFERENCE_TO_IMAGE_PARAMETER_SCHEMA_ID,
      productFeature: 'reference_to_image',
      fields: expect.arrayContaining([
        expect.objectContaining({ fieldId: 'negative_prompt' }),
        expect.objectContaining({ fieldId: 'watermark' }),
        expect.objectContaining({ fieldId: 'seed' })
      ])
    });
    expect(uniCompApiTextToImageParameterSchema('manual-future-model')).toBeUndefined();
  });

});
