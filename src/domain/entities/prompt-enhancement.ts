import type { ParameterValue } from './product-feature';
import type { ProjectContextOutboundSnapshotV1 } from './project-context-selection';

export type PromptEnhanceExecutionMode = 'prompt_once';

export interface PromptEnhancePolicy {
  readonly allowWithoutContext: boolean;
  readonly requireWhenContextExists: boolean;
}

export interface PromptEnhanceInputSnapshotV1 {
  readonly schemaVersion: 1;
  readonly executionMode: PromptEnhanceExecutionMode;
  readonly productFeature: 'text_reasoning';
  readonly originalInput: string;
  readonly structuredInput?: string;
  readonly contextSnapshots: readonly ProjectContextOutboundSnapshotV1[];
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
}

export interface PromptEnhanceRequirement {
  readonly required: boolean;
  readonly satisfied: boolean;
  readonly inputFingerprint: string;
}

export async function promptEnhanceInputFingerprint(input: {
  readonly originalInput: string;
  readonly structuredInput?: string;
  readonly contextSnapshots: readonly ProjectContextOutboundSnapshotV1[];
}): Promise<string> {
  const value = JSON.stringify({
    originalInput: input.originalInput.trim(),
    contexts: input.contextSnapshots.map((context) => ({
      contextId: context.contextId,
      contextRevision: context.contextRevision,
      contentHash: context.contentHash
    })),
    ...(input.structuredInput?.trim()
      ? { structuredInput: input.structuredInput.trim() }
      : {})
  });
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function promptEnhanceSourceReference(input: {
  readonly inputFingerprint: string;
  readonly executionId: string;
}): string {
  return `prompt_enhance:v1:${requireSha256(input.inputFingerprint)}:${requireId(input.executionId)}`;
}

export function parsePromptEnhanceSourceReference(
  value: string | undefined
): { readonly inputFingerprint: string; readonly executionId: string } | undefined {
  if (!value) return undefined;
  const match = /^prompt_enhance:v1:([a-f0-9]{64}):([A-Za-z0-9][A-Za-z0-9._:-]{0,255})$/u.exec(value);
  return match
    ? { inputFingerprint: match[1], executionId: match[2] }
    : undefined;
}

export async function evaluatePromptEnhanceRequirement(input: {
  readonly policy: PromptEnhancePolicy;
  readonly originalInput: string;
  readonly structuredInput?: string;
  readonly contextSnapshots: readonly ProjectContextOutboundSnapshotV1[];
  readonly enhancementSourceReferences: readonly (string | undefined)[];
}): Promise<PromptEnhanceRequirement> {
  const inputFingerprint = await promptEnhanceInputFingerprint(input);
  const hasStructuredContent =
    (input.structuredInput?.trim().length ?? 0) > 0 ||
    input.contextSnapshots.length > 0;
  const required = hasStructuredContent
    ? input.policy.requireWhenContextExists
    : !input.policy.allowWithoutContext;
  const satisfied = input.enhancementSourceReferences.some(
    (reference) =>
      parsePromptEnhanceSourceReference(reference)?.inputFingerprint === inputFingerprint
  );
  return { required, satisfied, inputFingerprint };
}

function requireSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError('Prompt enhance input fingerprint is invalid');
  }
  return value;
}

function requireId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new TypeError('Prompt enhance execution ID is invalid');
  }
  return value;
}
