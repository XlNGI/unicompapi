import { describe, expect, it } from 'vitest';
import {
  buildDocumentContentSnapshot, buildDocumentIRFromOutline, documentContentAliases,
  documentContentReferenceIndex, documentContentSnapshotToLegacyContent, documentContentSnapshotToOutline,
  parseDocumentContentSnapshot, parseDocumentIR, resolveDocumentContentRef,
  type DocumentOutline, type DocumentOutlineSection, type PresentationPageScene
} from '../../src/domain';

const scene: PresentationPageScene = { schemaVersion: 1, elements: [{ elementId: 'caption', type: 'text',
  geometry: { x: 0.2, y: 0.3, width: 0.6, height: 0.4 }, zIndex: 1, content: '图景说明', style: { fill: 'AABBCC' } }] };
const section = (heading: string, text: string): DocumentOutlineSection => ({ heading, level: 1,
  blocks: [{ type: 'paragraph', text }] });
const outline = (sections: readonly DocumentOutlineSection[]): DocumentOutline => ({ kind: 'ppt', title: '经营计划', sections });

describe('canonical document content snapshot', () => {
  it('keeps an existing title-only presentation or cover scene without inventing a content section', () => {
    const single: DocumentOutline = { kind: 'ppt', title: '封面', sections: [], coverScene: scene };
    const ir = buildDocumentIRFromOutline({ outline: single, operation: 'create', identityScope: 'single-page' });
    expect(documentContentSnapshotToOutline(ir.canonicalContent!)).toEqual(single);
    expect(parseDocumentIR(ir)).toEqual(ir);
    expect(resolveDocumentContentRef(ir.canonicalContent!, 'outline.coverScene.elements[0].content')?.text).toBe('图景说明');
    expect(() => buildDocumentContentSnapshot({ outline: { kind: 'word', title: '空文档', sections: [] } })).toThrow(/array length/);
    expect(() => buildDocumentContentSnapshot({ outline: { kind: 'excel', title: '空表格', sections: [] } })).toThrow(/array length/);
  });

  it('round-trips all typed content and outline metadata without flattening distinctions', () => {
    const rich: DocumentOutline = { kind: 'ppt', title: '经营计划', coverScene: scene, closingScene: scene,
      sections: [{ heading: '发展方向', level: 2, pageKind: 'data', takeaway: '核心结论', action: '下一步行动', scene,
        blocks: [{ type: 'paragraph', text: '段落' }, { type: 'quote', text: '引述' },
          { type: 'bullets', items: ['一', '二'] }, { type: 'numbered', items: ['一', '二'] },
          { type: 'table', header: ['指标', '变化'], rows: [['收入', '12'], ['备注', '']] },
          { type: 'chart', chartKind: 'bar', title: '增幅', data: [{ label: '今年', value: 12 }, { label: '去年', value: -2 }] }] }] };
    const snapshot = buildDocumentContentSnapshot({ outline: rich, identityScope: 'work-1', sourceRefs: ['evidence-1'],
      preserve: ['保留含义'], styleConstraints: ['文字清晰'], pageCount: 5 });
    expect(documentContentSnapshotToOutline(snapshot)).toEqual(rich);
    expect(snapshot.sections[0]?.blocks[3]?.payload.type).toBe('numbered');
    expect(snapshot.sections[0]?.blocks[1]?.payload.type).toBe('quote');
    expect(snapshot.sections[0]?.blocks[4]?.sourceRefs).toEqual(['evidence-1']);
    expect(parseDocumentContentSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(resolveDocumentContentRef(snapshot, 'outline.sections[0].blocks[5].data[0].value')).toMatchObject({ value: 12, text: '12' });
    expect(resolveDocumentContentRef(snapshot, 'outline.sections[0].blocks[4]')?.payload).toEqual(rich.sections[0]?.blocks[4]);
    expect(resolveDocumentContentRef(snapshot, 'outline.coverScene.elements[0].content')?.text).toBe('图景说明');
  });

  it('makes the legacy IR view derived and rejects even one conflicting word', () => {
    const ir = buildDocumentIRFromOutline({ outline: outline([section('结论', '正文')]), operation: 'create', identityScope: 'run-1' });
    expect(ir.canonicalContent).toBeDefined();
    expect(ir.content).toEqual(documentContentSnapshotToLegacyContent(ir.canonicalContent!));
    expect(parseDocumentIR(ir)).toEqual(ir);
    expect(() => parseDocumentIR({ ...ir, content: { ...ir.content, title: '错误标题' } })).toThrow(/conflicts/);
    expect(parseDocumentIR({ operation: 'create', attachmentRefs: [], canonicalContent: ir.canonicalContent }).content).toEqual(ir.content);
  });

  it('retains section and block identities through reordering and insertion', () => {
    const first = buildDocumentContentSnapshot({ outline: outline([section('甲', '甲正文'), section('乙', '乙正文')]), identityScope: 'work-2' });
    const second = buildDocumentContentSnapshot({ outline: outline([section('乙', '乙正文'), section('新', '新正文'), section('甲', '甲正文')]), previousSnapshot: first });
    expect(second.sections[0]?.sectionId).toBe(first.sections[1]?.sectionId);
    expect(second.sections[2]?.blocks[0]?.blockId).toBe(first.sections[0]?.blocks[0]?.blockId);
    expect(second.sections[1]?.sectionId).not.toBe(first.sections[0]?.sectionId);
    expect(documentContentAliases(second)['outline.sections[0].heading']).toBe(first.sections[1]?.headingId);
  });

  it('keeps every repeated first-version atom distinct and retains unchanged duplicates', () => {
    const duplicated = outline([{ heading: '列表', level: 1, blocks: [{ type: 'bullets', items: ['相同', '相同'] }] }]);
    const first = buildDocumentContentSnapshot({ outline: duplicated, identityScope: 'duplicates' });
    const ids = first.sections[0]!.blocks[0]!.atomIds;
    expect(ids['items[0]']).not.toBe(ids['items[1]']);
    const second = buildDocumentContentSnapshot({ outline: duplicated, previousSnapshot: first });
    expect(second.sections[0]!.blocks[0]!.atomIds).toEqual(ids);
  });

  it('does not guess which repeated block survived an edit or deletion', () => {
    const first = buildDocumentContentSnapshot({ outline: outline([{ heading: '重复', level: 1,
      blocks: [{ type: 'paragraph', text: '相同' }, { type: 'paragraph', text: '相同' }] }]), identityScope: 'ambiguous' });
    const second = buildDocumentContentSnapshot({ outline: outline([section('重复', '相同')]), previousSnapshot: first });
    expect(first.sections[0]?.blocks.map(block => block.blockId)).not.toContain(second.sections[0]?.blocks[0]?.blockId);
  });

  it('uses explicit Host identity mapping for a precise edit and preserves associated sources', () => {
    const first = buildDocumentContentSnapshot({ outline: outline([section('结论', '旧文字')]), identityScope: 'patch', sourceRefs: ['evidence'] });
    const oldBlock = first.sections[0]!.blocks[0]!;
    const second = buildDocumentContentSnapshot({ outline: outline([section('结论', '新文字')]), previousSnapshot: first,
      identityMap: { 'outline.sections[0].blocks[0]': oldBlock.blockId,
        'outline.sections[0].blocks[0].text': oldBlock.atomIds.text! } });
    expect(second.sections[0]?.blocks[0]?.blockId).toBe(oldBlock.blockId);
    expect(second.sections[0]?.blocks[0]?.atomIds.text).toBe(oldBlock.atomIds.text);
    expect(second.sections[0]?.blocks[0]?.sourceRefs).toEqual(['evidence']);
    expect(resolveDocumentContentRef(second, oldBlock.atomIds.text!)?.text).toBe('新文字');
  });

  it('retains tombstones and never revives an old deleted identity', () => {
    const first = buildDocumentContentSnapshot({ outline: outline([section('甲', '正文甲'), section('乙', '正文乙')]), identityScope: 'history' });
    const deleted = first.sections[1]!.sectionId;
    const second = buildDocumentContentSnapshot({ outline: outline([section('甲', '正文甲')]), previousSnapshot: first });
    const third = buildDocumentContentSnapshot({ outline: outline([section('甲', '正文甲'), section('乙', '正文乙')]), previousSnapshot: second });
    expect(second.issuedIds).toContain(deleted);
    expect(resolveDocumentContentRef(second, deleted)).toBeUndefined();
    expect(third.sections[1]?.sectionId).not.toBe(deleted);
    expect(() => buildDocumentContentSnapshot({ outline: outline([section('甲', '正文甲'), section('乙', '正文乙')]), previousSnapshot: second,
      identityMap: { 'outline.sections[1]': deleted } })).toThrow(/absent/);
  });

  it('rejects identity cross-scope, duplicate claims and unsupported mappings', () => {
    const first = buildDocumentContentSnapshot({ outline: outline([section('甲', '正文')]), identityScope: 'scope-a' });
    expect(() => buildDocumentContentSnapshot({ outline: outline([section('甲', '正文')]), previousSnapshot: first, identityScope: 'scope-b' })).toThrow(/scope/);
    expect(() => buildDocumentContentSnapshot({ outline: outline([section('甲', '正文')]), previousSnapshot: first,
      identityMap: { 'unsupported.path': first.titleId } })).toThrow(/unsupported/);
    expect(() => parseDocumentContentSnapshot({ ...first, titleId: first.sections[0]?.headingId })).toThrow(/duplicated/);
    expect(() => parseDocumentContentSnapshot({ ...first, nextIdentity: first.nextIdentity + 1 })).toThrow(/history/);
  });

  it('resolves dot aliases, colon aliases and stable IDs through one reusable index', () => {
    const snapshot = buildDocumentContentSnapshot({ outline: outline([section('结论', '文字')]), identityScope: 'refs' });
    const index = documentContentReferenceIndex(snapshot);
    const reference = index['outline.sections[0].blocks[0].text']!;
    expect(index[reference.id]).toEqual(reference);
    expect(index['outline:section:1:block:1:text']).toEqual(reference);
    expect(resolveDocumentContentRef(snapshot, 'outline.sections[99].heading')).toBeUndefined();
    expect(resolveDocumentContentRef(snapshot, '__proto__')).toBeUndefined();
    expect(resolveDocumentContentRef(snapshot, 'constructor')).toBeUndefined();
  });

  it('does not truncate structured tables or confuse list newlines with item boundaries', () => {
    const rich = outline([{ heading: '业务结构', level: 3, blocks: [
      { type: 'numbered', items: ['第一项\n仍属于第一项', '第二项'] },
      { type: 'table', header: ['名称', '说明'], rows: Array.from({ length: 40 }, (_, row) => [`指标${row}`, '完整文本'.repeat(40)]) }
    ] }]);
    const ir = buildDocumentIRFromOutline({ outline: rich, operation: 'create', identityScope: 'large-table' });
    expect(ir.content!.sections[0]!.blocks[1]!.content!.length).toBeGreaterThan(4_000);
    expect(parseDocumentIR(ir)).toEqual(ir);
    expect(documentContentSnapshotToOutline(ir.canonicalContent!)).toEqual(rich);
  });

  it('keeps preservation notes and evidence during a later IR rebuild', () => {
    const first = buildDocumentContentSnapshot({ outline: outline([section('甲', '正文')]), identityScope: 'evidence-history',
      sourceRefs: ['local-evidence'], preserve: ['保护定义'], styleConstraints: ['字体清晰'], pageCount: 6 });
    const ir = buildDocumentIRFromOutline({ outline: outline([section('甲', '正文')]), operation: 'edit', previousSnapshot: first });
    expect(ir.attachmentRefs).toEqual([]);
    expect(ir.canonicalContent?.sourceRefs).toEqual(['local-evidence']);
    expect(ir.canonicalContent?.preserve).toEqual(['保护定义']);
    expect(ir.content?.styleConstraints).toEqual(['字体清晰']);
    expect(ir.content?.pageCount).toBe(6);
  });

  it('fails closed for malformed rich payloads, external paths and unbounded arrays', () => {
    const first = buildDocumentContentSnapshot({ outline: outline([section('甲', '正文')]), identityScope: 'schema' });
    const block = first.sections[0]!.blocks[0]!;
    const replacePayload = (payload: unknown) => ({ ...first, sections: [{ ...first.sections[0], blocks: [{ ...block, payload }] }] });
    expect(() => parseDocumentContentSnapshot(replacePayload({ type: 'paragraph', text: '正文', execute: 'unsafe' }))).toThrow(/unsupported/);
    expect(() => buildDocumentContentSnapshot({ outline: outline([section('甲', 'C:\\private\\file.txt')]) })).toThrow(/protected/);
    expect(() => buildDocumentContentSnapshot({ outline: outline([{ heading: '图表', level: 1,
      blocks: [{ type: 'chart', chartKind: 'bar', data: [{ label: '坏数', value: Infinity }] }] }]) })).toThrow(/finite/);
    expect(() => buildDocumentContentSnapshot({ outline: outline(Array.from({ length: 81 }, () => section('甲', '正文'))) })).toThrow(/array length/);
    expect(() => parseDocumentContentSnapshot({ ...first, schemaVersion: 2 })).toThrow(/version/);
  });
});
