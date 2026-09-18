import { describe, expect, it } from 'vitest';
import {
  applyParameterFieldInput,
  createParameterFieldBuffer,
  flushParameterFieldBuffers,
  hasPendingParameterBuffer,
  isBufferedParameterValueType,
  sameParameterValue,
  serializeParameterFieldValue,
  type DynamicParameterFieldBuffer
} from '../../src/components/dynamic-parameter-buffer';
import type {
  DynamicParameterField,
  DynamicParameterValue
} from '../../src/components/dynamic-parameter-validation';

/**
 * P3 GREEN suite for the local parameter editing buffer.
 *
 * The RED behaviour was "one keystroke replaces the whole workspace draft and
 * the candidate/save counters grow with every key". These tests pin the
 * replacement contract: typing only touches the buffer, an invalid
 * intermediate keeps its text, and only a stable value is committed — with the
 * message wording still owned by the shared validator.
 */

function field(
  valueType: string,
  extra: Partial<DynamicParameterField> = {}
): DynamicParameterField {
  return {
    fieldId: `provider.parameter.${valueType}`,
    labelId: `provider.parameter.${valueType}`,
    valueType,
    required: false,
    ...extra
  };
}

/** One keystroke through the buffer, returning the resulting buffer. */
function type(
  target: DynamicParameterField,
  parentValue: DynamicParameterValue | undefined,
  text: string
): DynamicParameterFieldBuffer {
  return applyParameterFieldInput(target, parentValue, text);
}

