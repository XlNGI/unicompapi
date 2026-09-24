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

/**
 * An ordered semantic sub-goal inside one user request.  It is deliberately
 * still a data contract: the model may describe intent and dependencies, but
 * it cannot choose paths, providers, credentials, permissions or commands.
 */
export interface ConversationIntentStep {
  readonly stepId: string;
  readonly kind: 'chat' | 'document';
  readonly action: ConversationIntentAction;
  readonly documentKind?: DocumentWorkspaceKind | 'auto';
  readonly dependsOn: readonly string[];
  readonly parameters: Readonly<Record<string, ConversationIntentParameter>>;
  readonly sourcePolicy: ConversationIntentSourcePolicy;
  readonly missing: readonly string[];
  readonly confidence: ConversationIntentConfidence;
  readonly needsConfirmation: boolean;
}

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
  readonly deliverables?: readonly DocumentWorkspaceKind[];
  /** Ordered sub-goals for compound requests; omitted for a single goal. */
  readonly steps?: readonly ConversationIntentStep[];
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
    'deliverables',
    'steps',
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
  const deliverables = value.deliverables === undefined ? undefined : parseDeliverables(value.deliverables);
  const steps = value.steps === undefined ? undefined : parseSteps(value.steps);
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
  if (kind === 'chat' && (action !== undefined || documentKind !== undefined || deliverables !== undefined || steps !== undefined || value.targetHint !== undefined)) {
    throw new TypeError('chat intent cannot contain document execution fields');
  }
  if (kind === 'document' && action === undefined) {
    throw new TypeError('document intent requires action');
  }
  if (kind === 'unknown' && action !== undefined) {
    throw new TypeError('unknown intent cannot choose an action');
  }
  if (deliverables && (kind !== 'document' || action !== 'create' || !documentKind || documentKind === 'auto' || !deliverables.includes(documentKind))) {
    throw new TypeError('Document deliverables require a creation plan with an active output kind');
  }
  if (steps && kind !== 'document') throw new TypeError('Conversation steps require a document plan');
  return {
    schemaVersion: 1,
    kind,
    ...(action !== undefined ? { action } : {}),
    ...(documentKind !== undefined ? { documentKind } : {}),
    ...(deliverables ? { deliverables } : {}),
    ...(steps ? { steps } : {}),
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

function parseSteps(value: unknown): readonly ConversationIntentStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new TypeError('Conversation intent steps are invalid');
  }
  const ids = new Set<string>();
  const steps = value.map((item, index) => {
    const label = `steps[${index}]`;
    if (!isRecord(item)) throw new TypeError(`Conversation intent ${label} is invalid`);
    requireExactKeys(item, [
      'stepId', 'kind', 'action', 'documentKind', 'dependsOn', 'parameters',
      'sourcePolicy', 'missing', 'confidence', 'needsConfirmation'
    ]);
    const stepId = requireIdentifier(item.stepId, `${label}.stepId`);
    if (ids.has(stepId)) throw new TypeError('Conversation intent step IDs must be unique');
    ids.add(stepId);
    const kind = requireEnum(item.kind, ['chat', 'document'] as const, `${label}.kind`);
    const action = requireEnum(item.action, conversationIntentActions, `${label}.action`);
    const documentKind = item.documentKind === undefined
      ? undefined
      : requireEnum(item.documentKind, ['auto', 'word', 'excel', 'ppt'] as const, `${label}.documentKind`);
    if (kind === 'chat' && documentKind !== undefined) throw new TypeError('Chat intent step cannot contain documentKind');
    if (kind === 'document' && documentKind === undefined) throw new TypeError('Document intent step requires documentKind');
    if (!Array.isArray(item.dependsOn) || item.dependsOn.length > 8 || item.dependsOn.some((dep) => typeof dep !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(dep))) {
      throw new TypeError(`${label}.dependsOn is invalid`);
    }
    const dependsOn = [...new Set(item.dependsOn as string[])];
    const parameters = parseParameters(item.parameters);
    const sourcePolicy = requireEnum(item.sourcePolicy, conversationIntentSourcePolicies, `${label}.sourcePolicy`);
    const missing = parseTextList(item.missing, `${label}.missing`);
    const confidence = requireEnum(item.confidence, conversationIntentConfidenceLevels, `${label}.confidence`);
    if (typeof item.needsConfirmation !== 'boolean') throw new TypeError(`${label}.needsConfirmation is invalid`);
    return {
      stepId,
      kind,
      action,
      ...(documentKind !== undefined ? { documentKind } : {}),
      dependsOn,
      parameters,
      sourcePolicy,
      missing,
      confidence,
      needsConfirmation: item.needsConfirmation
    };
  });
  const known = new Set(steps.map((step) => step.stepId));
  for (const step of steps) {
    if (step.dependsOn.includes(step.stepId) || step.dependsOn.some((dependency) => !known.has(dependency))) {
      throw new TypeError('Conversation intent step dependency is invalid');
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new TypeError('Conversation intent step dependencies contain a cycle');
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  steps.forEach((step) => visit(step.stepId));
  return steps;
}

function parseDeliverables(value: unknown): readonly DocumentWorkspaceKind[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length) {
    throw new TypeError('Document deliverables must contain one to three unique output kinds');
  }
  return value.map((item) => requireEnum(item, ['word', 'excel', 'ppt'] as const, 'deliverables[]'));
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
    if (typeof item === 'string' && item.length > (key === 'requirements' ? 16_000 : maxText)) throw new TypeError('Conversation requirements exceed the supported task context; please start a new task or shorten the requirements');
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

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`Conversation intent ${label} is invalid`);
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
