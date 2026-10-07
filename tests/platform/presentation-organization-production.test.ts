import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toProjectId } from '../../src/domain';
import { buildDocumentContentSnapshot, documentContentReferenceIndex } from '../../src/domain/entities/document-content-snapshot';
import { parsePresentationDesignIR, type ProductionPresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import type { PresentationRenderPlanElement } from '../../src/domain/entities/presentation-render-plan';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import { computeDocumentContentDigest } from '../../src/platform/documents/presentation-layout-ir-adapter';
import type { PresentationProductionPlan } from '../../src/platform/documents/presentation-production-plan';
import { createConfiguredOfficeRenderAdapter, inspectPptxGeometry } from '../../src/platform/documents/office-render-adapter';
import { JsonWorkRepository } from '../../src/platform/repositories/json-repositories';
import { NodeProjectStorage } from '../../src/platform/storage';
import { organizationPagesDesign, organizationPagesFacts, organizationPagesOutline } from '../fixtures/presentation-organization-pages';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const epsilon = 3 / 914_400;
type Box = { x: number; y: number; width: number; height: number };
async function root() { const value = await mkdtemp(path.join(os.tmpdir(), 'unicomp-organization-production-')); roots.push(value); return value; }

function savedElement(xml: string, element: PresentationRenderPlanElement): { box: Box; xml: string } {
  const name = `name="UniComp Render ${element.renderId}"`;
  const matches = [...xml.matchAll(/<p:(?:sp|graphicFrame)\b[^>]*>[\s\S]*?<\/p:(?:sp|graphicFrame)>/gu)]
    .filter(match => match[0].includes(name));
  expect(matches, name).toHaveLength(1);
  const actual = matches[0][0];
  const offset = /<a:off x="(-?\d+)" y="(-?\d+)"/u.exec(actual);
  const extent = /<a:ext cx="(\d+)" cy="(\d+)"/u.exec(actual);
  expect(offset).not.toBeNull(); expect(extent).not.toBeNull();
  const box = { x: Number(offset![1]) / 914_400, y: Number(offset![2]) / 914_400,
    width: Number(extent![1]) / 914_400, height: Number(extent![2]) / 914_400 };
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(box[key] - element.geometry[key])).toBeLessThanOrEqual(epsilon);
  return { box, xml: actual };
}
function union(boxes: readonly Box[]): Box {
  expect(boxes.length).toBeGreaterThan(0);
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x,
    height: Math.max(...boxes.map(box => box.y + box.height)) - y };
}
function sourceBoxes(data: Awaited<ReturnType<typeof deck>>, pageNumber: number, aliases: readonly string[]): Box[] {
  const index = documentContentReferenceIndex(data.prepared.contentSnapshot);
  const ids = aliases.map(alias => index[alias].id);
  return ids.map(id => {
    const matches = data.prepared.renderPlan!.pages[pageNumber - 1].elements.filter(element => element.source.kind === 'content' && element.source.ref === id);
    expect(matches, id).toHaveLength(1);
    return savedElement(data.xml[pageNumber - 1], matches[0]).box;
  });
}
function blocks(section: number, indexes: readonly number[]) { return indexes.map(index => `outline.sections[${section}].blocks[${index}]`); }
function heading(section: number) { return [`outline.sections[${section}].heading`]; }
function below(header: Box, body: Box) { expect(header.y + header.height).toBeLessThanOrEqual(body.y + epsilon); }
function fullWidth(note: Box, body: Box) {
  expect(note.width).toBeGreaterThanOrEqual(body.width * 0.9);
  expect(note.x).toBeLessThanOrEqual(body.x + epsilon);
  expect(note.x + note.width).toBeGreaterThanOrEqual(body.x + body.width - epsilon);
}
function coherent(boxes: readonly Box[]) {
  // Each member shares its group's readable column, rather than scattering into another group.
  const bounds = union(boxes);
  for (const box of boxes) expect(Math.abs(box.x + box.width / 2 - (bounds.x + bounds.width / 2))).toBeLessThanOrEqual(bounds.width * 0.08 + epsilon);
  const ordered = [...boxes].sort((left, right) => left.y - right.y);
  for (let index = 1; index < ordered.length; index++) expect(ordered[index - 1].y + ordered[index - 1].height).toBeLessThanOrEqual(ordered[index].y + epsilon);
}
function boundedReadableCaptionAssociation(data: Awaited<ReturnType<typeof deck>>, pageNumber: number, labelAlias: string, label: Box, value: Box) {
  const labelId = documentContentReferenceIndex(data.prepared.contentSnapshot)[labelAlias].id;
  const element = data.prepared.renderPlan!.pages[pageNumber - 1].elements.find(item => item.source.kind === 'content' && item.source.ref === labelId)!;
  expect(element.content.type).toBe('text');
  // These short fixture captions fit on one line at their admitted font size.
  // A label/value pair must not stretch a tiny caption across a large empty track.
  const readableLine = element.style.fontSize / 72 * 1.28;
  expect(label.height).toBeLessThanOrEqual(readableLine + 0.12 + epsilon);
  expect(value.y - label.y).toBeLessThanOrEqual(readableLine + 0.12 + 0.28 + epsilon);
  expect(value.y - (label.y + label.height)).toBeLessThanOrEqual(0.28 + epsilon);
}

