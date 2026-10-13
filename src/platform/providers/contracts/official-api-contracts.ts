import catalog from './official-api-contracts.json';
import { createHash } from 'node:crypto';
import { matchesJsonValueSchema, validateJsonValueSchema, type JsonValueSchema } from '../../../domain/entities/json-value-schema';

export interface OfficialApiContract {
  readonly id: string;
  readonly revision: number;
  readonly authority: 'model_vendor';
  readonly vendor: string;
  readonly modelKeys: readonly string[];
  readonly sources: readonly { readonly url: string; readonly retrievedAt: string; readonly sha256: string }[];
  readonly requestSchema: Readonly<Record<string, unknown>>;
  readonly definitions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly contractScope?: string;
  readonly method?: 'POST';
  readonly endpointPath?: string;
  readonly responseSchemas?: Readonly<Record<string, JsonValueSchema>>;
  readonly toolChoices?: readonly string[];
  readonly thinkingHistory?: 'preserve_when_returned';
  readonly conditions?: readonly string[];
}

/** Useful for compiling and reviewing vendor schema projections without involving relay connection facts. */
export function vendorContractParameterNames(id: string, revision: number): readonly string[] {
  return Object.keys(officialRequestProperties(getOfficialApiContract(id, revision)));
}

/** Vendor contracts contain no connection, endpoint, credential or relay-owned capability evidence. */
export function listOfficialApiContracts(): readonly OfficialApiContract[] {
  return structuredClone(catalog.contracts) as unknown as readonly OfficialApiContract[];
}

export function getOfficialApiContract(id: string, revision: number): OfficialApiContract {
  const contract = listOfficialApiContracts().find(item => item.id === id && item.revision === revision);
  if (!contract) throw new Error('official_contract_unavailable');
  if (contract.authority !== 'model_vendor' || !contract.sources.length || contract.sources.some(item =>
    !/^https:\/\//.test(item.url) || !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error('official_contract_source_invalid');
  return contract;
}

export function officialApiContractFingerprint(contract: OfficialApiContract): string {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

/** Resolve only local retained schema definitions; remote references and cycles are rejected. */
export function officialRequestProperties(contract: OfficialApiContract): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return flatten(contract.requestSchema, contract, new Set(), 0);
}

export function officialRequestRequiredParameters(contract: OfficialApiContract): ReadonlySet<string> {
  const required = new Set<string>();
  function collect(unresolved: JsonValueSchema, depth: number): void {
    if (depth > 16) throw new Error('official_contract_schema_limit');
    const schema = resolveOfficialValueSchema(contract, unresolved);
    if (Array.isArray(schema.required)) for (const key of schema.required) {
      if (typeof key !== 'string') throw new Error('official_contract_schema_invalid');
      required.add(key);
    }
    if (Array.isArray(schema.allOf)) for (const part of schema.allOf) {
      if (!record(part)) throw new Error('official_contract_schema_invalid');
      collect(part, depth + 1);
    }
  }
  collect(contract.requestSchema, 0);
  return required;
}

function flatten(schema: Readonly<Record<string, unknown>>, contract: OfficialApiContract, seen: Set<string>, depth: number): Record<string, Readonly<Record<string, unknown>>> {
  if (depth > 16) throw new Error('official_contract_schema_limit');
  if (typeof schema.$ref === 'string') {
    const prefix = '#/components/schemas/';
    if (!schema.$ref.startsWith(prefix) || seen.has(schema.$ref)) throw new Error('official_contract_reference_invalid');
    const definition = contract.definitions[schema.$ref.slice(prefix.length)];
    if (!definition) throw new Error('official_contract_reference_unavailable');
    return flatten(definition, contract, new Set([...seen, schema.$ref]), depth + 1);
  }
  let properties: Record<string, Readonly<Record<string, unknown>>> = {};
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf) {
    if (!record(part)) throw new Error('official_contract_schema_invalid');
    for (const [key, value] of Object.entries(flatten(part, contract, seen, depth + 1))) {
      properties[key] = intersect(properties[key], value);
    }
  }
  if (record(schema.properties)) for (const [key, value] of Object.entries(schema.properties)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || !record(value)) throw new Error('official_contract_schema_invalid');
    properties[key] = intersect(properties[key], value);
  }
  return properties;
}

function intersect(previous: Readonly<Record<string, unknown>> | undefined,
  next: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  // Keep simple type/default/enum facts for the UI, while validation retains both full constraints.
  return previous ? { ...previous, ...next, allOf: [previous, next] } : next;
}

export function resolveOfficialValueSchema(contract: OfficialApiContract, schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  let selected = schema;
  const seen = new Set<string>();
  while (typeof selected.$ref === 'string') {
    if (!selected.$ref.startsWith('#/components/schemas/') || seen.has(selected.$ref)) throw new Error('official_contract_reference_invalid');
    seen.add(selected.$ref);
    if (seen.size > 16) throw new Error('official_contract_schema_limit');
    const next = contract.definitions[selected.$ref.slice('#/components/schemas/'.length)];
    if (!next) throw new Error('official_contract_reference_unavailable');
    selected = next;
  }
  return selected;
}

/** Validate a bounded parameter value against its documented local schema. No schema code is executed. */
export function validateOfficialParameterValue(contract: OfficialApiContract, field: string, value: unknown): void {
  const schema = officialRequestProperties(contract)[field];
  if (!schema) throw new Error('official_parameter_not_declared');
  if (!matchesJsonValueSchema(value, expandOfficialValueSchema(contract, schema))) throw new Error('official_parameter_invalid');
}

/** UI and Host share this bounded local expansion and the same portable value validator. */
export function expandOfficialValueSchema(contract: OfficialApiContract, schema: JsonValueSchema): JsonValueSchema {
  const budget = { remaining: 4096 };
  function expand(value: JsonValueSchema, seen: ReadonlySet<string>, depth: number): JsonValueSchema {
    if (depth > 16 || --budget.remaining < 0) throw new Error('official_contract_schema_limit');
    if (typeof value.$ref === 'string') {
      if (seen.has(value.$ref)) throw new Error('official_contract_reference_cycle');
      return expand(resolveOfficialValueSchema(contract, value), new Set([...seen, value.$ref]), depth + 1);
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'properties' && record(item)) result[key] = Object.fromEntries(Object.entries(item).map(([field, child]) => {
        if (!record(child)) throw new Error('official_contract_schema_invalid');
        return [field, expand(child, seen, depth + 1)];
      }));
      else if (['allOf', 'anyOf', 'oneOf'].includes(key) && Array.isArray(item)) result[key] = item.map(child => {
        if (!record(child)) throw new Error('official_contract_schema_invalid');
        return expand(child, seen, depth + 1);
      });
      else if (['items', 'additionalProperties', 'not'].includes(key) && record(item)) result[key] = expand(item, seen, depth + 1);
      else result[key] = item;
    }
    return result;
  }
  return validateJsonValueSchema(expand(schema, new Set(), 0));
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
