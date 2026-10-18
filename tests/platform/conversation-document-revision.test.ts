import { fixtureToolService } from '../fixtures/conversation-semantic-classifier';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addCompletedAssistantMessage, addUserMessage, attachDocumentResultToMessage, createConversationResponseDraft,
  createProjectConversation, toConversationId, toConversationResponseDraftId, toIsoTimestamp, toMessageId, toProjectId,
  type DocumentOutline } from '../../src/domain';
import { NodeProjectStorage } from '../../src/platform/storage';
import { JsonProjectConversationRepository } from '../../src/platform/repositories/json-project-conversation-repository';
import { JsonWorkRepository } from '../../src/platform/repositories/json-repositories';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { PlatformDocumentDraftCompiler, PlatformDocumentGenerationExecutor } from '../../src/platform/documents/document-generation-application-adapters';
import type { ConversationDocumentToolSessionService} from '../../src/platform/documents/conversation-document-tool-session';
import { type ConversationDocumentToolSession } from '../../src/platform/documents/conversation-document-tool-session';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import { readRegisteredOfficeDocument } from '../../src/platform/documents/registered-office-reader';
import { DocumentIdentityIndexStore } from '../../src/platform/documents/document-identity-index-store';
import { authoredFixtureDesign, autonomousOutline, splitTree } from '../fixtures/presentation-autonomous-design';
import type { DocumentToolResult } from '../../src/domain/entities/canonical-tool-contract';
import * as productionTrace from '../../src/platform/conversation-production-trace';
import { readPptxDocument } from '../../src/platform/documents/pptx-page-reader';
import { generateTemporaryDocumentFile } from '../../src/platform/documents/office-document-generator';

