export const presentationOrganizationLayouts = ['comparison', 'metrics', 'sequence', 'evidence', 'grouped'] as const;
export const presentationOrganizationGroupRoles = ['header', 'comparison-side', 'metric', 'step', 'evidence', 'content', 'supporting'] as const;
export const presentationOrganizationRelationshipKinds = ['compare', 'sequence', 'supports'] as const;

/** Page-local semantic keys are suggestions, never document or runtime identities. */
export interface PresentationContentOrganizationGroup {
  readonly groupId: string;
  readonly role: (typeof presentationOrganizationGroupRoles)[number];
  readonly contentRefs: readonly string[];
}
export interface PresentationContentOrganizationRelationship {
  readonly kind: (typeof presentationOrganizationRelationshipKinds)[number];
  readonly fromGroupId: string;
  readonly toGroupId: string;
}
export interface PresentationContentOrganizationV1 {
  readonly schemaVersion: 1;
  readonly layout: (typeof presentationOrganizationLayouts)[number];
  readonly groups: readonly PresentationContentOrganizationGroup[];
  readonly relationships: readonly PresentationContentOrganizationRelationship[];
}
export class PresentationContentOrganizationParseError extends TypeError {
  readonly code = 'presentation_content_organization_invalid';
  constructor(readonly path: string, readonly reason: 'invalid_shape' | 'unknown_field' | 'invalid_enum' | 'invalid_content_reference' | 'invalid_relationship') {
    super(reason);
    this.name = 'PresentationContentOrganizationParseError';
  }
}

const referencePattern = '^outline\\.(?:title|sections\\[(?:0|[1-9]\\d*)\\](?:\\.(?:heading|takeaway|action|blocks\\[(?:0|[1-9]\\d*)\\](?:\\.items\\[(?:0|[1-9]\\d*)\\])?))?)$';
const keyPattern = '^[A-Za-z][A-Za-z0-9_-]{0,47}$';
const contentReference = new RegExp(referencePattern, 'u');
const semanticGroupKey = new RegExp(keyPattern, 'u');

/** Closed metadata only; leaf expansion and complete business coverage belong to Host features. */
export function parsePresentationContentOrganization(value: unknown, options: {
  readonly allowedContentRefs?: readonly string[];
} = {}): PresentationContentOrganizationV1 {
  const record = object(value, '$', ['schemaVersion', 'layout', 'groups', 'relationships']);
  if (record.schemaVersion !== 1) invalid('$.schemaVersion');
  const layout = enumValue(record.layout, presentationOrganizationLayouts, '$.layout');
  if (!Array.isArray(record.groups) || record.groups.length < 1 || record.groups.length > 16) invalid('$.groups');
  const ids = new Set<string>();
  const refs = new Set<string>();
  const allowed = options.allowedContentRefs === undefined ? undefined : new Set(options.allowedContentRefs);
  const groups = record.groups.map((raw, index): PresentationContentOrganizationGroup => {
    const path = `$.groups[${index}]`;
    const group = object(raw, path, ['groupId', 'role', 'contentRefs']);
    const groupId = semanticKey(group.groupId, `${path}.groupId`);
    if (ids.has(groupId)) invalid(`${path}.groupId`);
    ids.add(groupId);
    const role = enumValue(group.role, presentationOrganizationGroupRoles, `${path}.role`);
    if (!Array.isArray(group.contentRefs) || group.contentRefs.length < 1 || group.contentRefs.length > 128) invalid(`${path}.contentRefs`);
    const contentRefs = group.contentRefs.map((ref, refIndex): string => {
      const refPath = `${path}.contentRefs[${refIndex}]`;
      if (typeof ref !== 'string' || ref.length > 120 || !contentReference.test(ref) ||
        refs.has(ref) || (allowed && !allowed.has(ref))) throw new PresentationContentOrganizationParseError(refPath, 'invalid_content_reference');
      refs.add(ref);
      if (refs.size > 512) invalid('$.groups');
      return ref;
    });
    return Object.freeze({ groupId, role, contentRefs: Object.freeze(contentRefs) });
  });
  if (!Array.isArray(record.relationships) || record.relationships.length > 32) invalid('$.relationships');
  const seen = new Set<string>();
  const edges = new Map([...ids].map(id => [id, new Set<string>()]));
  const relationships = record.relationships.map((raw, index): PresentationContentOrganizationRelationship => {
    const path = `$.relationships[${index}]`;
    const relation = object(raw, path, ['kind', 'fromGroupId', 'toGroupId']);
    const kind = enumValue(relation.kind, presentationOrganizationRelationshipKinds, `${path}.kind`);
    const fromGroupId = semanticKey(relation.fromGroupId, `${path}.fromGroupId`);
    const toGroupId = semanticKey(relation.toGroupId, `${path}.toGroupId`);
    const pair = kind === 'compare' ? [fromGroupId, toGroupId].sort() : [fromGroupId, toGroupId];
    const key = JSON.stringify([kind, ...pair]);
    if (!ids.has(fromGroupId) || !ids.has(toGroupId) || fromGroupId === toGroupId || seen.has(key))
      throw new PresentationContentOrganizationParseError(path, 'invalid_relationship');
    seen.add(key);
    if (kind !== 'compare') edges.get(fromGroupId)!.add(toGroupId);
    return Object.freeze({ kind, fromGroupId, toGroupId });
  });
  const pending = new Set<string>();
  const completed = new Set<string>();
  const visit = (id: string): void => {
    if (pending.has(id)) throw new PresentationContentOrganizationParseError('$.relationships', 'invalid_relationship');
    if (completed.has(id)) return;
    pending.add(id);
    for (const next of edges.get(id)!) visit(next);
    pending.delete(id); completed.add(id);
  };
  for (const id of ids) visit(id);
  return Object.freeze({ schemaVersion: 1, layout, groups: Object.freeze(groups), relationships: Object.freeze(relationships) });
}

export function buildPresentationContentOrganizationJsonSchema(): Record<string, unknown> {
  const objectSchema = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
  const key = { type: 'string', minLength: 1, maxLength: 48, pattern: keyPattern };
  const enumeration = (values: readonly string[]) => ({ type: 'string', enum: values });
  return objectSchema({ schemaVersion: { const: 1 }, layout: enumeration(presentationOrganizationLayouts),
    groups: { type: 'array', minItems: 1, maxItems: 16, items: objectSchema({ groupId: key,
      role: enumeration(presentationOrganizationGroupRoles), contentRefs: { type: 'array', minItems: 1, maxItems: 128,
        uniqueItems: true, items: { type: 'string', maxLength: 120, pattern: referencePattern } } }) },
    relationships: { type: 'array', maxItems: 32, items: objectSchema({ kind: enumeration(presentationOrganizationRelationshipKinds), fromGroupId: key, toGroupId: key }) }
  });
}
function invalid(path: string): never { throw new PresentationContentOrganizationParseError(path, 'invalid_shape'); }
function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid(path);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) throw new PresentationContentOrganizationParseError(path, 'unknown_field');
  if (keys.some(key => !Object.prototype.hasOwnProperty.call(record, key))) invalid(path);
  return record;
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new PresentationContentOrganizationParseError(path, 'invalid_enum');
  return value as T;
}
function semanticKey(value: unknown, path: string): string {
  if (typeof value !== 'string' || !semanticGroupKey.test(value) ||
      /^(?:work|file|execution|task|response|conversation|agent|project|session|provider|asset|credential|token|checkpoint)[-_]/iu.test(value) ||
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(value)) invalid(path);
  return value;
}
