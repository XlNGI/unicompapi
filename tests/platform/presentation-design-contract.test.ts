import { describe, expect, it } from 'vitest';
import {
  buildFallbackPresentationDesignIR,
  buildPresentationArtDirectionInput,
  buildPresentationArtDirectionPrompt,
  buildPresentationDesignIRJsonSchema,
  parsePresentationArtDirectionInput,
  buildDocumentIRFromOutline,
  parseArtDirection,
  parsePresentationDesignIR,
  PresentationDesignIRParseError,
  validatePresentationDesignIR,
  type PresentationDesignIRV2
} from '../../src/domain';
import { parseDocumentOutline } from '../../src/platform/documents';

function validIR(): PresentationDesignIRV2 {
  return {
    schemaVersion: 2,
    globalDesign: {
      visualTone: 'editorial',
      visualRhythm: 'varied',
      density: 'balanced',
      whitespace: 'generous',
      typographyDirection: 'display-led',
      colorDirection: 'restrained'
    },
    pages: [{
      pageNumber: 1,
      pageRole: 'hero',
      pageIntent: 'Make the central statement immediately clear',
      hierarchy: {
        primary: ['outline.title'],
        secondary: [],
        supporting: []
      },
      composition: {
        principle: 'single-focus',
        focalArea: 'center',
        balance: 'centered',
        flow: 'top-to-bottom'
      },
      density: 'sparse',
      whitespace: 'generous',
      emphasis: { target: 'outline.title', strength: 'dominant' },
      contentRoles: { title: ['outline.title'], body: [], metric: [], evidence: [], image: [], chart: [] },
      visualStrategy: 'A single statement surrounded by generous whitespace'
    }]
  };
}

