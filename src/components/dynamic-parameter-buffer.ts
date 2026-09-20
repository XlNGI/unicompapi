/**
 * P3 local editing buffer for the dynamic parameter form.
 *
 * Before P3 every keystroke travelled from the control to the parent panel,
 * which replaced the whole workspace draft, marked it dirty, queued an autosave
 * and re-evaluated the candidate effect. This module owns the piece that breaks
 * that coupling: a per-field buffer that holds the raw text the user is typing,
 * decides whether the text is a *stable* value or an invalid/incomplete
 * intermediate state, and only then hands the value to the parent.
 *
 * Rules encoded here (plan §4.3):
 * - typing only touches the local buffer; the parent is not called;
 * - an incomplete intermediate ("-", "1.", "[", "{") stays local and quiet;
 * - an invalid intermediate keeps its text so the user can keep editing, and
 *   reports a local error instead of a wrong value;
 * - a stable value is committed on blur, Enter, idle or an explicit flush;
 * - a blocked buffer never reaches the parent, so no invalid value can reach
 *   provider dispatch.
 *
 * Pure functions only: no React, no I/O, so the behaviour is unit-testable
 * without a DOM.
 */

import {
  validateDynamicParameterValue,
  type DynamicParameterField,
  type DynamicParameterValue
} from './dynamic-parameter-validation';

/** Local editing state of one buffered control. */
export interface DynamicParameterFieldBuffer {
  /** Exactly what the control displays. */
  readonly text: string;
  /** Parsed value ready to commit; `undefined` while empty, incomplete or invalid. */
  readonly pending: DynamicParameterValue | undefined;
  /** Local message shown for an invalid intermediate state. */
  readonly error: string | undefined;
  /** True when the buffer text differs from the parent value. */
  readonly edited: boolean;
  /** True when the buffer must not be committed yet. */
  readonly blocked: boolean;
}

/** Result of committing every pending buffer. */
export interface DynamicParameterBufferFlush {
  /** Complete parameter map after applying the committable buffers. */
  readonly values: Readonly<Record<string, DynamicParameterValue | undefined>>;
  /** Field ids whose committed value actually changes the parent value. */
  readonly committedFieldIds: readonly string[];
  /** Fields still blocked by an invalid intermediate state. */
  readonly errors: Readonly<Record<string, string>>;
  /** False when at least one field cannot be committed. */
  readonly valid: boolean;
}

interface ParsedFieldText {
  readonly pending: DynamicParameterValue | undefined;
  readonly error: string | undefined;
  readonly blocked: boolean;
}

/**
 * Value types that need a local editing buffer. Discrete controls (boolean,
 * enum) commit a whole choice at once, and the read-only media slot has no
 * input, so both stay out of the buffer. Any unknown type is buffered as free
 * text; the shared validator still refuses to dispatch it.
 */
export function isBufferedParameterValueType(valueType: string): boolean {
  return valueType !== 'boolean' &&
    valueType !== 'enum' &&
    valueType !== 'media_slot';
}

/** Longest form of a value as shown in its control. */
export function serializeParameterFieldValue(
  field: DynamicParameterField,
  value: DynamicParameterValue | undefined
): string {
  if (value === undefined) return '';
  switch (field.valueType) {
    case 'number':
    case 'integer':
      return typeof value === 'number' ? String(value) : '';
    case 'string_array':
    case 'number_array':
      return Array.isArray(value) ? value.join(', ') : '';
    case 'object':
      return typeof value === 'object' && value !== null ? JSON.stringify(value) : '';
    default:
      return typeof value === 'string' ? value : '';
  }
}

/** Buffer for a control that is in sync with the parent value. */
export function createParameterFieldBuffer(
  field: DynamicParameterField,
  value: DynamicParameterValue | undefined
): DynamicParameterFieldBuffer {
  return {
    text: serializeParameterFieldValue(field, value),
    pending: value,
    error: undefined,
    edited: false,
    blocked: false
  };
}

/**
 * Applies one keystroke to a field. The parent value is still needed because
 * `edited` is defined against it, not against the previous buffer.
 */
export function applyParameterFieldInput(
  field: DynamicParameterField,
  parentValue: DynamicParameterValue | undefined,
  text: string
): DynamicParameterFieldBuffer {
  const parsed = parseParameterFieldText(field, text);
  return {
    text,
    pending: parsed.pending,
    error: parsed.error,
    blocked: parsed.blocked,
    edited: text !== serializeParameterFieldValue(field, parentValue)
  };
}

/** True when any buffered field holds text that is not yet in the parent. */
export function hasPendingParameterBuffer(
  buffers: Readonly<Record<string, DynamicParameterFieldBuffer | undefined>>
): boolean {
  return Object.values(buffers).some(
    (buffer) => buffer !== undefined && buffer.edited
  );
}

