import { randomUUID } from 'node:crypto';
import {
  parseProviderExecutionRouteSnapshot,
  validateParameterValues,
  type ParameterSchemaV2,
  type ParameterValue,
  type ProviderConnection,
  type ProviderExecutionRouteSnapshotV1,
  type StructuredCredentialRecord
} from '../../domain';
import type { SecureCredentialVault } from './credential-vault';
import {
  DEEPSEEK_CHAT_ADAPTER_ID,
  DEEPSEEK_CHAT_ADAPTER_VERSION,
  DEEPSEEK_CONSTRAINT_SET_ID,
  DEEPSEEK_CREDENTIAL_SCHEMA_ID,
  DEEPSEEK_ENDPOINT_POLICY_ID,
  DEEPSEEK_OFFICIAL_TEMPLATE_ID,
  DEEPSEEK_PROVIDER_PACKAGE_ID,
  DEEPSEEK_PROVIDER_PACKAGE_VERSION,
  DEEPSEEK_REASONING_PARAMETER_SCHEMA_ID,
  DEEPSEEK_RESULT_SCHEMA_ID,
  DEEPSEEK_USAGE_SCHEMA_ID,
  deepSeekReasoningParameterSchema,
  isDeepSeekModelKey,
  type DeepSeekSharedRuntime
} from './deepseek';
import {
  NEWAPI_ADAPTER_VERSION,
  NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_CHAT_RESULT_SCHEMA_ID,
  NEWAPI_CHAT_USAGE_SCHEMA_ID,
  NEWAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID,
  NEWAPI_ENDPOINT_POLICY_ID,
  NEWAPI_PROVIDER_PACKAGE_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION,
  NEWAPI_TEXT_CONSTRAINT_SET_ID,
  matchOpenAiCompatiblePackage,
  newApiDefaultTextReasoningParameterSchema,
  type NewApiSharedRuntime
} from './newapi';
import {
  UNICOMPAPI_ENDPOINT_POLICY_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_VERSION
} from './newapi/unicompapi-contracts';
import type { JsonProviderRegistryStore } from './provider-registry';

export interface PromptOnceTextAdapterRuntimes {
  readonly deepSeekRuntime: DeepSeekSharedRuntime;
  readonly newApiRuntime: NewApiSharedRuntime;
  readonly credentialVault: SecureCredentialVault;
  readonly providerRegistry: JsonProviderRegistryStore;
}

export class PromptOnceTextAdapterError extends Error {
  constructor(readonly safeCode: string, message: string) {
    super(message);
    this.name = 'PromptOnceTextAdapterError';
  }
}

