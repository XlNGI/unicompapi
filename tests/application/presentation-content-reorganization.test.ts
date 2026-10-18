import { describe, expect, it } from 'vitest';
import { buildDocumentContentSnapshot, documentContentAliases } from '../../src/domain/entities/document-content-snapshot';
import { reorganizePresentationContent } from '../../src/application/presentation-content-reorganization';
import { autonomousOutline } from '../fixtures/presentation-autonomous-design';

const source = buildDocumentContentSnapshot({ outline: autonomousOutline });
const organization = { schemaVersion: 1, sections: [
  { headingRef: 'outline.sections[0].heading', blockRefs: ['outline.sections[0].blocks[1]'] },
  { headingRef: 'outline.sections[0].heading', blockRefs: ['outline.sections[0].blocks[0]', 'outline.sections[0].blocks[2]'] }
] };
describe('controlled presentation content reorganization', () => {
  it('moves only referenced content and retains canonical atom identities', () => {
    const next = reorganizePresentationContent(source, JSON.stringify(organization), { allowPaginationChange: true });
    expect(next.outline.sections).toHaveLength(2);
    expect(next.outline.sections[0].blocks[0]).toEqual(autonomousOutline.sections[0].blocks[1]);
    const oldIds = documentContentAliases(source), newIds = documentContentAliases(next.content);
    expect(newIds['outline.sections[0].blocks[0]']).toBe(oldIds['outline.sections[0].blocks[1]']);
    expect(newIds['outline.sections[1].blocks[0].text']).toBe(oldIds['outline.sections[0].blocks[0].text']);
    expect(next.content.revision).toBe(source.revision + 1);
  });
  it('keeps pagination fixed unless the Host authorizes a change', () => {
    expect(() => reorganizePresentationContent(source, organization, { allowPaginationChange: false })).toThrow('content_reorganization_invalid');
  });
  it.each([
    { ...organization, sections: [{ ...organization.sections[0], blockRefs: ['invented.fact'] }] },
    { ...organization, sections: [{ ...organization.sections[0], blockRefs: ['outline.sections[0].blocks[0]', 'outline.sections[0].blocks[0]'] }] },
    { ...organization, sections: [organization.sections[0]] },
    { ...organization, filePath: 'unsafe' },
    { ...organization, sections: [{ ...organization.sections[0], text: 'new invented facts' }, organization.sections[1]] }
  ])('rejects invented, duplicated, missing or executable fields', value => {
    expect(() => reorganizePresentationContent(source, value, { allowPaginationChange: true })).toThrow('content_reorganization_invalid');
  });
});
