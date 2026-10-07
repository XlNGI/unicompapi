import { describe, expect, it } from 'vitest';
import { buildPresentationContentOrganizationJsonSchema, parsePresentationContentOrganization,
  PresentationContentOrganizationParseError, type PresentationContentOrganizationV1 } from '../../src/domain/entities/presentation-content-organization';

const heading = 'outline.sections[0].heading';
const first = 'outline.sections[0].blocks[0]';
const second = 'outline.sections[0].blocks[1]';
function valid(): PresentationContentOrganizationV1 {
  return { schemaVersion: 1, layout: 'comparison', groups: [
    { groupId: 'headline', role: 'header', contentRefs: [heading] },
    { groupId: 'option-a', role: 'comparison-side', contentRefs: [first] },
    { groupId: 'option-b', role: 'comparison-side', contentRefs: [second] }
  ], relationships: [{ kind: 'compare', fromGroupId: 'option-a', toGroupId: 'option-b' }] };
}

describe('bounded page content organization v1', () => {
  it('parses and deeply detaches an explicit business comparison from caller state', () => {
    const source = valid();
    const parsed = parsePresentationContentOrganization(source, { allowedContentRefs: [heading, first, second] });
    expect(parsed).toEqual(source);
    Object.assign(source.groups[1], { groupId: 'changed' });
    expect(parsed.groups[1].groupId).toBe('option-a');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.groups)).toBe(true);
    expect(parsed.groups.every(group => Object.isFrozen(group) && Object.isFrozen(group.contentRefs))).toBe(true);
    expect(Object.isFrozen(parsed.relationships[0])).toBe(true);
  });

  it.each([
    { content: 'Copied or invented fact' }, { x: 1 }, { script: 'execute code' }, { filePath: 'C:/outside' }, { runtimeId: 'execution-private' }
  ])('rejects copied facts, geometry, executable data and runtime metadata: %j', extra => {
    const source = valid();
    expect(() => parsePresentationContentOrganization({ ...source, groups: [{ ...source.groups[0], ...extra }, ...source.groups.slice(1)] }))
      .toThrow(PresentationContentOrganizationParseError);
  });

  it.each(['C:/folder', '../escape', 'execution-private', 'session-secret', 'a'.repeat(49), 'aabbccdd-1234-5678-90ab-aabbccddeeff'])('rejects nonsemantic group keys: %s', groupId => {
    const source = valid();
    expect(() => parsePresentationContentOrganization({ ...source, groups: [{ ...source.groups[0], groupId }, ...source.groups.slice(1)] })).toThrow();
  });

  it('rejects repeated group identity or exact content identity across business groups', () => {
    const source = valid();
    expect(() => parsePresentationContentOrganization({ ...source, groups: [...source.groups, source.groups[0]] })).toThrow();
    expect(() => parsePresentationContentOrganization({ ...source, groups: source.groups.map((group, index) => index === 2 ? { ...group, contentRefs: [first] } : group) }))
      .toThrow('invalid_content_reference');
  });

  it('allows a block parent or item aliases for Host leaf expansion without guessing coverage', () => {
    const source = valid();
    const aliases = { ...source, groups: source.groups.map((group, index) => index === 2 ? { ...group, contentRefs: [first + '.items[0]'] } : group) };
    expect(parsePresentationContentOrganization(aliases).groups[2].contentRefs).toEqual([first + '.items[0]']);
    expect(() => parsePresentationContentOrganization(aliases, { allowedContentRefs: [heading, first, second] })).toThrow('invalid_content_reference');
  });

  it('rejects out-of-page or nonexistent references against the actual Host inventory', () => {
    const source = valid();
    const wrong = { ...source, groups: source.groups.map((group, index) => index === 2 ? { ...group, contentRefs: ['outline.sections[8].blocks[1]'] } : group) };
    expect(() => parsePresentationContentOrganization(wrong, { allowedContentRefs: [heading, first, second] })).toThrow('invalid_content_reference');
  });

  it.each([
    { relationships: [{ kind: 'supports', fromGroupId: 'option-a', toGroupId: 'option-a' }] },
    { relationships: [{ kind: 'sequence', fromGroupId: 'missing', toGroupId: 'option-b' }] },
    { relationships: [{ kind: 'sequence', fromGroupId: 'option-a', toGroupId: 'option-b' }, { kind: 'sequence', fromGroupId: 'option-a', toGroupId: 'option-b' }] },
    { relationships: [{ kind: 'compare', fromGroupId: 'option-a', toGroupId: 'option-b' }, { kind: 'compare', fromGroupId: 'option-b', toGroupId: 'option-a' }] },
    { relationships: [{ kind: 'sequence', fromGroupId: 'option-a', toGroupId: 'option-b' }, { kind: 'supports', fromGroupId: 'option-b', toGroupId: 'option-a' }] }
  ])('rejects invalid, duplicate or cyclic relationships: %j', ({ relationships }) => {
    expect(() => parsePresentationContentOrganization({ ...valid(), relationships })).toThrow('invalid_relationship');
  });

  it('accepts directed evidence support and bounded step ordering as acyclic business relations', () => {
    const source = valid();
    expect(parsePresentationContentOrganization({ ...source, layout: 'sequence', relationships: [
      { kind: 'sequence', fromGroupId: 'headline', toGroupId: 'option-a' },
      { kind: 'supports', fromGroupId: 'option-a', toGroupId: 'option-b' }
    ] }).relationships).toHaveLength(2);
  });

  it('enforces the explicit version, group and relationship limits before attempting resolution', () => {
    const source = valid();
    expect(() => parsePresentationContentOrganization({ ...source, schemaVersion: 2 })).toThrow();
    expect(() => parsePresentationContentOrganization({ ...source, groups: [] })).toThrow();
    expect(() => parsePresentationContentOrganization({ ...source, groups: Array.from({ length: 17 }, (_, index) => ({
      groupId: `group-${index}`, role: 'content', contentRefs: [`outline.sections[0].blocks[${index}]`] })) })).toThrow();
    expect(() => parsePresentationContentOrganization({ ...source, relationships: Array.from({ length: 33 }, () => source.relationships[0]) })).toThrow();
    const schema = JSON.stringify(buildPresentationContentOrganizationJsonSchema());
    expect(schema).toContain('"maxItems":16');
    expect(schema).toContain('"maxItems":32');
    expect(schema).toContain('"additionalProperties":false');
    expect(schema).not.toContain('filePath');
  });
});