const roots: string[] = [], sessions: ConversationDocumentToolSession[] = [], services: ConversationDocumentToolSessionService[] = [];
const at = toIsoTimestamp('2026-10-17T12:00:00.000Z');
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(session => session.close()));
  await Promise.allSettled(services.splice(0).map(service => service.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function fixture(kind: 'word' | 'excel' | 'ppt', query: string, unchanged = false, legacyFallback = false, excelFormula = false) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-native-revision-')); roots.push(rootDirectory);
  const projectId = toProjectId('native-revision-project'), storage = new NodeProjectStorage(rootDirectory);
  const conversations = new JsonProjectConversationRepository(storage, projectId, () => at);
  let conversation = createProjectConversation({ id: toConversationId('native-revision'), projectId, title: 'Native revision', createdAt: at });
  await conversations.create(conversation);
  const save = async (next: typeof conversation) => { await conversations.save(next, conversation.revision); conversation = next; };
  await save(addUserMessage(conversation, { id: toMessageId('original'), content: `生成 ${kind}`, createdAt: at }));
  const outline: DocumentOutline = kind === 'ppt' ? autonomousOutline : { kind, title: '原生版本测试', sections: [
    { heading: '目标分节', level: 1, blocks: kind === 'word' ? [{ type: 'paragraph', text: '旧文本事实' }]
      : [{ type: 'table', header: excelFormula ? ['项目', '数量', '合计'] : ['项目', '数量'],
        rows: excelFormula ? [['目标', '3', '4'], ['保留行', '7', '8']] : [['目标', '3'], ['保留行', '7']] }] },
    { heading: '保留分节', level: 1, blocks: kind === 'excel' ? [{ type: 'table', header: ['保留项'], rows: [['非目标内容保持']] }]
      : [{ type: 'paragraph', text: '非目标内容保持' }] }
  ] };
  const renderPreview = vi.fn(async (temporaryPath: string) => ({ previewCount: kind === 'ppt' ? (await readPptxDocument(await readFile(temporaryPath))).length : 1, diagnostics: [] }));
  let corruptOfficeOutput = false;
  const runner = new DocumentGenerationRunner({ rootDirectory, projectId, renderPreview,
    generateTemporaryFile: async (input: Parameters<typeof generateTemporaryDocumentFile>[0]) => {
      const generated = await generateTemporaryDocumentFile(input);
      if (!excelFormula && !corruptOfficeOutput) return generated;
      const book = new ExcelJS.Workbook(); await book.xlsx.readFile(generated.temporaryPath);
      if (excelFormula) book.worksheets[0].getCell('C2').value = { formula: 'B2+1', result: 4 };
      if (corruptOfficeOutput) book.worksheets[0].getCell('A3').value = '未经授权的修改';
      const bytes = await book.xlsx.writeBuffer(); await writeFile(generated.temporaryPath, new Uint8Array(bytes));
      return { ...generated, sizeBytes: bytes.byteLength };
    } });
  const original = await runner.run({ kind, outline, title: outline.title, draftRevision: 0, sourceDraftId: 'source-draft',
    contentFingerprint: 'a'.repeat(64), presentationTemplate: 'business_minimal', userRequirement: '合成验收：根据原始内容自主设计',
    ...(kind === 'ppt' ? { requestArtDirection: async () => legacyFallback ? '{' : authoredFixtureDesign(outline, splitTree()) } : {}) });
  await save(addCompletedAssistantMessage(conversation, { id: toMessageId('delivered'), content: '文件已交付', createdAt: at }));
  await save(attachDocumentResultToMessage(conversation, toMessageId('delivered'), { kind, workId: original.work.id,
    fileName: original.file.locator.kind === 'project' ? path.basename(original.file.locator.relativePath) : 'unexpected', sizeBytes: original.file.sizeBytes! }, at));
  await save(addUserMessage(conversation, { id: toMessageId('revision-user'), content: query, createdAt: at }));
  const planner = vi.fn(async (request: Parameters<NonNullable<ConstructorParameters<typeof ConversationDocumentToolSessionService>[0]['artDirectionPlanner']>>[0]) => {
    if (!request.input.designFeedback && request.input.outline.pageCount === 4) return authoredFixtureDesign({ ...autonomousOutline,
      sections: [{ ...autonomousOutline.sections[0], blocks: [autonomousOutline.sections[0].blocks[0]] },
        { ...autonomousOutline.sections[0], blocks: autonomousOutline.sections[0].blocks.slice(1) }] });
    if (!request.input.designFeedback) return authoredFixtureDesign(autonomousOutline, splitTree(45));
    const previous = request.input.designFeedback!.previousDesign;
    if (unchanged) return previous;
    return { ...previous, pages: previous.pages.map(page => page.pageNumber === 2 ? { ...page, designTree: splitTree(45) } : page) };
  });
  const failures: string[] = [];
  const diagnostics = vi.spyOn(productionTrace, 'emitProductionDiagnostic');
  const executor = new PlatformDocumentGenerationExecutor(runner);
  let active = true;
  const service = fixtureToolService({ rootDirectory, projectId, conversations,
    getCurrentProjectId: () => active ? projectId : undefined,
    mutation: { renderPreview }, artDirectionPlanner: planner,
    generatePptx: { compiler: new PlatformDocumentDraftCompiler(), executor: { run: async input => {
      try { return await executor.run(input); } catch (error) { failures.push(error instanceof Error ? error.message : 'unknown'); throw error; }
    } }, revalidateAuthorization: async () => true } });
  services.push(service);
  const draft = createConversationResponseDraft({ id: toConversationResponseDraftId('revision-draft'), projectId,
    conversationId: conversation.id, conversationRevision: conversation.revision, userMessageId: toMessageId('revision-user'),
    userMessageRevision: conversation.messages.at(-1)!.revision, agentNative: true, productFeature: 'text_chat', createdAt: at });
  const selection = await service.prepare({ conversation, draft });
  expect(selection).toMatchObject({ kind: kind === 'ppt' ? 'mutation' : 'revision' });
  const session = await service.createSession({ selection: selection!, responseExecutionId: 'native-revision-execution' }); sessions.push(session);
  const execute = async (name: string, args: Record<string, string | number>, id = name) => {
    if (!session.executionBudget?.stopReason) await session.prepareTools(new AbortController().signal);
    return await session.bridge.execute({ call: { id, name, arguments: args }, signal: new AbortController().signal }) as unknown as DocumentToolResult;
  };
  return { rootDirectory, projectId, storage, original, session, execute, service, planner, failures, diagnostics, renderPreview, selection,
    revoke: () => { active = false; }, corruptOutput: () => { corruptOfficeOutput = true; } };
}

describe('native existing-document revision', () => {
  it('still rejects an extra changed cell outside the union of an authorized Office edit plan', async () => {
    const f = await fixture('excel', '修改当前Excel第一个工作表的两行数量');
    await f.session.prepareTools(new AbortController().signal);
    await f.execute('read_document_structure', { scope: 'section', ordinal: 1 });
    f.corruptOutput();
    const changes = [
      { operation: 'update_cells', sectionOrdinal: 1, blockOrdinal: 1, row: 1, column: 2, text: '5' },
      { operation: 'update_cells', sectionOrdinal: 1, blockOrdinal: 1, row: 2, column: 2, text: '9' }
    ];
    const result = await f.execute('revise_office', { operation: 'apply_changes', changes: JSON.stringify(changes) });
    expect(result.status).not.toBe('success');
    expect(f.failures).toContain('Fine-grained revision changed cells outside the target');
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(1);
  });
  it('validates all Office changes before publishing a single version', async () => {
    const f = await fixture('excel', '修改当前Excel第一个工作表的两行数量');
    await f.session.prepareTools(new AbortController().signal);
    await f.execute('read_document_structure', { scope: 'section', ordinal: 1 });
    const changes = [
      { operation: 'update_cells', sectionOrdinal: 1, blockOrdinal: 1, row: 1, column: 2, text: '5' },
      { operation: 'update_cells', sectionOrdinal: 1, blockOrdinal: 1, row: 2, column: 2, text: '9' }
    ];
    const denied = await f.execute('revise_office', { operation: 'apply_changes', changes: JSON.stringify([changes[0], { ...changes[1], sectionOrdinal: 2 }]) }, 'bad-batch');
    expect(denied.status).toBe('failed');
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(1);
    const result = await f.execute('revise_office', { operation: 'apply_changes', changes: JSON.stringify(changes) });
    expect(f.failures).toEqual([]);
    expect(result.status).toBe('success');
    const workId = result.artifactRefs!.find(ref => ref.kind === 'work')!.ref as typeof f.original.work.id;
    const revised = await readRegisteredOfficeDocument({ ...f, workId, kind: 'excel' });
    expect(revised.outline.sections[0].blocks[0]).toMatchObject({ rows: [['目标', '5'], ['保留行', '9']] });
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(2);
  });
  it('reads actual Excel formula/cache values and preserves non-target formulas during a cell update', async () => {
    const f = await fixture('excel', '修改当前Excel第一个工作表的数量', false, false, true);
    await f.session.prepareTools(new AbortController().signal);
    const read = await f.execute('read_document_structure', { scope: 'section', ordinal: 1 });
    expect(JSON.stringify(read.observation)).toContain('=B2+1（缓存值：4）');
    expect(JSON.stringify(read.observation)).not.toContain('[object Object]');
    const result = await f.execute('revise_office', { operation: 'update_cells', sectionOrdinal: 1, blockOrdinal: 1, row: 1, column: 2, text: '5' });
    expect(result.status).toBe('success');
    const id = result.artifactRefs!.find(ref => ref.kind === 'work')!.ref as typeof f.original.work.id;
    const revised = await readRegisteredOfficeDocument({ ...f, workId: id, kind: 'excel' });
    const book = new ExcelJS.Workbook(); await book.xlsx.load(revised.buffer as never);
    expect(book.worksheets[0].getCell('B2').value).toBe('5');
    expect(book.worksheets[0].getCell('C2').value).toEqual({ formula: 'B2+1', result: 4 });
  });
  it('freezes an unknown design-provider outcome without retrying or writing a file', async () => {
    const f = await fixture('ppt', '重新排版当前PPT第二页');
    await f.session.prepareTools(new AbortController().signal);
    await f.execute('read_document_structure', { scope: 'page', ordinal: 2 });
    f.planner.mockRejectedValue(Object.assign(new Error('Synthetic unknown planning outcome'), { outcome: 'unknown' }));
    const result = await f.execute('revise_presentation', { scope: 'page', ordinal: 2, request: '重新排版' });
    expect(result.status).toBe('unknown');
    expect(f.planner).toHaveBeenCalledTimes(1);
    expect((await f.execute('revise_presentation', { scope: 'page', ordinal: 2, request: '再试一次' }, 'retry-unknown')).status).not.toBe('success');
    expect(f.planner).toHaveBeenCalledTimes(1);
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(1);
  });
  it('can redesign a verified whole-deck legacy fallback from its canonical facts', async () => {
    const f = await fixture('ppt', '重新设计整份PPT，保留全部事实', false, true);
    const before = await new RegisteredPresentationReader(f).readWithProductionPlan(f.original.work.id);
    expect(before.productionPlan!.plan.snapshot.designPath).toBe('legacy-fallback');
    expect(before.productionPlan!.plan.renderPlan).toBeUndefined();
    await f.session.prepareTools(new AbortController().signal);
    await f.execute('read_document_structure', { scope: 'document' });
    const result = await f.execute('revise_presentation', { scope: 'document', request: '重新设计整份，保留事实' });
    expect(f.diagnostics.mock.calls.filter(([event]) => event.operationId?.startsWith('document_revision_')).map(([event]) => event.operationId)).toEqual([]);
    expect(result.status).toBe('success');
    const workId = result.artifactRefs!.find(ref => ref.kind === 'work')!.ref as typeof f.original.work.id;
    const after = await new RegisteredPresentationReader(f).readWithProductionPlan(workId);
    expect(after.productionPlan!.plan.snapshot.designPath).toBe('design-aware');
    expect(after.productionPlan!.plan.outline).toEqual(before.productionPlan!.plan.outline);
    expect(after.productionPlan!.plan.designIR!.pages.every(page => page.designTree)).toBe(true);
  });
  it('lets the Agent choose visual revision for a general edit request after observing the current page', async () => {
    const f = await fixture('ppt', '把当前PPT第二页改得更专业一点');
    expect(f.selection).toMatchObject({ scope: 'page', ordinal: 2, writeAuthorized: true });
    const initial = await f.session.prepareTools(new AbortController().signal);
    expect(initial?.some(tool => tool.function.name === 'generate_pptx')).toBe(false);
    await f.execute('read_document_structure', { scope: 'page', ordinal: 2 });
    const observed = await f.session.prepareTools(new AbortController().signal);
    expect(observed?.some(tool => tool.function.name === 'revise_presentation')).toBe(true);
    const result = await f.execute('revise_presentation', { scope: 'page', ordinal: 2, request: '以左右两区组织信息，明确层级' });
    expect(f.diagnostics.mock.calls.filter(([event]) => event.operationId?.startsWith('document_revision_')).map(([event]) => event.operationId)).toEqual([]);
    expect(result.status).toBe('success');
    await f.session.close();
    const facts = await f.service.collectResponseFacts('native-revision-execution');
    expect(facts.documentTasks.filter(task => task.active)).toHaveLength(1);
    expect(facts.documentTasks.find(task => task.active)?.runtime.status).toBe('completed');
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(2);
  });
  it('stops before writing when cancelled after the verified read', async () => {
    const f = await fixture('ppt', '重新排版当前PPT第二页');
    await f.session.prepareTools(new AbortController().signal);
    await f.execute('read_document_structure', { scope: 'page', ordinal: 2 });
    await f.session.cancel?.();
    expect((await f.execute('revise_presentation', { scope: 'page', ordinal: 2, request: '重新排版' })).status).not.toBe('success');
    expect(f.planner).not.toHaveBeenCalled();
    await f.session.close();
    expect((await f.service.collectResponseFacts('native-revision-execution')).documentTasks[0].runtime.status).toBe('cancelled');
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(1);
  });
  it('revalidates authorization after rendering and freezes an uncertain write without publishing a Work', async () => {
    const f = await fixture('ppt', '重新排版当前PPT第二页');
    await f.session.prepareTools(new AbortController().signal);
    await f.execute('read_document_structure', { scope: 'page', ordinal: 2 });
    f.renderPreview.mockImplementation(async temporaryPath => { f.revoke(); return { previewCount: (await readPptxDocument(await readFile(temporaryPath))).length, diagnostics: [] }; });
    const result = await f.execute('revise_presentation', { scope: 'page', ordinal: 2, request: '重新排版' });
    expect(result.status).toBe('unknown');
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(1);
    await f.session.close();
    expect((await f.service.collectResponseFacts('native-revision-execution')).unknownResult).toBe(true);
    expect((await f.execute('revise_presentation', { scope: 'page', ordinal: 2, request: '重新排版' }, 'no-replay')).status).not.toBe('success');
  });
  it('rejects global style changes in a page-only plan', async () => {
    const f = await fixture('ppt', '重新排版当前PPT第二页');
    await f.session.prepareTools(new AbortController().signal);
    await f.execute('read_document_structure', { scope: 'page', ordinal: 2 });
    f.planner.mockImplementation(async request => { const prior = request.input.designFeedback!.previousDesign;
      return { ...prior, globalDesign: { ...prior.globalDesign, visualTone: 'bold' as const } }; });
    expect((await f.execute('revise_presentation', { scope: 'page', ordinal: 2, request: '重新排版' })).status).toBe('failed');
    expect(f.planner).toHaveBeenCalledTimes(1);
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(1);
  });
  it('does not let the model authorize content reorganization during a visual-only request', async () => {
    const f = await fixture('ppt', '重新排版整份PPT');
    await f.session.prepareTools(new AbortController().signal);
    const read = await f.execute('read_document_structure', { scope: 'document' });
    expect(read.observation).not.toHaveProperty('contentReorganizationAllowed');
    const contentOrganization = JSON.stringify({ schemaVersion: 1, sections: [{ headingRef: 'outline.sections[0].heading', blockRefs: [
      'outline.sections[0].blocks[0]', 'outline.sections[0].blocks[1]', 'outline.sections[0].blocks[2]' ] }] });
    expect((await f.execute('revise_presentation', { scope: 'document', request: '重组内容', contentOrganization })).status).toBe('failed');
    expect(f.planner).not.toHaveBeenCalled();
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(1);
  });
  it('allows one explicitly authorized content reorganization with complete fact coverage', async () => {
    const f = await fixture('ppt', '整份PPT的内容重新组织，页数不限，保留全部事实和原配色');
    await f.session.prepareTools(new AbortController().signal);
    const read = await f.execute('read_document_structure', { scope: 'document' });
    expect(read.observation).toMatchObject({ contentReorganizationAllowed: true, paginationChangeAllowed: true });
    const contentOrganization = JSON.stringify({ schemaVersion: 1, sections: [
      { headingRef: 'outline.sections[0].heading', blockRefs: ['outline.sections[0].blocks[0]'] },
      { headingRef: 'outline.sections[0].heading', blockRefs: ['outline.sections[0].blocks[1]', 'outline.sections[0].blocks[2]'] }
    ] });
    const result = await f.execute('revise_presentation', { scope: 'document', request: '重新组织已有内容', contentOrganization });
    expect(f.diagnostics.mock.calls.filter(([event]) => event.operationId?.startsWith('document_revision_')).map(([event]) => event.operationId)).toEqual([]);
    expect(result.status).toBe('success');
    const workId = result.artifactRefs!.find(ref => ref.kind === 'work')!.ref as typeof f.original.work.id;
    const current = await new RegisteredPresentationReader(f).readWithProductionPlan(workId);
    expect(current.pages).toHaveLength(4);
    expect(current.productionPlan!.plan.outline.sections).toHaveLength(2);
    const body = current.productionPlan!.plan.outline.sections.flatMap(section => section.blocks);
    expect(body).toEqual(autonomousOutline.sections[0].blocks);
    expect((await f.execute('revise_presentation', { scope: 'document', request: '再次重组', contentOrganization }, 'second-reorganization')).status).not.toBe('success');
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(2);
  });
  it('redesigns an existing physical page and preserves untouched OOXML and identities', async () => {
    const f = await fixture('ppt', '保留事实，重新排版当前PPT第二页，左右比例调整为45/55');
    const before = await new RegisteredPresentationReader(f).readWithProductionPlan(f.original.work.id);
    expect(before.productionPlan?.plan.snapshot.diagnostics).toEqual([]);
    expect(before.productionPlan?.plan).toMatchObject({ designIR: expect.any(Object), renderPlan: expect.any(Object) });
    expect((await f.session.prepareTools(new AbortController().signal))?.map(tool => tool.function.name)).toEqual(['read_document_structure', 'update_element', 'add_element', 'delete_element', 'add_slide']);
    expect((await f.execute('revise_presentation', { scope: 'page', ordinal: 2, request: '重新构图' }, 'before-read')).status).not.toBe('success');
    expect((await f.execute('read_document_structure', { scope: 'page', ordinal: 2 })).status).toBe('success');
    expect((await f.session.prepareTools(new AbortController().signal))?.map(tool => tool.function.name).sort()).toEqual(['add_element', 'add_slide', 'delete_element', 'read_document_structure', 'revise_presentation', 'update_element']);
    expect((await f.execute('revise_presentation', { scope: 'document', request: '修改全篇' }, 'outside-scope')).status).not.toBe('success');
    const result = await f.execute('revise_presentation', { scope: 'page', ordinal: 2, request: '左右比例调整为45/55' });
    expect(f.diagnostics.mock.calls.filter(([event]) => event.operationId?.startsWith('document_revision_')).map(([event]) => event.operationId)).toEqual([]);
    expect(result.status).toBe('success');
    const workId = result.artifactRefs!.find(ref => ref.kind === 'work')!.ref as typeof f.original.work.id;
    const after = await new RegisteredPresentationReader(f).readWithProductionPlan(workId);
    expect(after.work.parentWorkId).toBe(before.work.id);
    expect(after.productionPlan!.plan.renderPlan!.pages[1]).not.toEqual(before.productionPlan!.plan.renderPlan!.pages[1]);
    const [oldZip, newZip] = await Promise.all([JSZip.loadAsync(before.buffer), JSZip.loadAsync(after.buffer)]);
    for (const page of [1, 3]) expect(await newZip.file(`ppt/slides/slide${page}.xml`)!.async('string'))
      .toBe(await oldZip.file(`ppt/slides/slide${page}.xml`)!.async('string'));
    const index = new DocumentIdentityIndexStore(f.storage);
    const previousIdentity = await index.getForWork(before.work.id), nextIdentity = await index.getForWork(after.work.id);
    expect(nextIdentity!.pages.map(page => page.pageId)).toEqual(previousIdentity!.pages.map(page => page.pageId));
    for (const page of previousIdentity!.pages.filter(page => page.physicalPageNumber !== 2)) {
      expect(nextIdentity!.elements.filter(item => item.pageId === page.pageId)).toEqual(previousIdentity!.elements.filter(item => item.pageId === page.pageId));
    }
    expect((await f.service.collectResponseFacts('native-revision-execution')).unknownResult).toBe(false);
    await f.session.prepareTools(new AbortController().signal);
    await f.execute('read_document_structure', { scope: 'page', ordinal: 2 }, 'new-version-read');
    expect(await f.session.prepareTools(new AbortController().signal)).toBeUndefined();
    expect((await f.execute('revise_presentation', { scope: 'page', ordinal: 2, request: '再改一次' }, 'second-write')).status).not.toBe('success');
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(2);
  });
  it('does not publish an unchanged model design as a new version', async () => {
    const f = await fixture('ppt', '重新排版当前PPT第二页', true);
    await f.session.prepareTools(new AbortController().signal);
    await f.execute('read_document_structure', { scope: 'page', ordinal: 2 });
    const result = await f.execute('revise_presentation', { scope: 'page', ordinal: 2, request: '重新构图' });
    expect(result).toMatchObject({ status: 'success', observation: { changed: false, operation: 'already_compliant' } });
    expect(await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).toHaveLength(1);
  });
  it.each(['word', 'excel'] as const)('edits the observed %s scope while keeping the original version', async kind => {
    const f = await fixture(kind, kind === 'word' ? '修改当前Word第一章的文字' : '修改当前Excel第一个工作表的数量');
    await f.session.prepareTools(new AbortController().signal);
    expect((await f.execute('read_document_structure', { scope: 'section', ordinal: 1 })).status).toBe('success');
    const args: Record<string, string | number> = kind === 'word' ? { operation: 'replace_text', sectionOrdinal: 1, blockOrdinal: 1, text: '修订后的事实' }
      : { operation: 'update_cells', sectionOrdinal: 1, blockOrdinal: 1, row: 1, column: 2, text: '5' };
    expect((await f.execute('revise_office', { ...args, sectionOrdinal: 2 }, 'outside-office-scope')).status).not.toBe('success');
    const originalBytes = await readRegisteredOfficeDocument({ ...f, workId: f.original.work.id, kind });
    const result = await f.execute('revise_office', args);
    expect(f.failures).toEqual([]);
    expect(result.status).toBe('success');
    const workId = result.artifactRefs!.find(ref => ref.kind === 'work')!.ref as typeof f.original.work.id;
    const after = await readRegisteredOfficeDocument({ ...f, workId, kind });
    expect(JSON.stringify(after.outline)).toContain(kind === 'word' ? '修订后的事实' : '5');
    expect(after.work.parentWorkId).toBe(f.original.work.id);
    expect((await readRegisteredOfficeDocument({ ...f, workId: f.original.work.id, kind })).buffer).toEqual(originalBytes.buffer);
    expect((await new JsonWorkRepository(f.storage, f.projectId).list(f.projectId)).length).toBe(2);
  });
});