export async function submitPromptOnce(input: {
  readonly runtimes: PromptOnceTextAdapterRuntimes;
  readonly routeSnapshot: ProviderExecutionRouteSnapshotV1;
  readonly prompt: string;
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
  readonly beforeRequestStarted: () => Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<{ readonly content: string; readonly providerOperationId: string }> {
  const route = validatePromptOnceRoute(input.routeSnapshot);
  const providerOperationId = `prompt-once-${randomUUID()}`;
  const registry = await input.runtimes.providerRegistry.load();
  const connection = registry.connections.find((item) => item.id === route.connectionId);
  if (!connection?.credentialReference || connection.credentialVersionId !== route.credentialVersionId) {
    throw new PromptOnceTextAdapterError(
      'prompt_once.credential_unavailable',
      'Prompt once credential is unavailable'
    );
  }
  validatePromptOnceConnection(route, connection);
  const body = serializePromptOnceRequest(route, input.prompt, input.parameterValues);
  const response = await input.runtimes.credentialVault.useRecord(
    connection.credentialReference,
    (credential) => dispatchPromptOnce({
      runtimes: input.runtimes,
      route,
      connection,
      credential,
      body,
      beforeRequestStarted: input.beforeRequestStarted,
      signal: input.signal
    })
  );
  return {
    content: parsePromptOnceResponse(response, route.providerModelKey ?? ''),
    providerOperationId
  };
}

export function validatePromptOnceRoute(value: unknown): ProviderExecutionRouteSnapshotV1 {
  const route = parseProviderExecutionRouteSnapshot(value);
  const openAiIdentityMatches =
    (route.packageId === NEWAPI_PROVIDER_PACKAGE_ID &&
      route.packageVersion === NEWAPI_PROVIDER_PACKAGE_VERSION &&
      route.endpointPolicyId === NEWAPI_ENDPOINT_POLICY_ID) ||
    (route.packageId === UNICOMPAPI_PROVIDER_PACKAGE_ID &&
      route.packageVersion === UNICOMPAPI_PROVIDER_PACKAGE_VERSION &&
      route.endpointPolicyId === UNICOMPAPI_ENDPOINT_POLICY_ID);
  if (
    route.productFeature !== 'text_reasoning' ||
    route.internalPurpose !== 'text_execution' ||
    !route.providerModelKey
  ) {
    throw new PromptOnceTextAdapterError(
      'prompt_once.route_mismatch',
      'Prompt once route is not supported'
    );
  }
  if (
    route.packageId === DEEPSEEK_PROVIDER_PACKAGE_ID &&
    (route.packageVersion !== DEEPSEEK_PROVIDER_PACKAGE_VERSION ||
      route.adapterKey !== DEEPSEEK_CHAT_ADAPTER_ID ||
      route.adapterVersion !== DEEPSEEK_CHAT_ADAPTER_VERSION ||
      route.endpointPolicyId !== DEEPSEEK_ENDPOINT_POLICY_ID ||
      route.endpointPolicyRevision !== 1 ||
      route.parameterSchemaId !== DEEPSEEK_REASONING_PARAMETER_SCHEMA_ID ||
      route.parameterSchemaRevision !== 1 ||
      route.resultSchemaId !== DEEPSEEK_RESULT_SCHEMA_ID ||
      route.resultSchemaRevision !== 1 ||
      route.usageSchemaId !== DEEPSEEK_USAGE_SCHEMA_ID ||
      route.usageSchemaRevision !== 1 ||
      route.constraintSetId !== DEEPSEEK_CONSTRAINT_SET_ID ||
      route.constraintSetRevision !== 1 ||
      !isDeepSeekModelKey(route.providerModelKey))
  ) {
    throw new PromptOnceTextAdapterError('prompt_once.route_mismatch', 'DeepSeek route mismatch');
  }
  if (
    route.packageId !== DEEPSEEK_PROVIDER_PACKAGE_ID &&
    (!openAiIdentityMatches ||
      route.adapterKey !== NEWAPI_CHAT_ADAPTER_ID ||
      route.adapterVersion !== NEWAPI_ADAPTER_VERSION ||
      route.parameterSchemaId !== NEWAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID ||
      route.parameterSchemaRevision !== newApiDefaultTextReasoningParameterSchema.revision ||
      route.resultSchemaId !== NEWAPI_CHAT_RESULT_SCHEMA_ID ||
      route.resultSchemaRevision !== 1 ||
      route.usageSchemaId !== NEWAPI_CHAT_USAGE_SCHEMA_ID ||
      route.usageSchemaRevision !== 1 ||
      route.constraintSetId !== NEWAPI_TEXT_CONSTRAINT_SET_ID ||
      route.constraintSetRevision !== 1)
  ) {
    throw new PromptOnceTextAdapterError('prompt_once.route_mismatch', 'OpenAI route mismatch');
  }
  return route;
}

function validatePromptOnceConnection(
  route: ProviderExecutionRouteSnapshotV1,
  connection: ProviderConnection
): void {
  if (
    connection.packageId !== route.packageId ||
    connection.packageVersion !== route.packageVersion ||
    connection.state !== 'available' ||
    connection.identityState !== 'verified' ||
    connection.credentialState !== 'valid' ||
    connection.connectionRevision !== route.connectionRevision ||
    connection.connectionConfigVersionId !== route.connectionConfigVersionId ||
    connection.endpointPolicyId !== route.endpointPolicyId ||
    connection.endpointPolicyRevision !== route.endpointPolicyRevision
  ) {
    throw new PromptOnceTextAdapterError(
      'prompt_once.route_mismatch',
      'Prompt once connection identity changed'
    );
  }
  if (
    route.packageId !== DEEPSEEK_PROVIDER_PACKAGE_ID &&
    !matchOpenAiCompatiblePackage({
      packageId: connection.packageId,
      packageVersion: connection.packageVersion,
      templateId: connection.templateId,
      credentialSchemaId: connection.credentialSchemaId,
      credentialSchemaVersion: connection.credentialSchemaVersion,
      endpointPolicyId: connection.endpointPolicyId,
      endpointPolicyRevision: connection.endpointPolicyRevision
    })
  ) {
    throw new PromptOnceTextAdapterError(
      'prompt_once.route_mismatch',
      'Prompt once package identity changed'
    );
  }
  if (
    route.packageId === DEEPSEEK_PROVIDER_PACKAGE_ID &&
    !(
      connection.templateId === DEEPSEEK_OFFICIAL_TEMPLATE_ID &&
      connection.credentialSchemaId === DEEPSEEK_CREDENTIAL_SCHEMA_ID &&
      connection.credentialSchemaVersion === 1
    )
  ) {
    throw new PromptOnceTextAdapterError(
      'prompt_once.route_mismatch',
      'Prompt once DeepSeek identity changed'
    );
  }
}

export function serializePromptOnceRequest(
  route: ProviderExecutionRouteSnapshotV1,
  prompt: string,
  parameterValues: Readonly<Record<string, ParameterValue>>
): Uint8Array {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt || normalizedPrompt.length > 500_000 || /\u0000/u.test(normalizedPrompt)) {
    throw new PromptOnceTextAdapterError('prompt_once.invalid_request', 'Prompt once input is invalid');
  }
  assertPromptOnceParameterKeys(parameterValues);
  const schema = parameterSchema(route);
  const parameters = validateParameterValues(schema, 'full', parameterValues);
  const body: Record<string, unknown> = {
    model: route.providerModelKey,
    messages: [{ role: 'user', content: normalizedPrompt }],
    ...parameters,
    stream: false
  };
  if (route.packageId === DEEPSEEK_PROVIDER_PACKAGE_ID) {
    body.thinking = { type: 'enabled' };
  }
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  if (encoded.byteLength > 2 * 1024 * 1024) {
    throw new PromptOnceTextAdapterError('prompt_once.invalid_request', 'Prompt once request is too large');
  }
  return encoded;
}

export function isPromptOnceUserParameter(fieldId: string): boolean {
  return ['max_tokens', 'max_completion_tokens', 'reasoning_effort'].includes(fieldId);
}

function assertPromptOnceParameterKeys(
  parameterValues: Readonly<Record<string, ParameterValue>>
): void {
  if (Object.keys(parameterValues).some((fieldId) => !isPromptOnceUserParameter(fieldId))) {
    throw new PromptOnceTextAdapterError(
      'prompt_once.invalid_request',
      'Prompt once parameters can only control output length and reasoning effort'
    );
  }
}

async function dispatchPromptOnce(input: {
  readonly runtimes: PromptOnceTextAdapterRuntimes;
  readonly route: ProviderExecutionRouteSnapshotV1;
  readonly connection: ProviderConnection;
  readonly credential: StructuredCredentialRecord;
  readonly body: Uint8Array;
  readonly beforeRequestStarted: () => Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<Uint8Array> {
  if (input.route.packageId === DEEPSEEK_PROVIDER_PACKAGE_ID) {
    return input.runtimes.deepSeekRuntime.requestChatCompletion({
      credentials: input.credential,
      body: input.body,
      signal: input.signal,
      beforeRequestStarted: input.beforeRequestStarted
    });
  }
  return input.runtimes.newApiRuntime.requestChatCompletion({
    connection: input.connection,
    credentials: input.credential,
    body: input.body,
    signal: input.signal,
    beforeRequestStarted: input.beforeRequestStarted
  });
}

export function parsePromptOnceResponse(body: Uint8Array, expectedModel: string): string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new PromptOnceTextAdapterError('prompt_once.invalid_response', 'Prompt once JSON is invalid');
  }
  if (!isRecord(value) || value.object !== 'chat.completion' || !Array.isArray(value.choices)) {
    throw new PromptOnceTextAdapterError('prompt_once.invalid_response', 'Prompt once response shape is invalid');
  }
  if (typeof value.model === 'string' && expectedModel && value.model !== expectedModel) {
    throw new PromptOnceTextAdapterError('prompt_once.invalid_response', 'Prompt once model changed');
  }
  if (value.choices.length !== 1 || !isRecord(value.choices[0])) {
    throw new PromptOnceTextAdapterError('prompt_once.invalid_response', 'Prompt once choices are invalid');
  }
  const choice = value.choices[0];
  if (choice.index !== 0 || choice.finish_reason !== 'stop') {
    throw new PromptOnceTextAdapterError('prompt_once.invalid_response', 'Prompt once finish reason is invalid');
  }
  if (!isRecord(choice.message) || choice.message.role !== 'assistant') {
    throw new PromptOnceTextAdapterError('prompt_once.invalid_response', 'Prompt once message is invalid');
  }
  const content = choice.message.content;
  if (typeof content !== 'string' || !content.trim() || content.length > 1_000_000) {
    throw new PromptOnceTextAdapterError('prompt_once.invalid_response', 'Prompt once content is invalid');
  }
  return content.trim();
}

function parameterSchema(route: ProviderExecutionRouteSnapshotV1): ParameterSchemaV2 {
  const schema = route.packageId === DEEPSEEK_PROVIDER_PACKAGE_ID
    ? deepSeekReasoningParameterSchema
    : newApiDefaultTextReasoningParameterSchema;
  if (schema.schemaId !== route.parameterSchemaId || schema.revision !== route.parameterSchemaRevision) {
    throw new PromptOnceTextAdapterError(
      'prompt_once.parameter_schema_unavailable',
      'Prompt once parameter schema is unavailable'
    );
  }
  return schema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
