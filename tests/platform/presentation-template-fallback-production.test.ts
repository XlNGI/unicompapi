import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toProjectId } from '../../src/domain';
import { buildDocumentIRFromOutline } from '../../src/domain/entities/document-agent';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { generateTemporaryDocumentFile, type GenerateDocumentFileInput } from '../../src/platform/documents/office-document-generator';
import { presentationAttemptPath, parsePresentationDesignAttempt, type PresentationCandidateQaReceipt } from '../../src/platform/documents/presentation-design-attempts';
import { NodeProjectStorage } from '../../src/platform/storage';
import { JsonWorkRepository } from '../../src/platform/repositories';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import { readRegisteredPresentationProductionPlan } from '../../src/platform/documents/presentation-production-plan-reader';
import { canFallbackFromPresentationQa, presentationPlanningFallbackReason } from '../../src/platform/documents/presentation-template-fallback';
import type { DocumentGenerationProgressEvent } from '../../src/application/document-generation-service';
import { authoredFixtureDesign, autonomousOutline, splitTree } from '../fixtures/presentation-autonomous-design';
import type { PresentationArtDirectionRequest } from '../../src/application/presentation-art-direction';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
type Mode = 'valid' | 'timeout' | 'hang' | 'invalid' | 'missing-tree' | 'unfit' | 'render' | 'bad-template' | 'cancel' | 'scope' | 'source-conflict';
async function harness(mode: Mode) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-template-backup-')); roots.push(root);
  const projectId = toProjectId('template-backup-project'), storage = new NodeProjectStorage(root), controller = new AbortController();
  const writes: GenerateDocumentFileInput[] = [], events: DocumentGenerationProgressEvent[] = [];
  const request = vi.fn(async (request: PresentationArtDirectionRequest) => {
    if (mode === 'timeout') throw new Error('classification_timeout');
    if (mode === 'hang') return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('classification_timeout')), { once: true }));
    if (mode === 'invalid') return '{truncated';
    const design = authoredFixtureDesign(autonomousOutline, splitTree(65 - (request.input.designFeedback ? 5 * requests++ : 0)));
    if (mode === 'missing-tree') return { ...design, pages: design.pages.map(({ designTree: _tree, ...page }) => page) };
    if (mode === 'unfit') return { ...design, pages: design.pages.map(page => page.pageNumber !== 2 ? page : { ...page,
      designTree: { schemaVersion: 1, root: { nodeId: 'tight', type: 'overlay', children: [{ ...page.designTree!.root, anchor: 'center', widthFraction: 0.05, heightFraction: 0.05 }] } } }) };
    if (request.input.designFeedback && mode === 'scope') return { ...design, globalDesign: { ...design.globalDesign, visualTone: 'bold' } };
    return design;
  });
  let requests = 1, renders = 0;
  const runner = new DocumentGenerationRunner({ rootDirectory: root, projectId,
    generateTemporaryFile: async input => {
      writes.push(input);
      if (mode === 'source-conflict') throw new TypeError('content_snapshot_conflict');
      return generateTemporaryDocumentFile(input);
    },
    renderPreview: async () => {
      renders++;
      if (mode === 'cancel') controller.abort();
      const failure = ['render', 'scope'].includes(mode) && writes.at(-1)!.designIR !== undefined || mode === 'bad-template';
      return { previewCount: 3, diagnostics: failure ? [{ code: 'text_overflow', severity: 'error', scope: 'page:2', message: 'Synthetic overflow' }] : [] };
    }
  });
  const input = { kind: 'ppt' as const, title: autonomousOutline.title, outline: autonomousOutline,
    documentIR: buildDocumentIRFromOutline({ outline: autonomousOutline, operation: 'create' }), sourceDraftId: 'template-backup-draft', draftRevision: 1,
    contentFingerprint: createHash('sha256').update(JSON.stringify(autonomousOutline)).digest('hex'), userRequirement: '模型自主设计，必要时用基础模板兜底',
    requestArtDirection: request, ...(mode === 'hang' ? { artDirectionTimeoutMs: 50 } : {}), signal: controller.signal,
    onProgress: async (event: DocumentGenerationProgressEvent) => { events.push(event); } };
  return { root, projectId, storage, runner, input, request, writes, events, result: runner.run(input), renderCount: () => renders };
}
describe('model design first with one audited local template fallback', () => {
  it('executes the model design without touching the template path', async () => {
    const data = await harness('valid'), result = await data.result;
    expect(result.presentationDesign?.path).toBe('design-aware'); expect(data.request).toHaveBeenCalledTimes(1); expect(data.writes).toHaveLength(1);
    expect(data.writes[0].designFallbackReason).toBeUndefined();
  });
  it.each(['timeout', 'hang', 'invalid', 'missing-tree', 'unfit'] as const)('falls back for %s while retaining all content and publishing one verified Work', async mode => {
    const data = await harness(mode), result = await data.result;
    expect(result.presentationDesign?.path).toBe('legacy-fallback'); expect(data.writes).toHaveLength(1); expect(data.writes[0].designIR).toBeUndefined();
    expect(data.request).toHaveBeenCalledTimes(['unfit', 'invalid', 'missing-tree'].includes(mode) ? 3 : 1);
    if (mode === 'hang') expect(data.request.mock.calls[0][0].signal.aborted).toBe(true);
    const attempt = parsePresentationDesignAttempt(await data.storage.readJson(presentationAttemptPath(result.execution.id, 0)));
    expect(attempt.plan.snapshot.designPath).toBe('legacy-fallback'); expect(attempt.plan.designIR).toBeUndefined();
    expect(attempt.plan.contentSnapshot.title).toBe(autonomousOutline.title);
    const physical = await new RegisteredPresentationReader({ rootDirectory: data.root, projectId: data.projectId }).read(result.work.id);
    const text = JSON.stringify(physical.pages);
    for (const block of autonomousOutline.sections[0].blocks) if (block.type === 'paragraph') expect(text).toContain(block.text);
    const plan = await readRegisteredPresentationProductionPlan({ rootDirectory: data.root, projectId: data.projectId, work: physical.work, file: physical.file, buffer: physical.buffer });
    expect(plan?.plan.snapshot.fallbackReason).toBe(result.presentationDesign!.fallbackReason);
    expect(await new JsonWorkRepository(data.storage, data.projectId).list(data.projectId)).toHaveLength(1);
    const replay = await data.runner.run(data.input);
    expect(replay.work.id).toBe(result.work.id); expect(replay.presentationDesign).toEqual(result.presentationDesign); expect(data.writes).toHaveLength(1);
    expect(data.events.some(event => event.facts?.designPath === 'legacy-fallback')).toBe(true);
  });
  it('keeps all three failed design candidates and receipts, then verifies one template candidate without another model call', async () => {
    const data = await harness('render'), result = await data.result;
    expect(result.presentationDesign).toEqual({ path: 'legacy-fallback', fallbackReason: 'design_render_failed' });
    expect(data.request).toHaveBeenCalledTimes(3); expect(data.writes).toHaveLength(4); expect(data.renderCount()).toBe(4);
    const attempts = [];
    for (let i = 0; i <= 3; i++) {
      const attempt = parsePresentationDesignAttempt(await data.storage.readJson(presentationAttemptPath(result.execution.id, i))); attempts.push(attempt);
      const receipt = await data.storage.readJson<PresentationCandidateQaReceipt>(presentationAttemptPath(result.execution.id, i, true));
      expect(receipt?.qaOutcome).toBe(i === 3 ? 'passed' : 'failed');
      if (i) expect(attempt.parentAttempt?.attemptHash).toBe(attempts[i - 1].attemptHash);
    }
    expect(new Set(attempts.map(attempt => attempt.contentHash)).size).toBe(1);
    expect(attempts[3].plan.designIR).toBeUndefined(); expect(attempts[3].plan.snapshot.designExecution).toBeUndefined();
    const physical = await new RegisteredPresentationReader({ rootDirectory: data.root, projectId: data.projectId }).read(result.work.id);
    const persisted = await readRegisteredPresentationProductionPlan({ rootDirectory: data.root, projectId: data.projectId, work: physical.work, file: physical.file, buffer: physical.buffer });
    expect(persisted?.attempt.attempt).toBe(3);
    expect(await new JsonWorkRepository(data.storage, data.projectId).list(data.projectId)).toHaveLength(1);
  });
  it.each(['cancel', 'scope', 'source-conflict', 'bad-template'] as const)('does not use fallback to bypass %s or publish an unverified file', async mode => {
    const data = await harness(mode);
    await expect(data.result).rejects.toMatchObject({ code: mode === 'cancel' ? 'cancelled' : mode === 'scope' ? 'revision_scope_violation' : 'verification_failed' });
    expect(await new JsonWorkRepository(data.storage, data.projectId).list(data.projectId)).toEqual([]);
    expect(await readdir(path.join(data.root, 'files', 'documents'))).toEqual([]);
  });
  it('does not whitelist permission, budget, identity or scope failures as presentation failures', () => {
    for (const code of ['cancelled', 'execution_budget_exceeded', 'authorization_revoked', 'content_snapshot_conflict', 'design_repair_scope_violation', 'design_attempt_integrity_mismatch']) {
      expect(presentationPlanningFallbackReason([{ code }])).toBeUndefined();
    }
    expect(canFallbackFromPresentationQa([{ code: 'page_count_mismatch', severity: 'error' }])).toBe(false);
  });
});
