import { createDocumentToolRegistry, parseDocumentToolRequest, type DocumentToolId, type DocumentToolRequest, type DocumentToolDefinition } from '../domain/entities/document-agent';

export type AtomicToolField =
  | { readonly type: 'string'; readonly maxLength: number; readonly required?: boolean; readonly enum?: readonly string[] }
  | { readonly type: 'integer'; readonly minimum: number; readonly maximum: number; readonly required?: boolean }
  | { readonly type: 'boolean'; readonly required?: boolean };

export interface DocumentAtomicToolBinding {
  readonly id: DocumentToolId;
  readonly fields: Readonly<Record<string, AtomicToolField>>;
  /** Recheck task ownership, live grants, entity revisions and target scope on every call. */
  authorize(request: DocumentToolRequest, signal: AbortSignal): Promise<boolean>;
  execute(request: DocumentToolRequest, context: {
    readonly callId: string;
    readonly definition: DocumentToolDefinition;
    readonly signal: AbortSignal;
  }): Promise<Readonly<Record<string, unknown>>>;
}

/** The same bounded field contract produces the advertised schema and validates execution. */
export function atomicToolSchema(binding: DocumentAtomicToolBinding): Readonly<Record<string, unknown>> {
  if (!createDocumentToolRegistry().has(binding.id)) throw new TypeError('tool_not_registered');
  const entries = Object.entries(binding.fields);
  if (entries.length > 32) throw new TypeError('tool_schema_invalid');
  const properties: Record<string, unknown> = Object.create(null);
  for (const [key, field] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || ['reason', '__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('tool_schema_invalid');
    if (field.type === 'string') {
      if (!Number.isSafeInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 2_000 ||
        (field.enum && (field.enum.length < 1 || field.enum.length > 64 || field.enum.some(value => typeof value !== 'string' || !value.trim() || value.length > field.maxLength)))) throw new TypeError('tool_schema_invalid');
      properties[key] = { type: 'string', minLength: 1, maxLength: field.maxLength, ...(field.enum ? { enum: [...field.enum] } : {}) };
    } else if (field.type === 'integer') {
      if (!Number.isSafeInteger(field.minimum) || !Number.isSafeInteger(field.maximum) || field.minimum > field.maximum) throw new TypeError('tool_schema_invalid');
      properties[key] = { type: 'integer', minimum: field.minimum, maximum: field.maximum };
    } else if (field.type === 'boolean') properties[key] = { type: 'boolean' };
    else throw new TypeError('tool_schema_invalid');
  }
  properties.reason = { type: 'string', minLength: 1, maxLength: 2_000 };
  const schema = { type: 'object', additionalProperties: false, properties, required: entries.filter(([, field]) => field.required).map(([key]) => key) };
  if (JSON.stringify(schema).length > 16_000) throw new TypeError('tool_schema_invalid');
  return schema;
}

export function parseAtomicToolArguments(binding: DocumentAtomicToolBinding, value: unknown): DocumentToolRequest {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('invalid_tool_arguments');
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some(key => key !== 'reason' && !Object.prototype.hasOwnProperty.call(binding.fields, key))) throw new TypeError('invalid_tool_arguments');
  for (const [key, field] of Object.entries(binding.fields)) {
    const raw = args[key];
    if (raw === undefined && !field.required) continue;
    if (field.type === 'string' && (typeof raw !== 'string' || !raw.trim() || raw.length > field.maxLength || (field.enum && !field.enum.includes(raw)))) throw new TypeError('invalid_tool_arguments');
    if (field.type === 'integer' && (!Number.isSafeInteger(raw) || Number(raw) < field.minimum || Number(raw) > field.maximum)) throw new TypeError('invalid_tool_arguments');
    if (field.type === 'boolean' && typeof raw !== 'boolean') throw new TypeError('invalid_tool_arguments');
  }
  const { reason = 'provider_tool_call', ...input } = args;
  return parseDocumentToolRequest({ toolId: binding.id, input, reason });
}