async function deck(design: ProductionPresentationDesignIR = organizationPagesDesign()) {
  const contentSnapshot = buildDocumentContentSnapshot({ outline: organizationPagesOutline, identityScope: 'organization-production-facts' });
  let prepared: PresentationProductionPlan | undefined;
  const generated = await generateTemporaryDocumentFile({ kind: 'ppt', outline: organizationPagesOutline, contentSnapshot, designIR: design,
    presentationTemplate: 'work_report', outputDirectory: await root(), now: '2026-10-06T16:00:00.000Z',
    onPlanPrepared: value => { prepared = structuredClone(value); } });
  expect(prepared?.snapshot.designPath, JSON.stringify(prepared?.snapshot.diagnostics)).toBe('design-aware');
  if (!prepared?.renderPlan || !prepared.layoutIR) throw new Error('Expected a matched production plan');
  const zip = await JSZip.loadAsync(await readFile(generated.temporaryPath));
  const xml = await Promise.all(prepared.renderPlan.pages.map(page => zip.file(`ppt/slides/slide${page.pageNumber}.xml`)!.async('string')));
  return { generated, prepared, xml, contentSnapshot };
}

describe('semantic groups and relationships reach the real PPTX geometry', () => {
  it('writes standalone full-width headers, coherent comparison sides and full-width source notes', async () => {
    const data = await deck();
    const aMembers = sourceBoxes(data, 2, blocks(0, [0, 1, 2]));
    const bMembers = sourceBoxes(data, 2, blocks(0, [3, 4, 5]));
    coherent(aMembers); coherent(bMembers);
    const a = union(aMembers), b = union(bMembers), body = union([a, b]);
    expect(a.x + a.width).toBeLessThanOrEqual(b.x + epsilon);
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(epsilon);
    const header = union(sourceBoxes(data, 2, heading(0)));
    below(header, body); fullWidth(header, body);
    const note = union(sourceBoxes(data, 2, blocks(0, [6])));
    below(body, note); fullWidth(note, body);
    expect(await inspectPptxGeometry(data.generated.temporaryPath)).toEqual([]);
  });

  it('keeps each metric label and value together with parallel groups and a readable full-width provenance row', async () => {
    const data = await deck();
    const retention = sourceBoxes(data, 3, blocks(1, [0, 1]));
    const delivery = sourceBoxes(data, 3, blocks(1, [2, 3]));
    coherent(retention); coherent(delivery);
    expect(Math.abs(retention[1].y - delivery[1].y)).toBeLessThanOrEqual(epsilon);
    expect(Math.abs(retention[1].height - delivery[1].height)).toBeLessThanOrEqual(epsilon);
    boundedReadableCaptionAssociation(data, 3, blocks(1, [0])[0], retention[0], retention[1]);
    boundedReadableCaptionAssociation(data, 3, blocks(1, [2])[0], delivery[0], delivery[1]);
    const a = union(retention), b = union(delivery), body = union([a, b]);
    expect(a.x + a.width).toBeLessThanOrEqual(b.x + epsilon);
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(epsilon);
    below(union(sourceBoxes(data, 3, heading(1))), body);
    const note = union(sourceBoxes(data, 3, blocks(1, [4])));
    below(body, note); fullWidth(note, body);
  });

  it('orders steps by sequence edges despite shuffled group declarations, and changing only edges changes physical order', async () => {
    const initial = organizationPagesDesign();
    expect(initial.pages[3].organization!.groups.filter(group => group.role === 'step').map(group => group.groupId)).toEqual(['step-3', 'step-1', 'step-2']);
    const data = await deck(initial);
    const one = union(sourceBoxes(data, 4, blocks(2, [0, 1]))), two = union(sourceBoxes(data, 4, blocks(2, [2, 3]))), three = union(sourceBoxes(data, 4, blocks(2, [4, 5])));
    expect(one.x + one.width).toBeLessThanOrEqual(two.x + epsilon);
    expect(two.x + two.width).toBeLessThanOrEqual(three.x + epsilon);
    const changed = parsePresentationDesignIR({ ...initial, pages: initial.pages.map(page => page.pageNumber !== 4 ? page : { ...page,
      organization: { ...page.organization, relationships: [{ kind: 'sequence', fromGroupId: 'step-1', toGroupId: 'step-3' },
        { kind: 'sequence', fromGroupId: 'step-3', toGroupId: 'step-2' }] } }) }, { outline: organizationPagesOutline });
    const next = await deck(changed);
    const nextOne = union(sourceBoxes(next, 4, blocks(2, [0, 1]))), nextTwo = union(sourceBoxes(next, 4, blocks(2, [2, 3]))), nextThree = union(sourceBoxes(next, 4, blocks(2, [4, 5])));
    expect(nextOne.x + nextOne.width).toBeLessThanOrEqual(nextThree.x + epsilon);
    expect(nextThree.x + nextThree.width).toBeLessThanOrEqual(nextTwo.x + epsilon);
    expect(next.prepared.contentSnapshot).toEqual(data.prepared.contentSnapshot);
    for (const index of [0, 1, 2, 4, 5, 6]) expect(next.xml[index]).toBe(data.xml[index]);
    const body = union([one, two, three]);
    below(union(sourceBoxes(data, 4, heading(2))), body);
    fullWidth(union(sourceBoxes(data, 4, blocks(2, [6]))), body);
  });

  it('preserves every fact, stable source identity and compiled style while resolving organization to Host group identities', async () => {
    const data = await deck();
    for (const fact of organizationPagesFacts) expect(data.xml.join('')).toContain(fact);
    expect(data.prepared.contentSnapshot).toEqual(data.contentSnapshot);
    expect(data.prepared.layoutIR!.identity.contentDigest).toBe(computeDocumentContentDigest(data.contentSnapshot));
    const index = documentContentReferenceIndex(data.contentSnapshot);
    const design = organizationPagesDesign();
    for (const page of data.prepared.layoutIR!.pages.filter(page => page.source.kind === 'content')) {
      const organization = page.organization;
      if (!organization) throw new Error('Expected persisted resolved organization');
      expect(organization.source).toBe('explicit');
      const inputOrganization = design.pages[page.pageNumber - 1].organization!;
      const expected = inputOrganization.groups.flatMap(group => group.contentRefs.map(ref => index[ref].id));
      expect(organization.groups.flatMap(group => group.sourceRefs).sort()).toEqual([...expected].sort());
      expect(new Set(organization.groups.map(group => group.groupId)).size).toBe(organization.groups.length);
      expect(organization.groups.every(group => !inputOrganization.groups.some(input => input.groupId === group.groupId))).toBe(true);
      expect(data.prepared.renderPlan!.pages[page.pageNumber - 1].elements.filter(element => element.source.kind === 'content')
        .map(element => element.source.kind === 'content' ? element.source.ref : '').sort()).toEqual([...expected].sort());
      for (const element of data.prepared.renderPlan!.pages[page.pageNumber - 1].elements) {
        const actual = savedElement(data.xml[page.pageNumber - 1], element).xml;
        if (element.content.type === 'text') {
          expect(actual).toContain(`sz="${Math.round(element.style.fontSize * 100)}"`);
          expect(actual).toContain(`val="${element.style.color}"`);
        }
      }
    }
  });

  it.each(['bad_alias', 'duplicate_source', 'missing_source'] as const)('refuses %s at the real writer boundary without registering a Work', async invalid => {
    const rootDirectory = await root(), projectId = toProjectId(`organization-${invalid}`);
    const malformed = structuredClone(organizationPagesDesign());
    const groups = malformed.pages[1].organization!.groups.map(group => ({ ...group, contentRefs: [...group.contentRefs] }));
    if (invalid === 'bad_alias') groups[1].contentRefs[0] = 'outline.sections[99].blocks[0]';
    else if (invalid === 'duplicate_source') groups[2].contentRefs.push(groups[1].contentRefs[0]);
    else groups[1].contentRefs.pop();
    const bad = { ...malformed, pages: malformed.pages.map(page => page.pageNumber === 2 ? { ...page, organization: { ...page.organization!, groups } } : page) };
    const runner = new DocumentGenerationRunner({ rootDirectory, projectId,
      generateTemporaryFile: input => generateTemporaryDocumentFile({ ...input, designIR: bad }) });
    await expect(runner.run({ kind: 'ppt', title: organizationPagesOutline.title, outline: organizationPagesOutline,
      sourceDraftId: `organization-invalid-${invalid}`, draftRevision: 1, contentFingerprint: digest(organizationPagesOutline) })).rejects.toThrow();
    expect(await new JsonWorkRepository(new NodeProjectStorage(rootDirectory), projectId).list(projectId)).toEqual([]);
  });

  it.each(['foreign_alias', 'duplicate_source', 'missing_source'] as const)(
    'blocks a model-proposed %s organization before formal publication instead of silently falling back', async invalid => {
      const rootDirectory = await root(), projectId = toProjectId(`organization-proposed-${invalid}`);
      const initial = organizationPagesDesign();
      const groups = initial.pages[1].organization!.groups.map(group => ({ ...group, contentRefs: [...group.contentRefs] }));
      // The foreign alias exists in the document, but belongs to another page.
      if (invalid === 'foreign_alias') groups[1].contentRefs[0] = 'outline.sections[1].blocks[0]';
      else if (invalid === 'duplicate_source') groups[2].contentRefs.push(groups[1].contentRefs[0]);
      else groups[1].contentRefs.pop();
      const proposed = { ...initial, pages: initial.pages.map(page => page.pageNumber === 2
        ? { ...page, organization: { ...page.organization!, groups } } : page) };
      const planner = vi.fn(async () => proposed);
      const runner = new DocumentGenerationRunner({ rootDirectory, projectId });
      const execution = runner.run({ kind: 'ppt', title: organizationPagesOutline.title, outline: organizationPagesOutline,
        sourceDraftId: `proposed-invalid-${invalid}`, draftRevision: 1, contentFingerprint: digest(organizationPagesOutline),
        userRequirement: '按已声明的页面分组组织全部内容，不允许丢失、重复或跨页借用事实。', requestArtDirection: planner });
      if (invalid === 'missing_source') await expect(execution).rejects.toMatchObject({ code: 'document_layout_overflow' });
      else await expect(execution).rejects.toMatchObject({ code: 'invalid_plan' });
      expect(planner).toHaveBeenCalledTimes(1);
      expect(await new JsonWorkRepository(new NodeProjectStorage(rootDirectory), projectId).list(projectId)).toEqual([]);
    });

  it('retains organization and non-target page XML through a controlled production repair', async () => {
    const rootDirectory = await root(), projectId = toProjectId('organization-repair');
    const records: PresentationProductionPlan[] = [], buffers: Uint8Array[] = [];
    let renderCount = 0;
    const planner = vi.fn(async () => organizationPagesDesign());
    const repairPlanner = vi.fn(async () => ({ kind: 'repair', diagnosisCodes: ['text_overflow'],
      operations: [{ operation: 'replace_page_layout', target: { sectionIndex: 0 }, value: 'data' }],
      expectedRevision: 1, preserve: [], reason: 'Keep declared groups while selecting a supported layout' }));
    const runner = new DocumentGenerationRunner({ rootDirectory, projectId,
      generateTemporaryFile: async input => {
        const result = await generateTemporaryDocumentFile({ ...input, onPlanPrepared: async plan => {
          records.push(structuredClone(plan)); await input.onPlanPrepared?.(plan);
        } });
        buffers.push(await readFile(result.temporaryPath)); return result;
      }, renderPreview: async () => ({ previewCount: 7, diagnostics: ++renderCount === 1
        ? [{ code: 'text_overflow', severity: 'error', scope: 'page:2', message: 'synthetic repair trigger' }] : [] }) });
    const result = await runner.run({ kind: 'ppt', title: organizationPagesOutline.title, outline: organizationPagesOutline,
      sourceDraftId: 'organization-repair-draft', draftRevision: 1, contentFingerprint: digest(organizationPagesOutline),
      userRequirement: '修正对比页的结构溢出，保持已确认分组、全部事实及其他页面不变。',
      requestArtDirection: planner, requestLlmRepair: repairPlanner });
    expect(result.execution.state).toBe('completed'); expect(records).toHaveLength(2);
    expect(planner).toHaveBeenCalledTimes(1); expect(repairPlanner).toHaveBeenCalledTimes(1);
    expect(records.every(record => record.snapshot.designPath === 'design-aware')).toBe(true);
    expect(records[1].renderPlan!.pages[1].elements.map(element => element.geometry))
      .not.toEqual(records[0].renderPlan!.pages[1].elements.map(element => element.geometry));
    expect(records[1].designIR!.pages.map(page => page.organization)).toEqual(records[0].designIR!.pages.map(page => page.organization));
    expect(records[1].layoutIR!.pages.map(page => page.organization)).toEqual(records[0].layoutIR!.pages.map(page => page.organization));
    expect(records[1].contentSnapshot).toEqual(records[0].contentSnapshot);
    const [before, after] = await Promise.all(buffers.map(buffer => JSZip.loadAsync(buffer)));
    for (const pageNumber of [1, 3, 4, 5, 6, 7]) expect(await after.file(`ppt/slides/slide${pageNumber}.xml`)!.async('string'))
      .toBe(await before.file(`ppt/slides/slide${pageNumber}.xml`)!.async('string'));
    const read = await new RegisteredPresentationReader({ rootDirectory, projectId }).readWithProductionPlan(result.work.id);
    expect(read.productionPlan!.attempt.attempt).toBe(1);
    expect(read.productionPlan!.plan.layoutIR!.pages.map(page => page.organization)).toEqual(records[1].layoutIR!.pages.map(page => page.organization));
  });

  it.skipIf(!process.env.UNICOMP_OFFICE_RENDERER || !process.env.UNICOMP_PDF_RENDERER)(
    'renders the grouped fixture through the configured local structural QA adapter', async () => {
      const data = await deck();
      const renderer = createConfiguredOfficeRenderAdapter();
      expect(renderer).toBeDefined();
      const rendered = await renderer!(data.generated.temporaryPath, { kind: 'ppt', signal: new AbortController().signal });
      expect(rendered.previewCount).toBe(7);
      expect((rendered.diagnostics ?? []).filter(diagnostic => diagnostic.severity === 'error' && diagnostic.code !== 'font_missing')).toEqual([]);
    }, 10_000);
});
