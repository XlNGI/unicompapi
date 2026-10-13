import { createHash } from 'node:crypto';
import { buildCompatibleParameterSchema, mapCompatibleParameterValues, parseModelApiContractBinding,
  type ModelApiContractBindingV1, type ParameterFieldSchemaV2, type ParameterSchemaV2, type ParameterValue, type ProductFeature } from '../../../domain';
import { expandOfficialValueSchema, getOfficialApiContract, officialApiContractFingerprint, officialRequestProperties, officialRequestRequiredParameters, resolveOfficialValueSchema, validateOfficialParameterValue } from './official-api-contracts';

const hostFields = new Set(['model', 'messages', 'tools', 'stream', 'stream_options']);
const unsupportedProductFields = new Set(['logprobs', 'top_logprobs', 'prediction']);

export function buildBoundTextParameterSchema(input: ModelApiContractBindingV1, feature: ProductFeature): ParameterSchemaV2 {
  if (feature !== 'text_chat' && feature !== 'text_reasoning') throw new Error('official_text_feature_mismatch');
  const binding = parseModelApiContractBinding(input);
  const contract = getOfficialApiContract(binding.contractId, binding.contractRevision);
  const contractFingerprint = officialApiContractFingerprint(contract);
  if (binding.contractFingerprint !== undefined && binding.contractFingerprint !== contractFingerprint) throw new Error('official_contract_changed');
  if (!contract.id.endsWith('.chat')) throw new Error('official_text_contract_mismatch');
  const requiredFields = officialRequestRequiredParameters(contract);
  const fields: ParameterFieldSchemaV2[] = [];
  for (const [fieldId, unresolved] of Object.entries(officialRequestProperties(contract))) {
    if (requiredFields.has(fieldId) && unsupportedProductFields.has(fieldId)) throw new Error('official_required_parameter_unsupported');
    if (hostFields.has(fieldId) || unsupportedProductFields.has(fieldId) || unresolved.deprecated === true) continue;
    // Schema union input remains JSON in the UI; strings and objects are both valid for tool_choice/stop.
    const schema = resolveOfficialValueSchema(contract, unresolved);
    if ('const' in schema) continue; // Documented fixed fields use the provider default, without a writable UI control.
    const type = schema.type;
    const valueType = Array.isArray(schema.enum) ? 'enum' : type === 'integer' ? 'integer' : type === 'number' ? 'number'
      : type === 'boolean' ? 'boolean' : type === 'string' ? 'string' : type === 'object' ? 'object' : 'json';
    if (schema.deprecated === true) continue;
    const validationSchema = expandOfficialValueSchema(contract, schema);
    fields.push({ fieldId, labelId: `provider.parameter.${fieldId}`, groupId: 'provider.parameter.generation', order: (fields.length + 1) * 10,
      valueType, required: requiredFields.has(fieldId), exposure: requiredFields.has(fieldId) ? 'user_required' : 'user_optional',
      defaultPolicy: requiredFields.has(fieldId) ? 'require_user_value' : 'omit_use_provider_default', validationSchema,
      ...(Array.isArray(schema.enum) ? { options: schema.enum as readonly (string | number | boolean)[] } : {}),
      ...(typeof schema.minimum === 'number' ? { minimum: schema.minimum } : {}), ...(typeof schema.maximum === 'number' ? { maximum: schema.maximum } : {}) });
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ binding, feature, contractFingerprint })).digest('hex').slice(0, 24);
  return buildCompatibleParameterSchema({ schemaVersion: 2, schemaId: `parameters.bound.${fingerprint}`, revision: binding.contractRevision, productFeature: feature, fields }, binding);
}

export function mapBoundTextParameters(binding: ModelApiContractBindingV1, feature: ProductFeature,
  values: Readonly<Record<string, ParameterValue>>): Readonly<Record<string, ParameterValue>> {
  const schema = buildBoundTextParameterSchema(binding, feature);
  const contract = getOfficialApiContract(binding.contractId, binding.contractRevision);
  for (const [field, value] of Object.entries(values)) validateOfficialParameterValue(contract, field, value);
  if (contract.conditions?.includes('json_schema_format_requires_definition') && record(values.response_format) &&
      values.response_format.type === 'json_schema' && !record(values.response_format.json_schema)) {
    throw new Error('official_parameter_json_schema_required');
  }
  if (contract.conditions?.includes('stop_sequence_max_32_utf8_bytes')) {
    const stops = typeof values.stop === 'string' ? [values.stop] : Array.isArray(values.stop) ? values.stop : [];
    if (stops.some(stop => typeof stop !== 'string' || new TextEncoder().encode(stop).byteLength > 32)) throw new Error('official_parameter_stop_invalid');
  }
  if (contract.vendor === 'deepseek' && values.top_logprobs !== undefined && values.logprobs !== true) throw new Error('official_parameter_logprobs_required');
  if (contract.conditions?.includes('temperature_depends_on_thinking_mode') && values.temperature !== undefined) {
    const expected = record(values.thinking) && values.thinking.type === 'disabled' ? 0.6 : 1;
    if (values.temperature !== expected) throw new Error('official_parameter_temperature_thinking_mismatch');
  }
  if (contract.conditions?.includes('required_and_named_tools_require_non_thinking_mode') &&
      (values.tool_choice === 'required' || record(values.tool_choice))) {
    const disabled = record(values.thinking) && values.thinking.type === 'disabled' ||
      values.reasoning_effort === 'none' || values.reasoning_effort === 'minimal';
    if (!disabled) throw new Error('official_parameter_tool_choice_requires_non_thinking');
  }
  return mapCompatibleParameterValues(schema, binding, values);
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
