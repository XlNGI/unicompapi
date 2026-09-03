import type { DocumentWorkspaceKind } from './document-generation';

export const conversationIntentKinds = ['chat', 'document', 'unknown'] as const;
export type ConversationIntentKind = (typeof conversationIntentKinds)[number];

export const conversationIntentActions = [
  'answer',
  'create',
  'revise',
  'analyze'
] as const;
export type ConversationIntentAction = (typeof conversationIntentActions)[number];

export const conversationIntentSourcePolicies = [
  'none',
  'internal',
  'web',
  'mixed'
] as const;
export type ConversationIntentSourcePolicy =
  (typeof conversationIntentSourcePolicies)[number];

export const conversationIntentConfidenceLevels = [
  'high',
  'medium',
  'low'
] as const;
export type ConversationIntentConfidence =
  (typeof conversationIntentConfidenceLevels)[number];

export const conversationIntentReadiness = [
  'ready',
  'needs_clarification',
  'needs_confirmation'
] as const;
export type ConversationIntentReadiness =
  (typeof conversationIntentReadiness)[number];

export type ConversationIntentParameter = string | number | boolean;

export interface ConversationIntentTargetHint {
  readonly unit:
    | 'document'
    | 'version'
    | 'page'
    | 'section'
    | 'table'
    | 'cell'
    | 'block';
  readonly ordinal?: number;
  readonly name?: string;
}

export interface ConversationIntentPlan {
  readonly schemaVersion: 1;
  readonly kind: ConversationIntentKind;
  readonly action?: ConversationIntentAction;
  readonly documentKind?: DocumentWorkspaceKind | 'auto';
  readonly targetHint?: ConversationIntentTargetHint;
  readonly parameters: Readonly<Record<string, ConversationIntentParameter>>;
  readonly sourcePolicy: ConversationIntentSourcePolicy;
  readonly missing: readonly string[];
  readonly ambiguities: readonly string[];
  readonly confidence: ConversationIntentConfidence;
  readonly needsConfirmation: boolean;
}

export interface ConversationIntentAssessment {
  readonly readiness: ConversationIntentReadiness;
  readonly reasons: readonly string[];
}

const maxText = 2_000;
const maxList = 32;

export function parseConversationIntentPlan(
  value: unknown
): ConversationIntentPlan {
  if (!isRecord(value)) throw new TypeError('Conversation intent plan must be an object');
  requireExactKeys(value, [
    'schemaVersion',
    'kind',
    'action',
    'documentKind',
    'targetHint',
    'parameters',
    'sourcePolicy',
    'missing',
    'ambiguities',
    'confidence',
    'needsConfirmation'
  ]);
  if (value.schemaVersion !== 1) throw new TypeError('Conversation intent plan schemaVersion is invalid');
  const kind = requireEnum(value.kind, conversationIntentKinds, 'kind');
  const action = value.action === undefined
    ? undefined
    : requireEnum(value.action, conversationIntentActions, 'action');
  const documentKind = value.documentKind === undefined
    ? undefined
    : requireEnum(value.documentKind, ['auto', 'word', 'excel', 'ppt'] as const, 'documentKind');
  const parameters = parseParameters(value.parameters);
  const missing = parseTextList(value.missing, 'missing');
  const ambiguities = parseTextList(value.ambiguities, 'ambiguities');
  const confidence = requireEnum(
    value.confidence,
    conversationIntentConfidenceLevels,
    'confidence'
  );
  if (typeof value.needsConfirmation !== 'boolean') {
    throw new TypeError('Conversation intent plan needsConfirmation is invalid');
  }
  if (kind === 'chat' && (action !== undefined || documentKind !== undefined || value.targetHint !== undefined)) {
    throw new TypeError('chat intent cannot contain document execution fields');
  }
  if (kind === 'document' && action === undefined) {
    throw new TypeError('document intent requires action');
  }
  if (kind === 'unknown' && action !== undefined) {
    throw new TypeError('unknown intent cannot choose an action');
  }
  return {
    schemaVersion: 1,
    kind,
    ...(action !== undefined ? { action } : {}),
    ...(documentKind !== undefined ? { documentKind } : {}),
    ...(value.targetHint !== undefined
      ? { targetHint: parseTargetHint(value.targetHint) }
      : {}),
    parameters,
    sourcePolicy: requireEnum(
      value.sourcePolicy,
      conversationIntentSourcePolicies,
      'sourcePolicy'
    ),
    missing,
    ambiguities,
    confidence,
    needsConfirmation: value.needsConfirmation
  };
}

export function assessConversationIntentPlan(
  plan: ConversationIntentPlan
): ConversationIntentAssessment {
  const reasons = [...plan.missing, ...plan.ambiguities];
  if (plan.kind === 'unknown' || plan.confidence === 'low') {
    return { readiness: 'needs_clarification', reasons: reasons.length ? reasons : ['unknown_intent'] };
  }
  if (reasons.length > 0) return { readiness: 'needs_clarification', reasons };
  if (plan.needsConfirmation || plan.confidence === 'medium') {
    return { readiness: 'needs_confirmation', reasons: [] };
  }
  return { readiness: 'ready', reasons: [] };
}

function parseTargetHint(value: unknown): ConversationIntentTargetHint {
  if (!isRecord(value)) throw new TypeError('Conversation intent targetHint is invalid');
  requireExactKeys(value, ['unit', 'ordinal', 'name']);
  const unit = requireEnum(value.unit, [
    'document',
    'version',
    'page',
    'section',
    'table',
    'cell',
    'block'
  ] as const, 'targetHint.unit');
  const ordinal = value.ordinal === undefined ? undefined : requirePositiveInteger(value.ordinal, 'targetHint.ordinal');
  const name = value.name === undefined ? undefined : requireText(value.name, 'targetHint.name');
  if (ordinal === undefined && name === undefined) throw new TypeError('targetHint requires ordinal or name');
  return {
    unit,
    ...(ordinal !== undefined ? { ordinal } : {}),
    ...(name !== undefined ? { name } : {})
  };
}

function parseParameters(value: unknown): Readonly<Record<string, ConversationIntentParameter>> {
  if (!isRecord(value)) throw new TypeError('Conversation intent parameters are invalid');
  const result: Record<string, ConversationIntentParameter> = {};
  const entries = Object.entries(value);
  if (entries.length > maxList) throw new TypeError('Conversation intent parameters are too many');
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) throw new TypeError('Conversation intent parameter name is invalid');
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new TypeError('Conversation intent parameter value is invalid');
    }
    if (typeof item === 'string' && item.length > maxText) throw new TypeError('Conversation intent parameter is too long');
    if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('Conversation intent parameter number is invalid');
    result[key] = item;
  }
  return result;
}

function parseTextList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > maxList) throw new TypeError(`Conversation intent ${label} is invalid`);
  return value.map((item) => requireText(item, `${label}[]`));
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new TypeError('Conversation intent plan contains unsupported fields');
}

function requireEnum<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new TypeError(`Conversation intent ${label} is invalid`);
  return value as T;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxText) throw new TypeError(`Conversation intent ${label} is invalid`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`Conversation intent ${label} is invalid`);
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
