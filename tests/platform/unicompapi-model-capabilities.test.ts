import { describe, expect, it } from 'vitest';
import { projectParameterSchema } from '../../src/domain';
import {
  isKnownUniCompApiModel,
  uniCompApiQwenImageTextToImageParameterSchema,
  uniCompApiSeedance2ImageToVideoParameterSchema,
  uniCompApiSeedance2TextToVideoParameterSchema,
  uniCompApiModelFeatures,
  uniCompApiTextToImageParameterSchema,
  uniCompApiReferenceToImageParameterSchema,
  uniCompApiVideoParameterSchema,
  uniCompApiSupportsFeature,
  uniCompApiTextChatParameterSchema,
  uniCompApiTextReasoningParameterSchema,
  UNICOMPAPI_DEFAULT_TEXT_CHAT_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_SEEDREAM_5_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_QWEN_IMAGE_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_QWEN_IMAGE_REFERENCE_TO_IMAGE_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_SEEDANCE_2_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_SEEDANCE_2_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
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

  it('keeps unknown UniCompAPI model keys without any inferred capability', () => {
    expect(uniCompApiSupportsFeature(
      UNICOMPAPI_PROVIDER_PACKAGE_ID,
      'manual-future-model',
      'text_chat'
    )).toBe(false);
    expect(uniCompApiSupportsFeature(
      UNICOMPAPI_PROVIDER_PACKAGE_ID,
      'manual-future-model',
      'text_to_image'
    )).toBe(false);
    expect(uniCompApiSupportsFeature(
      UNICOMPAPI_PROVIDER_PACKAGE_ID,
      'manual-future-model',
      'text_to_video'
    )).toBe(false);
  });

  it('binds model-specific official image parameters', () => {
    expect(
      uniCompApiTextToImageParameterSchema('doubao-seedream-5-0-260128')?.schemaId
    ).toBe(UNICOMPAPI_SEEDREAM_5_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID);
    expect(
      uniCompApiTextToImageParameterSchema('qwen-image')
    ).toMatchObject({
      schemaId: UNICOMPAPI_QWEN_IMAGE_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID,
      revision: 3,
      productFeature: 'text_to_image',
      fields: expect.arrayContaining([
        expect.objectContaining({
          fieldId: 'size',
          exposure: 'user_required',
          defaultPolicy: 'require_user_value',
          required: true,
          options: [
            '1664x928',
            '1472x1104',
            '1328x1328',
            '1104x1472',
            '928x1664'
          ]
        }),
        expect.objectContaining({ fieldId: 'negative_prompt' }),
        expect.objectContaining({ fieldId: 'prompt_extend' }),
        expect.objectContaining({ fieldId: 'seed', minimum: 0, maximum: 2_147_483_647 })
      ])
    });
    expect(projectParameterSchema(
      uniCompApiQwenImageTextToImageParameterSchema,
      'required_only'
    ).fields.map((field) => field.fieldId)).toEqual(['size']);
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

  it('binds only exact UniCompAPI Seedance 2.0 keys to verified video fields', () => {
    expect(uniCompApiVideoParameterSchema(
      'doubao-seedance-2-0-fast-260128',
      'text_to_video'
    )).toBe(uniCompApiSeedance2TextToVideoParameterSchema);
    expect(uniCompApiVideoParameterSchema(
      'doubao-seedance-2-0-260128',
      'image_to_video'
    )).toBe(uniCompApiSeedance2ImageToVideoParameterSchema);
    expect(uniCompApiSeedance2TextToVideoParameterSchema).toMatchObject({
      schemaId: UNICOMPAPI_SEEDANCE_2_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
      productFeature: 'text_to_video'
    });
    expect(uniCompApiSeedance2ImageToVideoParameterSchema).toMatchObject({
      schemaId: UNICOMPAPI_SEEDANCE_2_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID,
      productFeature: 'image_to_video'
    });
    expect(uniCompApiSeedance2TextToVideoParameterSchema.fields.map(
      (field) => field.fieldId
    )).toEqual([
      'resolution',
      'ratio',
      'duration',
      'frames',
      'seed',
      'camera_fixed',
      'watermark',
      'generate_audio',
      'return_last_frame'
    ]);
    expect(uniCompApiSeedance2TextToVideoParameterSchema.fields.every(
      (field) => field.required === false && field.options === undefined
    )).toBe(true);
    expect(uniCompApiVideoParameterSchema('seedance-2.0-fast', 'text_to_video'))
      .toBeUndefined();
  });

  it('limits UniCompAPI text chat parameters to the official Chat Completions contract', () => {
    expect(uniCompApiTextChatParameterSchema).toMatchObject({
      schemaId: UNICOMPAPI_DEFAULT_TEXT_CHAT_PARAMETER_SCHEMA_ID,
      revision: 1,
      productFeature: 'text_chat'
    });
    expect(uniCompApiTextChatParameterSchema.fields.map((field) => field.fieldId)).toEqual([
      'max_tokens',
      'temperature',
      'top_p',
      'stop',
      'n',
      'presence_penalty',
      'frequency_penalty',
      'seed',
      'response_format',
      'tool_choice',
      'user',
      'logit_bias'
    ]);
    expect(uniCompApiTextChatParameterSchema.fields.map((field) => field.fieldId))
      .not.toEqual(expect.arrayContaining([
        'thinking',
        'top_k',
        'chat_template_kwargs',
        'enable_thinking',
        'metadata',
        'parallel_tool_calls'
      ]));
    expect(uniCompApiTextChatParameterSchema.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldId: 'max_tokens', minimum: 1, maximum: 128000 }),
        expect.objectContaining({ fieldId: 'temperature', minimum: 0, maximum: 2 }),
        expect.objectContaining({ fieldId: 'top_p', minimum: 0, maximum: 1 }),
        expect.objectContaining({ fieldId: 'logit_bias', valueType: 'object' })
      ])
    );
  });

  it('limits UniCompAPI text reasoning parameters to official fields', () => {
    expect(uniCompApiTextReasoningParameterSchema).toMatchObject({
      schemaId: UNICOMPAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID,
      revision: 1,
      productFeature: 'text_reasoning'
    });
    expect(uniCompApiTextReasoningParameterSchema.fields.map((field) => field.fieldId)).toEqual([
      'max_completion_tokens',
      'reasoning_effort',
      'stop',
      'n',
      'presence_penalty',
      'frequency_penalty',
      'seed',
      'response_format',
      'tool_choice',
      'user',
      'logit_bias'
    ]);
    expect(uniCompApiTextReasoningParameterSchema.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldId: 'reasoning_effort',
          valueType: 'enum',
          options: ['low', 'medium', 'high']
        }),
        expect.objectContaining({
          fieldId: 'max_completion_tokens',
          minimum: 1,
          maximum: 128000
        }),
        expect.objectContaining({ fieldId: 'logit_bias', valueType: 'object' })
      ])
    );
    expect(uniCompApiTextReasoningParameterSchema.fields.map((field) => field.fieldId))
      .not.toEqual(expect.arrayContaining([
        'thinking',
        'top_k',
        'chat_template_kwargs',
        'enable_thinking',
        'metadata'
      ]));
  });

});
