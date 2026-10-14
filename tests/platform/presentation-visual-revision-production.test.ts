import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentGenerationApplicationService, ConversationStreamingService } from '../../src/application';
import { addUserMessage, createConversation, toConversationId, toMessageId, toProjectId, toIsoTimestamp } from '../../src/domain';
import { JsonProjectConversationRepository, JsonWorkRepository } from '../../src/platform/repositories';
import { NodeProjectStorage } from '../../src/platform/storage';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import { PlatformDocumentDraftCompiler, PlatformDocumentGenerationExecutor } from '../../src/platform/documents/document-generation-application-adapters';
import { stylePagesDesign, stylePagesOutline } from '../fixtures/presentation-style-pages';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('registered PPT visual revision through Application and Runner', () => {
  it.each([3, 4])('changes page %s in the real package, preserves other parts and reads back the new production plan', async targetPage => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-visual-revision-'));
    roots.push(rootDirectory);
    const projectId = toProjectId('visual-revision-production');
    const storage = new NodeProjectStorage(rootDirectory);
    const now = () => '2026-10-14T06:00:00.000Z';
    const runner = new DocumentGenerationRunner({ rootDirectory, projectId, now });
    const base = await runner.run({ kind: 'ppt', title: stylePagesOutline.title, outline: stylePagesOutline,
      contentFingerprint: hash('visual-parent'), sourceDraftId: 'visual-parent', draftRevision: 1,
      userRequirement: 'Use the supplied style and keep every fact',
      requestArtDirection: async () => stylePagesDesign() });
    const reader = new RegisteredPresentationReader({ rootDirectory, projectId });
    const parent = await reader.readWithProductionPlan(base.work.id);
    expect(parent.productionPlan?.plan.designIR).toBeDefined();
    const conversationId = toConversationId('visual-revision-conversation');
    const conversations = new JsonProjectConversationRepository(storage, projectId, now);
    await conversations.create(createConversation({ id: conversationId, projectId, title: 'visual', createdAt: toIsoTimestamp(now()) }));
    let sequence = 0;
    const streaming = new ConversationStreamingService(conversations, {
      nextConversationId: () => conversationId, nextMessageId: () => toMessageId(`visual-${++sequence}`)
    }, now);
    const assistant = async (content: string) => streaming.createCompletedLocalAssistantMessage({ conversationId,
      expectedRevision: (await conversations.get(conversationId))!.revision, content });
    const delivered = await assistant(JSON.stringify(stylePagesOutline));
    await streaming.attachDocumentResult({ conversationId, messageId: delivered.messageId,
      expectedRevision: (await conversations.get(conversationId))!.revision,
      documentResult: { kind: 'ppt', workId: base.work.id, fileName: parent.fileName, sizeBytes: parent.file.sizeBytes!, validatedContent: JSON.stringify(stylePagesOutline) } });
    const current = (await conversations.get(conversationId))!;
    await conversations.save(addUserMessage(current, { id: toMessageId('visual-user'), content: `第${targetPage}页更简洁一点`,
      createdAt: toIsoTimestamp(now()) }), current.revision);
    // A visual-only response need not duplicate or rewrite the content outline.
    const response = await assistant('将调整第三页的视觉设计。');
    const app = new DocumentGenerationApplicationService({ projectId,
      conversations: { load: id => conversations.get(id), attachDocumentResult: async input => { await streaming.attachDocumentResult(input); },
        updateDocumentGenerationStatus: async input => { await streaming.updateDocumentGenerationStatus(input); } },
      compiler: new PlatformDocumentDraftCompiler(), generator: new PlatformDocumentGenerationExecutor(runner), fingerprint: hash,
      resolvePresentationMap: async (workId, outline) => (await reader.readWithProductionPlan(workId, outline)).map!,
      loadPresentationProductionPlan: async workId => (await reader.readWithProductionPlan(workId)).productionPlan?.plan
    });
    const result = await app.generateFromMessage({ conversationId, expectedRevision: response.conversation.revision,
      messageId: response.messageId, kind: 'ppt', parentWorkId: base.work.id, images: [] });
    const revised = await reader.readWithProductionPlan(result.workId);
    expect(revised.productionPlan).toBeDefined();
    expect(revised.productionPlan!.plan.contentSnapshot).toEqual(parent.productionPlan!.plan.contentSnapshot);
    expect(revised.productionPlan!.plan.designIR!.pages[targetPage - 1]).toMatchObject({ density: 'sparse', whitespace: 'generous' });
    expect(revised.productionPlan!.plan.snapshot).toMatchObject({ designPath: 'design-aware', designIrStatus: 'validated' });
    const [before, after] = await Promise.all([JSZip.loadAsync(parent.buffer), JSZip.loadAsync(revised.buffer)]);
    expect(await after.file(`ppt/slides/slide${targetPage}.xml`)!.async('string')).not.toBe(await before.file(`ppt/slides/slide${targetPage}.xml`)!.async('string'));
    for (const [name, file] of Object.entries(before.files)) {
      if (file.dir || ['[Content_Types].xml', `ppt/slides/slide${targetPage}.xml`, `ppt/slides/_rels/slide${targetPage}.xml.rels`].includes(name)) continue;
      expect(await after.file(name)!.async('nodebuffer'), name).toEqual(await file.async('nodebuffer'));
    }
    expect((await reader.read(base.work.id)).buffer).toEqual(parent.buffer);
    expect(await new JsonWorkRepository(storage, projectId).list(projectId)).toHaveLength(2);
  }, 15_000);
});