/**
 * Commits every buffer that holds a stable value.
 *
 * Blocked and invalid buffers keep the parent's previous value, so a partial
 * JSON object or a half-typed number can never replace a good one mid-edit.
 */
export function flushParameterFieldBuffers(
  fields: readonly DynamicParameterField[],
  buffers: Readonly<Record<string, DynamicParameterFieldBuffer | undefined>>,
  values: Readonly<Record<string, DynamicParameterValue | undefined>>
): DynamicParameterBufferFlush {
  const next: Record<string, DynamicParameterValue | undefined> = { ...values };
  const committedFieldIds: string[] = [];
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const buffer = buffers[field.fieldId];
    if (!buffer) continue;
    if (buffer.error) errors[field.fieldId] = buffer.error;
    else if (buffer.edited && buffer.blocked) errors[field.fieldId] = '请补全参数后再提交。';
    if (!buffer.edited || buffer.blocked || buffer.error) continue;
    if (!sameParameterValue(buffer.pending, values[field.fieldId])) {
      committedFieldIds.push(field.fieldId);
    }
    if (buffer.pending === undefined) delete next[field.fieldId];
    else next[field.fieldId] = buffer.pending;
  }
  return {
    values: next,
    committedFieldIds,
    errors,
    valid: Object.keys(errors).length === 0
  };
}

/** Structural comparison; arrays and plain objects compare by value. */
export function sameParameterValue(
  left: DynamicParameterValue | undefined,
  right: DynamicParameterValue | undefined
): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((item, index) => Object.is(item, right[index]));
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && Object.is(left[key], right[key]));
  }
  return false;
}

function parseParameterFieldText(
  field: DynamicParameterField,
  text: string
): ParsedFieldText {
  if (text.trim().length === 0) {
    // Empty means "cleared". A required field still surfaces its own message
    // through the shared validator, so no extra local error is invented here.
    return { pending: undefined, error: undefined, blocked: false };
  }
  switch (field.valueType) {
    case 'number':
    case 'integer':
      return parseNumericText(field, text.trim());
    case 'number_array':
      return parseNumberArrayText(field, text);
    case 'object':
      return parseObjectText(field, text);
    case 'string_array': {
      const items = text.split(',').map((item) => item.trim()).filter(Boolean);
      return settleParameterText(field, items.length === 0 ? undefined : items);
    }
    default:
      // Free-text types: any non-empty text is a valid stable value.
      return settleParameterText(field, text);
  }
}

function parseNumericText(
  field: DynamicParameterField,
  trimmed: string
): ParsedFieldText {
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    // "-", "+" and "1." are incomplete, not wrong: stay quiet and keep editing.
    if (isPartialNumberText(trimmed)) return blockedFieldText();
    return invalidFieldText(field, Number.NaN);
  }
  return settleParameterText(field, parsed);
}

function parseNumberArrayText(
  field: DynamicParameterField,
  text: string
): ParsedFieldText {
  const items = text.split(',').map((item) => item.trim());
  // A trailing comma is mid-typing, not an empty element.
  while (items.length > 1 && items[items.length - 1] === '') items.pop();
  if (items.some((item) => item === '')) {
    return invalidFieldText(field, [Number.NaN]);
  }
  const numbers = items.map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) {
    const last = items[items.length - 1] ?? '';
    if (isPartialNumberText(last)) return blockedFieldText();
    return invalidFieldText(field, [Number.NaN]);
  }
  return settleParameterText(field, numbers);
}

function parseObjectText(
  field: DynamicParameterField,
  text: string
): ParsedFieldText {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return invalidFieldText(field, text);
    }
    return settleParameterText(field, parsed as Readonly<Record<string, unknown>>);
  } catch {
    // The text stays local and editable; the error explains why it cannot be
    // committed yet.
    return invalidFieldText(field, text);
  }
}

/** Message wording stays owned by the shared validator. */
function invalidFieldText(
  field: DynamicParameterField,
  invalid: DynamicParameterValue
): ParsedFieldText {
  return {
    pending: undefined,
    error: validateDynamicParameterValue(field, invalid),
    blocked: true
  };
}

function blockedFieldText(): ParsedFieldText {
  return { pending: undefined, error: undefined, blocked: true };
}

function settleParameterText(
  field: DynamicParameterField,
  pending: DynamicParameterValue | undefined
): ParsedFieldText {
  const error = validateDynamicParameterValue(field, pending);
  return { pending, error, blocked: error !== undefined };
}

/** A bare sign or a bare trailing separator, e.g. `-`, `+`, `1.`, `.`. */
function isPartialNumberText(text: string): boolean {
  return /^[+-]?$/.test(text) || /^[+-]?\d*\.$/.test(text);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
