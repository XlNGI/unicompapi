import { describe, expect, it } from 'vitest';
import { parameterRequestError, projectParameterSchema, validateParameterRequestRules, validateParameterValues } from '../../src/domain';
import { wwwVideoContract, wwwVideoParameterSchema } from '../../src/platform/providers/newapi/www-video-contracts';
import { normalizeProviderSubmitOutcome } from '../../src/platform/providers/provider-submission-dispatch-bridge';
import { imageHasAlphaChannel } from '../../src/platform/files/image-alpha-channel';
import { testPng } from '../fixtures/png';
import { wwwAdapterFixture } from '../fixtures/www-video';

describe('video parameter repair boundaries', () => {
  it('keeps unknown requirements explicit and the H3 example opt-in on both projections', async () => {
    const schema = wwwVideoParameterSchema(wwwVideoContract('MiniMax-H3')!, 'text_to_video');
    for (const mode of ['required_only', 'full'] as const) {
      const projection = projectParameterSchema(schema, mode);
      expect(projection.fields).toHaveLength(5);
      expect(projection.fields.every(f => f.requirement === 'unknown' && !f.required && f.defaultPolicy === 'omit_without_default_guarantee')).toBe(true);
      expect(() => validateParameterValues(schema, mode, {})).toThrow(/空参数/);
      expect(validateParameterValues(schema, mode, schema.exampleValues)).toEqual(schema.exampleValues);
      expect(validateParameterValues(schema, mode, { watermark: false })).toEqual({ watermark: false });
      expect(validateParameterValues(schema, mode, { duration: 5 })).toEqual({ duration: 5 });
    }
    const x = wwwAdapterFixture('MiniMax-H3');
    const outcome = await x.adapter.submit({ routeSnapshot: x.route, request: { ...x.request, parameterValues: {} } });
    expect(outcome.kind).toBe('failed_before_submission');
    expect(x.calls).toHaveLength(0);
    expect(x.approvals).toHaveLength(0);
  });

  it('uses documented Unicode limits at the shared rule and real adapter boundary', async () => {
    const schema = wwwVideoParameterSchema(wwwVideoContract('doubao-seedance-2-0-260128')!, 'text_to_video');
    const prompt = '😀'.repeat(20000);
    expect(parameterRequestError(schema.requestRules, { parameters: {}, prompt, imageCount: 0 })).toBeUndefined();
    const x = wwwAdapterFixture('doubao-seedance-2-0-260128');
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: { ...x.request, prompt } })).toMatchObject({ kind: 'accepted_async' });
    const rejected = wwwAdapterFixture('doubao-seedance-2-0-260128');
    expect(await rejected.adapter.submit({ routeSnapshot: rejected.route, request: { ...rejected.request, prompt: prompt + '中' } }))
      .toMatchObject({ kind: 'failed_before_submission', failureDiagnostic: { message: expect.stringContaining('20000') } });
    expect(rejected.calls).toHaveLength(0);
  });

  it('applies the same frame/duration selection policy and material-count rules before transport', async () => {
    const schema = wwwVideoParameterSchema(wwwVideoContract('wan3.0-video')!, 'image_to_video');
    const seedance = wwwVideoParameterSchema(wwwVideoContract('doubao-seedance-2-0-260128')!, 'text_to_video');
    expect(() => validateParameterValues(seedance, 'full', { frames: 29, duration_seconds: 4 })).toThrow(/只填写一项/);
    const parameters = { generation_mode: 'first_last_frame' };
    expect(parameterRequestError(schema.requestRules, { parameters, prompt: 'cup', imageCount: 1 })).toContain('2 张');
    expect(parameterRequestError(schema.requestRules, { parameters, prompt: 'cup', imageCount: 2 })).toBeUndefined();
    const x = wwwAdapterFixture('wan3.0-video', 'image_to_video');
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: { ...x.request, parameterValues: parameters } })).toMatchObject({ kind: 'failed_before_submission' });
    expect(x.calls).toHaveLength(0);
    expect(x.imageResolutions).toHaveLength(0);
  });

  it.each([{ alpha: true }, { transparency: true }])('rejects actual alpha/tRNS bytes before upload or quote (%j)', async options => {
    const bytes = testPng(300, 300, options);
    expect(imageHasAlphaChannel(bytes, 'image/png')).toBe(true);
    for (const key of ['wan3.0-video-ali', 'wan3.0-video-prime-ali']) {
      const x = wwwAdapterFixture(key, 'image_to_video');
      x.setImage({ mimeType: 'image/png', width: 300, height: 300, sizeBytes: bytes.length, bytes });
      expect(await x.adapter.submit({ routeSnapshot: x.route, request: { ...x.request, parameterValues: { generation_mode: 'first_frame' } } }))
        .toMatchObject({ kind: 'failed_before_submission', failureDiagnostic: { message: expect.stringContaining('透明通道') } });
      expect(x.calls).toHaveLength(0);
    }
  });

  it('accepts opaque PNG, fails closed on truncated PNG, and identifies JPEG as opaque', async () => {
    const bytes = testPng(300, 300);
    expect(imageHasAlphaChannel(bytes, 'image/png')).toBe(false);
    expect(() => imageHasAlphaChannel(bytes.subarray(0, bytes.length - 1), 'image/png')).toThrow();
    expect(() => imageHasAlphaChannel(new Uint8Array([1, 2, 3]), 'image/png')).toThrow();
    expect(imageHasAlphaChannel(new Uint8Array([255, 216, 255, 224]), 'image/jpeg')).toBe(false);
    const x = wwwAdapterFixture('wan3.0-video-ali', 'image_to_video');
    x.setImage({ mimeType: 'image/png', width: 300, height: 300, sizeBytes: bytes.length, bytes });
    expect(await x.adapter.submit({ routeSnapshot: x.route, request: { ...x.request, parameterValues: { generation_mode: 'first_frame' } } })).toMatchObject({ kind: 'accepted_async' });
    expect(x.imageResolutions).toEqual([{ maximumInputBytes: 20000000 }, { maximumInputBytes: 20000000 }]);
  });

  it('preserves sanitized HTTP 400 quote diagnostics through dispatch normalization', async () => {
    const x = wwwAdapterFixture('MiniMax-H3');
    x.setQuoteFailure({ code: 'invalid_h3_parameters', message: 'Invalid H3 parameters; synthetic-www-test-key https://example.invalid/private' });
    const outcome = await x.adapter.submit({ routeSnapshot: x.route, request: x.request });
    expect(outcome).toMatchObject({ kind: 'failed_before_submission', failureDiagnostic: {
      statusCode: 400, code: 'invalid_h3_parameters', stage: 'upstream_response', message: expect.stringContaining('Invalid H3 parameters')
    } });
    const normalized = normalizeProviderSubmitOutcome(outcome);
    expect(normalized).toMatchObject({ kind: 'failed_before_submission', safeCode: 'www_video.generation_not_submitted', failureDiagnostic: { code: 'invalid_h3_parameters' } });
    expect(JSON.stringify(normalized)).not.toContain('synthetic-www-test-key');
    expect(JSON.stringify(normalized)).not.toContain('example.invalid');
    expect(x.calls).toHaveLength(1);
    expect(x.approvals).toHaveLength(0);
  });

  it('keeps newly documented outputs and modes inside supported receiver boundaries', () => {
    const c = wwwVideoContract('doubao-seedance-2-0-260128')!;
    const outputSchema = c.fields.find(f => f.name === 'output_format')?.schema;
    expect(outputSchema && 'enum' in outputSchema ? outputSchema.enum : undefined).toContain('mov');
    const schema = wwwVideoParameterSchema(c, 'image_to_video');
    expect(schema.fields.find(f => f.fieldId === 'output_format')?.options).toEqual(['mp4']);
    expect(schema.fields.find(f => f.fieldId === 'generation_mode')?.options).not.toContain('last_frame');
    expect(schema.fields.find(f => f.fieldId === 'generation_mode')?.options).not.toContain('first_frame_audio');
  });

  it.each([{ maximumPromptCharacters: -1 }, { modeImageCounts: [null] }, { imageCount: { minimum: 3, maximum: 2 } },
    { exclusiveFields: [['a']] }, { arbitraryCode: 'x' }])('rejects malformed declarative rules %j', rules => {
    expect(() => validateParameterRequestRules(rules as never)).toThrow();
  });
});
