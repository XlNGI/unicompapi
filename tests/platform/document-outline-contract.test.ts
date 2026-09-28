import { describe, expect, it } from 'vitest';
import {
  buildDocumentOutlineJsonSchema,
  buildDocumentOutlinePrompt,
  outlineAliasDefinitions,
  outlinePresentationPageKinds
} from '../../src/shared/document-outline-contract';

describe('document outline contract', () => {
  it('derives a closed PPT schema with the parser-facing enums', () => {
    const schema = buildDocumentOutlineJsonSchema('ppt') as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    const sections = properties.sections as Record<string, unknown>;
    const sectionItems = sections.items as Record<string, unknown>;
    const sectionProperties = sectionItems.properties as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['kind', 'title', 'sections']);
    expect((properties.kind as Record<string, unknown>).enum).toEqual(['ppt']);
    expect(sectionItems.additionalProperties).toBe(false);
    expect((sectionProperties.pageKind as Record<string, unknown>).enum).toEqual([...outlinePresentationPageKinds]);
    expect(((sectionProperties.blocks as Record<string, unknown>).items as Record<string, unknown>).oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ properties: { type: { const: 'paragraph' }, text: expect.anything() } }),
      expect.objectContaining({ properties: { type: { const: 'bullets' }, items: expect.anything() } })
    ]));
  });

  it('derives provider fallback instructions from the same machine-readable schema', () => {
    const prompt = buildDocumentOutlinePrompt('ppt');
    expect(prompt).toContain('"additionalProperties":false');
    expect(prompt).toContain('"pageKind"');
    expect(prompt).toContain('fillColor');
    expect(prompt).toContain('lineColor');
  });

  it('keeps legacy aliases declarative and separate from recovery execution', () => {
    expect(outlineAliasDefinitions.sceneElement.shapeType).toBe('type');
    expect(outlineAliasDefinitions.sceneStyle.bold).toBeUndefined();
  });
});
