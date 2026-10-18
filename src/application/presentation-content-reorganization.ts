import { buildDocumentContentSnapshot, documentContentAliases, documentContentSnapshotToOutline,
  parseDocumentContentSnapshot, type DocumentContentSnapshotV1 } from '../domain/entities/document-content-snapshot';
import { presentationDocumentPageLimits, type DocumentOutline } from '../domain/entities/document-generation';

interface ContentSection { readonly headingRef: string; readonly blockRefs: readonly string[]; readonly takeawayRef?: string; readonly actionRef?: string }
export interface PresentationContentOrganization { readonly schemaVersion: 1; readonly sections: readonly ContentSection[] }

/** A single bounded return to content planning. The model only moves existing source references. */
export function reorganizePresentationContent(sourceValue: DocumentContentSnapshotV1, value: string | unknown,
  options: { readonly allowPaginationChange: boolean }): { readonly outline: DocumentOutline; readonly content: DocumentContentSnapshotV1 } {
  const source = parseDocumentContentSnapshot(sourceValue), old = documentContentSnapshotToOutline(source);
  if (old.kind !== 'ppt' || old.coverScene || old.closingScene || old.sections.some(section => section.scene)) fail();
  let raw: unknown = value;
  if (typeof raw === 'string') { if (raw.length > 12_000) fail(); try { raw = JSON.parse(raw); } catch { fail(); } }
  const root = exact(raw, ['schemaVersion', 'sections']);
  if (root.schemaVersion !== 1 || !Array.isArray(root.sections) || !root.sections.length ||
    root.sections.length > presentationDocumentPageLimits.maximumPages - presentationDocumentPageLimits.systemGeneratedPages ||
    !options.allowPaginationChange && root.sections.length !== old.sections.length) fail();
  const headings = new Map(old.sections.map((section, index) => [`outline.sections[${index}].heading`, { section, index }]));
  const blocks = new Map<string, DocumentOutline['sections'][number]['blocks'][number]>(old.sections.flatMap((section, index) => section.blocks.map((block, blockIndex) =>
    [`outline.sections[${index}].blocks[${blockIndex}]`, block] as const)));
  const takeaways = new Map(old.sections.flatMap((section, index) => section.takeaway ? [[`outline.sections[${index}].takeaway`, section.takeaway] as const] : []));
  const actions = new Map(old.sections.flatMap((section, index) => section.action ? [[`outline.sections[${index}].action`, section.action] as const] : []));
  const aliases = documentContentAliases(source), identityMap: Record<string, string> = {};
  const usedBlocks = new Set<string>(), usedHeadings = new Set<string>(), usedTakeaways = new Set<string>(), usedActions = new Set<string>();
  const mapReference = (from: string, to: string) => {
    for (const [reference, id] of Object.entries(aliases)) if (reference === from || reference.startsWith(from + '.')) identityMap[to + reference.slice(from.length)] = id;
  };
  const sections = root.sections.map((entry, index) => {
    const item = exact(entry, ['headingRef', 'blockRefs'], ['takeawayRef', 'actionRef']);
    const heading = typeof item.headingRef === 'string' ? headings.get(item.headingRef) : undefined;
    if (!heading || !Array.isArray(item.blockRefs) || !item.blockRefs.length || item.blockRefs.length > 100) fail();
    const headingRef = item.headingRef as string, target = `outline.sections[${index}]`;
    if (!usedHeadings.has(headingRef)) {
      identityMap[target] = source.sections[heading.index].sectionId;
      mapReference(headingRef, `${target}.heading`);
    }
    usedHeadings.add(headingRef);
    const payloads = item.blockRefs.map((ref, blockIndex) => {
      if (typeof ref !== 'string' || !blocks.has(ref) || usedBlocks.has(ref)) fail();
      usedBlocks.add(ref); mapReference(ref, `${target}.blocks[${blockIndex}]`);
      return blocks.get(ref)!;
    });
    const optional = (key: 'takeawayRef' | 'actionRef', values: ReadonlyMap<string, string>, used: Set<string>) => {
      const ref = item[key];
      if (ref === undefined) return undefined;
      if (typeof ref !== 'string' || !values.has(ref) || used.has(ref)) fail();
      used.add(ref); mapReference(ref, `${target}.${key === 'takeawayRef' ? 'takeaway' : 'action'}`);
      return values.get(ref)!;
    };
    const takeaway = optional('takeawayRef', takeaways, usedTakeaways), action = optional('actionRef', actions, usedActions);
    return { heading: heading.section.heading, level: heading.section.level, blocks: payloads,
      ...(heading.section.pageKind ? { pageKind: heading.section.pageKind } : {}), ...(takeaway ? { takeaway } : {}), ...(action ? { action } : {}) };
  });
  if (usedBlocks.size !== blocks.size || usedHeadings.size !== headings.size || usedTakeaways.size !== takeaways.size || usedActions.size !== actions.size) fail();
  const outline: DocumentOutline = { kind: 'ppt', title: old.title, sections };
  const rebuilt = buildDocumentContentSnapshot({ outline, previousSnapshot: source, identityMap,
    pageCount: sections.length + presentationDocumentPageLimits.systemGeneratedPages });
  // Moving a block never discards its citations or preservation constraints.
  const oldBlocks = new Map(source.sections.flatMap(section => section.blocks.map(block => [block.blockId, block] as const)));
  const content = parseDocumentContentSnapshot({ ...rebuilt, sections: rebuilt.sections.map(section => ({ ...section,
    blocks: section.blocks.map(block => { const original = oldBlocks.get(block.blockId); return original ? { ...block, sourceRefs: original.sourceRefs, preserve: original.preserve } : block; }) })) });
  return { outline, content };
}

export function presentationContentInventory(value: DocumentContentSnapshotV1) {
  const source = parseDocumentContentSnapshot(value);
  return source.sections.map((section, index) => ({ headingRef: `outline.sections[${index}].heading`, heading: section.heading,
    blocks: section.blocks.map((block, blockIndex) => ({ ref: `outline.sections[${index}].blocks[${blockIndex}]`, content: block.payload })),
    ...(section.takeaway ? { takeawayRef: `outline.sections[${index}].takeaway`, takeaway: section.takeaway } : {}),
    ...(section.action ? { actionRef: `outline.sections[${index}].action`, action: section.action } : {}) }));
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => ![...required, ...optional].includes(key)) || required.some(key => !(key in record))) fail();
  return record;
}
function fail(): never { throw new TypeError('content_reorganization_invalid'); }