describe('P3 parameter input buffer', () => {
  it('keeps text local and marks it edited without producing a value', () => {
    const size = field('string');
    const buffer = type(size, undefined, '1280x720');
    expect(buffer.text).toBe('1280x720');
    expect(buffer.pending).toBe('1280x720');
    expect(buffer.edited).toBe(true);
    expect(buffer.error).toBeUndefined();
    expect(buffer.blocked).toBe(false);
  });

  it('does not treat a re-typed parent value as an edit', () => {
    const size = field('string');
    const buffer = type(size, '1280x720', '1280x720');
    expect(buffer.edited).toBe(false);
    expect(hasPendingParameterBuffer({ [size.fieldId]: buffer })).toBe(false);
  });

  it('stays quiet and uncommittable while a number is half-typed', () => {
    const duration = field('number', { minimum: 1, maximum: 60 });
    for (const partial of ['-', '+', '.']) {
      const buffer = type(duration, undefined, partial);
      expect(buffer.error, `${partial} must not be reported as wrong`).toBeUndefined();
      expect(buffer.blocked).toBe(true);
      expect(buffer.pending).toBeUndefined();
    }
    const settled = type(duration, undefined, '12');
    expect(settled).toMatchObject({ pending: 12, error: undefined, blocked: false });
    // "1." already reads as 1, so it is a stable value, not an intermediate.
    expect(type(duration, undefined, '1.')).toMatchObject({ pending: 1, blocked: false });
  });

  it('reports an invalid number intermediate without losing the text', () => {
    const duration = field('number');
    const buffer = type(duration, undefined, 'abc');
    expect(buffer.text).toBe('abc');
    expect(buffer.blocked).toBe(true);
    expect(buffer.pending).toBeUndefined();
    expect(buffer.error).toContain('必须是有效数字');
  });

  it('reuses the shared validator for range, integer and step messages', () => {
    const ratio = field('number', { minimum: 0, maximum: 1, step: 0.5 });
    expect(type(ratio, undefined, '2').error).toContain('不能大于 1');
    expect(type(field('integer'), undefined, '1.5').error).toContain('必须是整数');
    expect(type(ratio, undefined, '0.3').error).toContain('必须按步长 0.5');
  });

  it('reads a trailing comma as mid-typing, not as a broken element', () => {
    const frames = field('number_array', { minimum: 1, maximum: 100 });
    // The completed items are unambiguous, so they may settle; the half-typed
    // last element may not.
    expect(type(frames, undefined, '1, 2,')).toMatchObject({
      pending: [1, 2],
      error: undefined,
      blocked: false
    });
    const halfTyped = type(frames, undefined, '1, 2, -');
    expect(halfTyped.blocked).toBe(true);
    expect(halfTyped.error).toBeUndefined();
    const settled = type(frames, undefined, '1, 2, 3');
    expect(settled).toMatchObject({ pending: [1, 2, 3], blocked: false, error: undefined });
    expect(type(frames, undefined, '1,,2').error).toContain('逗号分隔的有效数字');
    expect(type(frames, undefined, '1, 200').error).toContain('不能大于 100');
  });

  it('parses string arrays and clears an optional empty array', () => {
    const stop = field('string_array');
    expect(type(stop, undefined, 'a, b').pending).toEqual(['a', 'b']);
    expect(type(stop, undefined, '').pending).toBeUndefined();
    const required = field('string_array', { required: true });
    expect(type(required, undefined, '').pending).toBeUndefined();
  });

  it('keeps broken JSON text editable and refuses to commit it', () => {
    const metadata = field('object');
    const broken = type(metadata, undefined, '{ "a": ');
    expect(broken.text).toBe('{ "a": ');
    expect(broken.blocked).toBe(true);
    expect(broken.pending).toBeUndefined();
    expect(broken.error).toContain('JSON 对象');
    const valid = type(metadata, undefined, '{ "a": 1 }');
    expect(valid).toMatchObject({ pending: { a: 1 }, blocked: false, error: undefined });
    // An array is not an object even though it is valid JSON.
    expect(type(metadata, undefined, '[1, 2]').error).toContain('JSON 对象');
  });

  it('commits only edited, valid fields and leaves blocked ones alone', () => {
    const promptField = field('string');
    const brokenField = field('object');
    const fields = [promptField, brokenField];
    const buffers = {
      [promptField.fieldId]: type(promptField, 'old', 'new'),
      [brokenField.fieldId]: type(brokenField, { a: 1 } as DynamicParameterValue, '{ "a":')
    };
    const flushed = flushParameterFieldBuffers(fields, buffers, {
      [promptField.fieldId]: 'old',
      [brokenField.fieldId]: { a: 1 } as DynamicParameterValue
    });
    expect(flushed.committedFieldIds).toEqual([promptField.fieldId]);
    expect(flushed.values[promptField.fieldId]).toBe('new');
    // The half-typed JSON must not overwrite the good object with `undefined`.
    expect(flushed.values[brokenField.fieldId]).toEqual({ a: 1 });
    expect(flushed.valid).toBe(false);
    expect(Object.keys(flushed.errors)).toEqual([brokenField.fieldId]);
  });

  it('reports a commit that only re-serializes the same value as unchanged', () => {
    const duration = field('number');
    const fields = [duration];
    const buffers = { [duration.fieldId]: type(duration, 12, '12.0') };
    const flushed = flushParameterFieldBuffers(fields, buffers, { [duration.fieldId]: 12 });
    expect(flushed.committedFieldIds).toEqual([]);
    expect(flushed.valid).toBe(true);
  });

  it('compares arrays and objects by value, not by reference', () => {
    expect(sameParameterValue(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameParameterValue(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(sameParameterValue({ a: 1 }, { a: 1 })).toBe(true);
    expect(sameParameterValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameParameterValue(undefined, undefined)).toBe(true);
    expect(sameParameterValue('a', undefined)).toBe(false);
  });

  it('serializes every buffered type back to what the control shows', () => {
    expect(serializeParameterFieldValue(field('string'), 'x')).toBe('x');
    expect(serializeParameterFieldValue(field('number'), 12)).toBe('12');
    expect(serializeParameterFieldValue(field('number_array'), [1, 2])).toBe('1, 2');
    expect(serializeParameterFieldValue(field('object'), { a: 1 })).toBe('{"a":1}');
    expect(serializeParameterFieldValue(field('string'), undefined)).toBe('');
    const created = createParameterFieldBuffer(field('number'), 3);
    expect(created).toMatchObject({ text: '3', pending: 3, edited: false, blocked: false });
  });

  it('buffers free text and unknown types but not discrete or read-only controls', () => {
    expect(isBufferedParameterValueType('string')).toBe(true);
    expect(isBufferedParameterValueType('object')).toBe(true);
    expect(isBufferedParameterValueType('future_type')).toBe(true);
    expect(isBufferedParameterValueType('boolean')).toBe(false);
    expect(isBufferedParameterValueType('enum')).toBe(false);
    expect(isBufferedParameterValueType('media_slot')).toBe(false);
  });
});
