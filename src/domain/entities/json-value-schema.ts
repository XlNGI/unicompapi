export type JsonValueSchema = Readonly<Record<string, unknown>>;

const schemaKeys = new Set(['type', 'allOf', 'oneOf', 'anyOf', 'not', 'properties', 'items', 'required', 'enum', 'const',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'uniqueItems', 'additionalProperties', 'nullable', 'default', 'deprecated', 'pattern', 'format', 'multipleOf']);

/** Check local Schema data before exposing it across IPC or accepting it from persisted state. */
export function validateJsonValueSchema(schema: JsonValueSchema): JsonValueSchema {
  if (JSON.stringify(schema).length > 32000) throw new TypeError('Parameter validation schema is too large');
  const budget = { remaining: 4096 };
  function visit(value: unknown, depth: number): void {
    if (!object(value) || depth > 24 || --budget.remaining < 0 || Object.keys(value).some(key => !schemaKeys.has(key))) throw new TypeError('Parameter validation schema is invalid');
    for (const key of ['allOf', 'anyOf', 'oneOf']) if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || value[key].length < 1 || value[key].length > 64) throw new TypeError('Parameter union schema is invalid');
      value[key].forEach(part => visit(part, depth + 1));
    }
    if (value.properties !== undefined) {
      if (!object(value.properties) || Object.keys(value.properties).length > 128) throw new TypeError('Parameter object schema is invalid');
      for (const [key, child] of Object.entries(value.properties)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('Parameter property is invalid');
        visit(child, depth + 1);
      }
    }
    for (const key of ['items', 'not']) if (value[key] !== undefined) visit(value[key], depth + 1);
    if (object(value.additionalProperties)) visit(value.additionalProperties, depth + 1);
    if (value.type !== undefined && (Array.isArray(value.type) ? value.type : [value.type]).some(type => !['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'].includes(String(type)))) throw new TypeError('Parameter type is invalid');
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) throw new TypeError('Parameter length is invalid');
    for (const key of ['minimum', 'maximum', 'multipleOf']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || key === 'multipleOf' && value[key] <= 0)) throw new TypeError('Parameter numeric constraint is invalid');
  }
  visit(schema, 0);
  return structuredClone(schema);
}

/** Bounded, portable validation of local declarative parameter schemas; no references, regex or code execution. */
export function matchesJsonValueSchema(value: unknown, schema: JsonValueSchema): boolean {
  return check(value, schema, 0, { remaining: 4096 });
}
function check(value: unknown, schema: JsonValueSchema, depth: number, budget: { remaining: number }): boolean {
  if (depth > 24 || --budget.remaining < 0 || '$ref' in schema) return false;
  if (value === null && schema.nullable === true) return true;
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) if (Array.isArray(schema[key])) {
    const outcomes = schema[key].map(part => object(part) && check(value, part, depth + 1, budget));
    if (key === 'allOf' ? outcomes.some(item => !item) : key === 'anyOf' ? !outcomes.some(Boolean) : outcomes.filter(Boolean).length !== 1) return false;
  }
  if (object(schema.not) && check(value, schema.not, depth + 1, budget)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some(option => Object.is(option, value))) return false;
  if ('const' in schema && !Object.is(schema.const, value)) return false;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => type === 'null' ? value === null : type === 'object' ? object(value) : type === 'array' ? Array.isArray(value)
      : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : type === 'string' ? typeof value === 'string' : type === 'boolean' ? typeof value === 'boolean' : false)) return false;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || typeof schema.minimum === 'number' && value < schema.minimum || typeof schema.maximum === 'number' && value > schema.maximum ||
      typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum || typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum ||
      schema.exclusiveMinimum === true && typeof schema.minimum === 'number' && value <= schema.minimum ||
      schema.exclusiveMaximum === true && typeof schema.maximum === 'number' && value >= schema.maximum) return false;
    if (typeof schema.multipleOf === 'number') {
      const ratio = value / schema.multipleOf;
      if (Math.abs(ratio - Math.round(ratio)) > Number.EPSILON * 32 * Math.max(1, Math.abs(ratio))) return false;
    }
  }
  if (typeof value === 'string' && (typeof schema.minLength === 'number' && value.length < schema.minLength || typeof schema.maxLength === 'number' && value.length > schema.maxLength)) return false;
  if (typeof value === 'string' && schema.pattern !== undefined) {
    // Only a retained, bounded lexical rule is supported; arbitrary Schema regex never executes.
    if (schema.pattern === '^[a-zA-Z0-9_-]+$') { if (!/^[a-zA-Z0-9_-]+$/.test(value)) return false; }
    else return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems || typeof schema.maxItems === 'number' && value.length > schema.maxItems || value.length > 4096) return false;
    if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
    if (object(schema.items) && !value.every(item => check(item, schema.items as JsonValueSchema, depth + 1, budget))) return false;
  }
  if (object(value)) {
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(value, key))) return false;
    const properties = object(schema.properties) ? schema.properties : {};
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) return false;
      if (object(properties[key])) { if (!check(item, properties[key] as JsonValueSchema, depth + 1, budget)) return false; }
      else if (schema.additionalProperties === false) return false;
      else if (object(schema.additionalProperties) && !check(item, schema.additionalProperties, depth + 1, budget)) return false;
    }
  }
  return true;
}
function object(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
