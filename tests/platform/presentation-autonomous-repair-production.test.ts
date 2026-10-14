import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toProjectId } from '../../src/domain';
import { buildDocumentIRFromOutline } from '../../src/domain/entities/document-agent';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { generateTemporaryDocumentFile, type GenerateDocumentFileInput } from '../../src/platform/documents/office-document-generator';
import { NodeProjectStorage } from '../../src/platform/storage';
import { JsonWorkRepository } from '../../src/platform/repositories';
import { presentationAttemptPath, parsePresentationDesignAttempt, type PresentationDesignAttempt, type PresentationCandidateQaReceipt } from '../../src/platform/documents/presentation-design-attempts';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import { readRegisteredPresentationProductionPlan } from '../../src/platform/documents/presentation-production-plan-reader';
import { authoredFixtureDesign, autonomousOutline, splitTree } from '../fixtures/presentation-autonomous-design';
import type { PresentationArtDirectionRequest } from '../../src/application/presentation-art-direction';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function run(options: { repeat?: boolean; cancel?: boolean; cover?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-tree-production-')); roots.push(root);
  const projectId = toProjectId('autonomous-repair-project'), storage = new NodeProjectStorage(root);
  const controller = new AbortController();
  const writes: GenerateDocumentFileInput[] = [];
  const request = vi.fn(async (request: PresentationArtDirectionRequest) => {
    if (request.input.designFeedback && options.cancel) controller.abort();
    if (options.cover && request.input.designFeedback) {
      const previous = request.input.designFeedback.previousDesign;
      return { ...previous, pages: previous.pages.map(page => page.pageNumber !== 1 ? page : { ...page,
        designTree: { ...page.designTree!, root: { ...page.designTree!.root, padding: 0.03 } } }) };
    }
    return authoredFixtureDesign(autonomousOutline, splitTree(request.input.designFeedback ? 60 : 65));
  });
  let renderCount = 0;
  const runner = new DocumentGenerationRunner({ rootDirectory: root, projectId,
    generateTemporaryFile: async input => { writes.push(input); return generateTemporaryDocumentFile(input); },
    renderPreview: async () => ({ previewCount: 3, diagnostics: ++renderCount === 1 || options.repeat
      ? [{ code: 'text_overflow', severity: 'error', scope: options.cover ? 'page:1' : 'page:2', message: 'Synthetic overflow for bounded correction' }] : [] }) });
  const result = runner.run({ kind: 'ppt', title: autonomousOutline.title, outline: autonomousOutline,
    documentIR: buildDocumentIRFromOutline({ outline: autonomousOutline, operation: 'create' }),
    contentFingerprint: createHash('sha256').update(JSON.stringify(autonomousOutline)).digest('hex'), sourceDraftId: 'autonomous-draft', draftRevision: 1,
    executionId: 'execution-autonomous-repair', userRequirement: '模型自主决定页面设计，系统忠实执行', requestArtDirection: request, signal: controller.signal });
  return { root, projectId, storage, result, writes, request };
}
describe('autonomous correction preserves production publication gates', () => {
  it.each([false, true])('corrects only the target page (cover=%s), saves candidate receipts and registers exactly one Work', async cover => {
    const data = await run({ cover }); const result = await data.result;
    expect(result.execution.state).toBe('completed'); expect(data.request).toHaveBeenCalledTimes(2); expect(data.writes).toHaveLength(2);
    const initial = parsePresentationDesignAttempt(await data.storage.readJson(presentationAttemptPath(result.execution.id, 0)));
    const corrected = parsePresentationDesignAttempt(await data.storage.readJson(presentationAttemptPath(result.execution.id, 1)));
    expect(corrected.parentAttempt).toEqual({ attempt: 0, attemptHash: initial.attemptHash });
    expect(corrected.contentHash).toBe(initial.contentHash); expect(corrected.designHash).not.toBe(initial.designHash);
    expect(corrected.plan.snapshot.designExecution).toMatchObject({ status: 'passed', authoredPageCount: 3 });
    expect(corrected.targetPageIds).toHaveLength(1);
    if (cover) { expect(corrected.targetSystemPages).toEqual(['cover']); expect(corrected.targetSectionIds).toEqual([]); }
    const target = cover ? 1 : 2;
    initial.plan.layoutIR!.pages.filter(page => page.pageNumber !== target).forEach(page => {
      expect(corrected.plan.layoutIR!.pages.find(other => other.pageNumber === page.pageNumber)).toEqual(page);
    });
    const firstReceipt = await data.storage.readJson<PresentationCandidateQaReceipt>(presentationAttemptPath(result.execution.id, 0, true));
    const finalReceipt = await data.storage.readJson<PresentationCandidateQaReceipt>(presentationAttemptPath(result.execution.id, 1, true));
    expect(firstReceipt?.qaOutcome).toBe('failed'); expect(finalReceipt?.qaOutcome).toBe('passed');
    expect(finalReceipt?.artifactHash).toBe(result.file.checksumSha256);
    expect(await new JsonWorkRepository(data.storage, data.projectId).list(data.projectId)).toHaveLength(1);
    const reader = new RegisteredPresentationReader({ rootDirectory: data.root, projectId: data.projectId });
    const reread = await reader.read(result.work.id);
    expect(reread.pages).toHaveLength(3);
    if (result.file.locator.kind !== 'project') throw new Error('Expected project file');
    const bytes = await readFile(path.join(data.root, result.file.locator.relativePath));
    const registeredPlan = await readRegisteredPresentationProductionPlan({ rootDirectory: data.root, projectId: data.projectId, work: result.work, file: result.file, buffer: bytes });
    expect(registeredPlan?.attempt.attempt).toBe(1);
    expect(registeredPlan?.plan.designIR).toEqual(data.writes[1].designIR);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.file.checksumSha256);
  });
  it('refuses unchanged failed corrections and publishes no Work or file', async () => {
    const data = await run({ repeat: true });
    await expect(data.result).rejects.toMatchObject({ code: 'verification_failed' });
    // One actual correction, then an unchanged proposal is rejected rather than generating again.
    expect(data.request).toHaveBeenCalledTimes(3); expect(data.writes).toHaveLength(2);
    expect(await new JsonWorkRepository(data.storage, data.projectId).list(data.projectId)).toEqual([]);
    expect(await readdir(path.join(data.root, 'files', 'documents'))).toEqual([]);
    const receipt = await data.storage.readJson<PresentationCandidateQaReceipt>(presentationAttemptPath('execution-autonomous-repair', 1, true));
    expect(receipt?.qaOutcome).toBe('failed');
  });
  it('cancels during the correction request before any replacement file or registration', async () => {
    const data = await run({ cancel: true });
    await expect(data.result).rejects.toMatchObject({ code: 'cancelled' });
    expect(data.request).toHaveBeenCalledTimes(2); expect(data.writes).toHaveLength(1);
    expect(await new JsonWorkRepository(data.storage, data.projectId).list(data.projectId)).toEqual([]);
    expect(await readdir(path.join(data.root, 'files', 'documents'))).toEqual([]);
    expect(await data.storage.readJson<PresentationDesignAttempt>(presentationAttemptPath('execution-autonomous-repair', 1))).toBeUndefined();
  });
});
