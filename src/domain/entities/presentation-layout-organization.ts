import { parsePresentationContentOrganization, type PresentationContentOrganizationGroup,
  type PresentationContentOrganizationRelationship, type PresentationContentOrganizationV1 } from './presentation-content-organization';

/** Host-owned group identities and canonical content membership; no duplicate geometry. */
export interface PresentationLayoutOrganizationV1 {
  readonly schemaVersion: 1;
  readonly source: 'explicit' | 'inferred';
  readonly layout: PresentationContentOrganizationV1['layout'];
  readonly groups: readonly {
    readonly groupId: string;
    readonly role: PresentationContentOrganizationGroup['role'];
    readonly sourceRefs: readonly string[];
  }[];
  readonly relationships: readonly PresentationContentOrganizationRelationship[];
}

export function parsePresentationLayoutOrganization(value: unknown, expectedContentRefs: readonly string[]): PresentationLayoutOrganizationV1 {
  const raw = record(value, ['schemaVersion', 'source', 'layout', 'groups', 'relationships']);
  if (raw.schemaVersion !== 1 || !['explicit', 'inferred'].includes(String(raw.source)) ||
    !Array.isArray(raw.groups) || raw.groups.length < 1 || raw.groups.length > 16 ||
    !Array.isArray(raw.relationships) || raw.relationships.length > 32) invalid();
  const seen = new Set<string>();
  const expected = new Set(expectedContentRefs);
  const groups = raw.groups.map(groupValue => {
    const group = record(groupValue, ['groupId', 'role', 'sourceRefs']);
    if (typeof group.groupId !== 'string' || !/^group-[a-f0-9]{32}$/u.test(group.groupId) ||
      !Array.isArray(group.sourceRefs) || group.sourceRefs.length < 1 || group.sourceRefs.length > 128) invalid();
    const sourceRefs = group.sourceRefs.map(reference => {
      if (typeof reference !== 'string' || !expected.has(reference) || seen.has(reference)) invalid();
      seen.add(reference); return reference;
    });
    return { groupId: group.groupId, role: group.role as PresentationContentOrganizationGroup['role'], sourceRefs };
  });
  if (seen.size !== expected.size) invalid();
  // Reuse the closed semantic vocabulary, keys, edge and cycle checks without
  // exposing canonical IDs as model references or admitting another inventory.
  const aliases = new Map(expectedContentRefs.map((reference, index) => [reference, `outline.sections[0].blocks[${index}]`]));
  try {
    parsePresentationContentOrganization({ schemaVersion: 1, layout: raw.layout,
      groups: groups.map(group => ({ groupId: group.groupId, role: group.role,
        contentRefs: group.sourceRefs.map(reference => aliases.get(reference)) })), relationships: raw.relationships });
  } catch { invalid(); }
  return structuredClone(raw) as unknown as PresentationLayoutOrganizationV1;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))) invalid();
  return raw;
}
function invalid(): never { throw new TypeError('layout_organization_invalid'); }