describe('production Presentation Design IR v2 contract', () => {
  it('keeps legacy v2 plans readable and accepts explicit nested v1 semantic groups on the same page', () => {
    const outline = metricOutline();
    const baseline = buildFallbackPresentationDesignIR(outline);
    expect(parsePresentationDesignIR(baseline, { outline }).pages.every(page => page.organization === undefined)).toBe(true);
    const organization = { schemaVersion: 1 as const, layout: 'metrics' as const, groups: [
      { groupId: 'headline', role: 'header' as const, contentRefs: ['outline.sections[0].heading'] },
      { groupId: 'adoption', role: 'metric' as const, contentRefs: ['outline.sections[0].blocks[0].items[0]'] },
      { groupId: 'retention', role: 'metric' as const, contentRefs: ['outline.sections[0].blocks[0].items[1]'] }
    ], relationships: [{ kind: 'compare' as const, fromGroupId: 'adoption', toGroupId: 'retention' }] };
    const value = { ...baseline, pages: baseline.pages.map(page => page.pageNumber === 2 ? { ...page, organization } : page) };
    expect(parsePresentationDesignIR(value, { outline }).pages[1].organization).toEqual(organization);
    const wrong = { ...value, pages: value.pages.map(page => page.pageNumber === 1 ? { ...page, organization } : { ...page, organization: undefined }) };
    expect(validatePresentationDesignIR(wrong, { outline }).map(issue => issue.code)).toContain('invalid_content_reference');
    const injected = { ...organization, groups: [{ ...organization.groups[0], copiedFact: 'PRIVATE-FACT' }, ...organization.groups.slice(1)] };
    expect(() => parsePresentationDesignIR({ ...value, pages: value.pages.map(page => page.pageNumber === 2 ? { ...page, organization: injected } : page) }, { outline }))
      .toThrow(PresentationDesignIRParseError);
  });

  it('exposes exact closing action, nearest takeaway and title inventory without allowing other prior sections', () => {
    const outline = parseDocumentOutline(JSON.stringify({ kind: 'ppt', title: 'Closing deck', sections: [
      { heading: 'Old', level: 1, takeaway: 'Old takeaway', blocks: [{ type: 'paragraph', text: 'Old fact' }] },
      { heading: 'Recent', level: 1, takeaway: 'Recent takeaway', blocks: [{ type: 'paragraph', text: 'Recent fact' }] },
      { heading: 'Last', level: 1, action: 'Start now', blocks: [{ type: 'paragraph', text: 'Last fact' }] }
    ] }));
    const input = buildPresentationArtDirectionInput({ userRequirement: 'Explain the results', outline });
    expect(input.outline.pages.at(-1)?.contentRefs).toEqual(['outline.sections[2].action', 'outline.sections[1].takeaway', 'outline.title']);
    expect(parsePresentationArtDirectionInput(input)).toEqual(input);
    const closing = input.outline.pages.at(-1)!;
    const forged = { ...closing, contentRefs: ['outline.sections[0].takeaway', ...closing.contentRefs.slice(1)],
      content: [{ ref: 'outline.sections[0].takeaway', kind: 'takeaway', text: 'Old takeaway' }, ...closing.content.slice(1)] };
    expect(() => parsePresentationArtDirectionInput({ ...input, outline: { ...input.outline, pages: [...input.outline.pages.slice(0, -1), forged] } })).toThrow();
    const changed = { ...closing, content: closing.content.map(item => item.kind === 'takeaway' ? { ...item, text: 'Invented closing fact' } : item) };
    expect(() => parsePresentationArtDirectionInput({ ...input, outline: { ...input.outline, pages: [...input.outline.pages.slice(0, -1), changed] } })).toThrow();
  });

  it('parses a valid contract and accepts fenced provider JSON', () => {
    const value = validIR();
    expect(parsePresentationDesignIR(JSON.stringify(value))).toEqual(value);
    expect(parseArtDirection('```json\n' + JSON.stringify(value) + '\n```')).toEqual(value);
  });

  it('rejects invalid enum values and unknown fields', () => {
    const invalid = { ...validIR(), globalDesign: { ...validIR().globalDesign, density: 'roomy' }, extra: true };
    const diagnostics = validatePresentationDesignIR(invalid);
    expect(diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['invalid_enum', 'unknown_field']));
    expect(() => parsePresentationDesignIR(invalid)).toThrow(PresentationDesignIRParseError);
  });

  it('rejects duplicate or missing page numbers when an expected count is supplied', () => {
    const value = validIR();
    const duplicate = { ...value, pages: [value.pages[0], { ...value.pages[0] }] };
    expect(validatePresentationDesignIR(duplicate, { expectedPageCount: 2 }).map(item => item.code))
      .toEqual(expect.arrayContaining(['duplicate_page', 'missing_page']));
  });

  it('rejects content references that do not exist in the outline', () => {
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt', title: '内容', sections: [{ heading: '章节', level: 1, blocks: [{ type: 'paragraph', text: '正文' }] }]
    }));
    const value = { ...validIR(), pages: [{ ...validIR().pages[0], hierarchy: { ...validIR().pages[0].hierarchy, primary: ['outline.sections[8].blocks[2]'] } }] };
    expect(validatePresentationDesignIR(value, { outline }).map(item => item.code)).toContain('invalid_content_reference');
  });

  it('rejects malformed, truncated, and overlong provider responses', () => {
    expect(() => parseArtDirection('{"schemaVersion":2')).toThrow(PresentationDesignIRParseError);
    const value = validIR();
    const overlong = { ...value, pages: [{ ...value.pages[0], pageIntent: 'x'.repeat(601) }] };
    expect(validatePresentationDesignIR(overlong).map(item => item.code)).toContain('text_too_long');
  });

  it('builds a valid deterministic fallback from a PPT outline', () => {
    const outline = parseDocumentOutline(JSON.stringify({
      kind: 'ppt', title: '回退', sections: [
        { heading: '章节一', level: 1, blocks: [{ type: 'paragraph', text: '正文' }] },
        { heading: '章节二', level: 1, blocks: [{ type: 'chart', chartKind: 'bar', data: [{ label: 'A', value: 1 }] }] }
      ]
    }));
    const fallback = buildFallbackPresentationDesignIR(outline);
    expect(validatePresentationDesignIR(fallback, { outline, expectedPageCount: 4 })).toEqual([]);
    expect(fallback.pages.map(page => page.pageRole)).toEqual(['hero', 'content', 'content', 'closing']);
  });

  it('checks consecutive page identity without caller-supplied counts', () => {
    expect(validatePresentationDesignIR({ ...validIR(), pages: [{ ...validIR().pages[0], pageNumber: 2 }] }).map(item => item.code))
      .toEqual(expect.arrayContaining(['invalid_page_number', 'missing_page']));
  });

  it('requires actual content references for emphasis and disjoint nonempty hierarchy', () => {
    const value = validIR();
    const page = value.pages[0];
    expect(validatePresentationDesignIR({ ...value, pages: [{ ...page, emphasis: { ...page.emphasis, target: 'invented metric' } }] }).map(item => item.code))
      .toContain('invalid_content_reference');
    expect(validatePresentationDesignIR({ ...value, pages: [{ ...page, hierarchy: { primary: [], secondary: [], supporting: [] } }] }).map(item => item.code))
      .toContain('invalid_shape');
    expect(validatePresentationDesignIR({ ...value, pages: [{ ...page, hierarchy: { ...page.hierarchy, supporting: ['outline.title'] } }] }).map(item => item.code))
      .toContain('invalid_content_reference');
  });

  it('rejects incomplete fences, prose wrappers, and excessively large responses', () => {
    const json = JSON.stringify(validIR());
    expect(() => parseArtDirection('```json\n' + json)).toThrow(PresentationDesignIRParseError);
    expect(() => parseArtDirection('Here is the design: ' + json)).toThrow(PresentationDesignIRParseError);
    expect(() => parseArtDirection(' '.repeat(120_001))).toThrow(PresentationDesignIRParseError);
  });

  it('binds page references to their source section including exact metric items', () => {
    const outline = metricOutline();
    const input = buildPresentationArtDirectionInput({ userRequirement: 'Focus on the second metric', outline });
    const baseline = buildFallbackPresentationDesignIR(outline);
    const pages = baseline.pages.map(page => page.pageNumber === 2 ? {
      ...page, emphasis: { target: 'outline.sections[0].blocks[0].items[1]', strength: 'dominant' as const }
    } : page);
    expect(validatePresentationDesignIR({ ...baseline, pages }, { outline })).toEqual([]);
    expect(validatePresentationDesignIR({ ...baseline, pages }, { contentPages: input.outline.pages })).toEqual([]);
    const wrongPage = pages.map(page => page.pageNumber === 1 ? {
      ...page, emphasis: { target: 'outline.sections[0].blocks[0].items[1]', strength: 'strong' as const }
    } : page);
    expect(validatePresentationDesignIR({ ...baseline, pages: wrongPage }, { outline }).map(item => item.code)).toContain('invalid_content_reference');
    const missingItem = pages.map(page => page.pageNumber === 2 ? {
      ...page, emphasis: { target: 'outline.sections[0].blocks[0].items[8]', strength: 'strong' as const }
    } : page);
    expect(validatePresentationDesignIR({ ...baseline, pages: missingItem }, { outline }).map(item => item.code)).toContain('invalid_content_reference');
  });

  it('projects content while excluding scene assets, runtime IDs and raw DocumentIR references', () => {
    const base = metricOutline();
    const outline = { ...base, coverScene: { schemaVersion: 1 as const, elements: [{
      elementId: 'PRIVATE-ELEMENT-ID', type: 'image' as const, assetRef: 'C:\private\image.png',
      geometry: { x: 0, y: 0, width: 1, height: 1 }, zIndex: 1
    }] } };
    const source = buildDocumentIRFromOutline({ outline: base, operation: 'create' });
    const documentIR = { ...source, attachmentRefs: ['PRIVATE-FILE-ID'], workRef: 'PRIVATE-WORK-ID',
      content: { ...source.content!, sourceRefs: ['PRIVATE-CHECKSUM'], sections: source.content!.sections.map(section => ({
        ...section, sectionId: 'PRIVATE-SECTION-ID', blocks: section.blocks.map(block => ({
          ...block, blockId: 'PRIVATE-BLOCK-ID', sourceRefs: ['PRIVATE-SOURCE-REF'], content: 'PRIVATE-IR-BODY'
        }))
      })) } };
    const input = buildPresentationArtDirectionInput({ userRequirement: 'Use the second metric as focus', outline, documentIR,
      visualRequirements: ['Keep generous whitespace'], brandingConstraints: ['Use the approved accent'] });
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain('private');
    expect(input.documentIRSummary?.contentMapping).toEqual([{ contentRef: 'outline.sections[0].blocks[0]', kind: 'bullets' }]);
    expect(input.outline.pages[1].content.find(item => item.ref.endsWith('.items[1]'))?.text).toBe('Retention 92%');
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.outline.pages[1].content[0])).toBe(true);
  });

  it('rejects unknown runtime properties even when a caller bypasses TypeScript types', () => {
    const input = buildPresentationArtDirectionInput({ userRequirement: 'Product introduction', outline: metricOutline() });
    expect(() => parsePresentationArtDirectionInput({ ...input, providerSecret: 'secret' })).toThrow(TypeError);
    const pages = input.outline.pages.map(page => ({ ...page, filePath: 'C:/private.pptx' }));
    expect(() => parsePresentationArtDirectionInput({ ...input, outline: { ...input.outline, pages } })).toThrow(TypeError);
    expect(() => buildPresentationArtDirectionPrompt({ ...input, authorizationClaim: 'secret' } as typeof input)).toThrow(TypeError);
  });

  it('preserves bounded source content without silently truncating facts', () => {
    const outline = metricOutline();
    const text = 'a'.repeat(2_001);
    const input = buildPresentationArtDirectionInput({ userRequirement: 'r'.repeat(8_000), outline: { ...outline, sections: [{
      heading: 'Evidence', level: 1, blocks: [{ type: 'paragraph', text }]
    }] } });
    expect(input.outline.pages[1].content.find(item => item.kind === 'paragraph')?.text).toBe(text);
    expect(() => buildPresentationArtDirectionInput({ userRequirement: 'r'.repeat(16_001), outline })).toThrow(TypeError);
    expect(() => buildPresentationArtDirectionInput({ userRequirement: 'Use all content', outline: { ...outline, sections: [{
      heading: 'Evidence', level: 1, blocks: Array.from({ length: 10 }, () => ({ type: 'paragraph' as const, text: 'x'.repeat(10_000) }))
    }] } })).toThrow(/budget/);
  });

  it('provides a faithful model-visible schema with every required nested field', () => {
    const schema = buildPresentationDesignIRJsonSchema();
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const pageSchema = properties.pages.items as { properties: Record<string, { properties: Record<string, { pattern?: string }> }> };
    const referencePattern = pageSchema.properties.emphasis.properties.target.pattern!;
    expect(new RegExp(referencePattern, 'u').test('outline.sections[0].blocks[0].items[1]')).toBe(true);
    expect(new RegExp(referencePattern, 'u').test('outline/title')).toBe(false);
    const encoded = JSON.stringify(schema);
    for (const field of ['visualTone', 'typographyDirection', 'pageIntent', 'hierarchy', 'supporting', 'composition', 'focalArea', 'contentRoles', 'image', 'chart', 'visualStrategy']) expect(encoded).toContain(`"${field}"`);
    expect(encoded).toContain('"additionalProperties":false');
    expect(encoded).toContain('"maxLength":600');
    const pageContract = properties.pages.items as { required: readonly string[]; properties: Record<string, unknown> };
    expect(pageContract.required).not.toContain('organization');
    expect(pageContract.properties.organization).toBeDefined();
    expect(JSON.stringify(pageContract.properties.organization)).toContain('"const":1');
    expect(encoded).toContain('"maxItems":16');
    expect(encoded).toContain('"maxItems":32');
    const input = buildPresentationArtDirectionInput({ userRequirement: 'Design this content', outline: metricOutline() });
    const prompt = buildPresentationArtDirectionPrompt(input);
    expect(prompt).toContain(encoded);
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('outline.sections[0].blocks[0].items[1]');
    expect(prompt).toContain('Include organization schemaVersion 1');
    expect(prompt).toContain('standalone header group');
  });

  it('rejects missing pages and nested geometry fields without partial acceptance', () => {
    const outline = metricOutline();
    const value = buildFallbackPresentationDesignIR(outline);
    expect(validatePresentationDesignIR({ ...value, pages: value.pages.slice(1) }, { outline }).map(item => item.code))
      .toEqual(expect.arrayContaining(['missing_page', 'page_count_mismatch', 'invalid_page_number']));
    const pages = value.pages.map(page => ({ ...page, composition: { ...page.composition, x: 0.3 } }));
    expect(validatePresentationDesignIR({ ...value, pages }, { outline }).map(item => item.code)).toContain('unknown_field');
  });
});

function metricOutline() {
  return parseDocumentOutline(JSON.stringify({
    kind: 'ppt', title: 'Product impact', sections: [{
      heading: 'Clear improvement', level: 1, takeaway: 'Retention is the focus', action: 'Expand the rollout',
      blocks: [{ type: 'bullets', items: ['Adoption 68%', 'Retention 92%'] }]
    }]
  }));
}
