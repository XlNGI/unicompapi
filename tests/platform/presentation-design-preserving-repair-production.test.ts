import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toProjectId, type FileReference } from '../../src/domain';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { generateTemporaryDocumentFile, type GenerateDocumentFileInput } from '../../src/platform/documents/office-document-generator';
import type { PresentationDesignCompilationSnapshot } from '../../src/platform/documents/presentation-render-plan-compiler';
import { JsonWorkRepository } from '../../src/platform/repositories';
import { NodeProjectStorage } from '../../src/platform/storage';
import { presentationAttemptPath, type PresentationDesignAttempt } from '../../src/platform/documents/presentation-design-attempts';
import { readRepairArtifact, repairProductionDesign, repairProductionFacts, repairProductionOutline } from '../fixtures/presentation-repair-production';
import { buildDocumentContentSnapshot, documentContentSnapshotToLegacyContent } from '../../src/domain/entities/document-content-snapshot';
import { PlatformDocumentDraftCompiler } from '../../src/platform/documents/document-generation-application-adapters';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const diagnostic = { code: 'text_overflow' as const, severity: 'error' as const, scope: 'page:2', message: 'synthetic structural overflow' };
const repair = (revision: number) => ({ kind: 'repair', diagnosisCodes: ['text_overflow'],
  operations: [{ operation: 'replace_page_layout', target: { sectionIndex: 0 }, value: 'comparison' }],
  preserve: [], reason: 'Separate the same content into comparison regions', expectedRevision: revision });

async function harness(options: { repeat?: boolean; legacy?: boolean; cancelRepair?: boolean; rejectPlan?: boolean; preserveExisting?: boolean;
  skipPlanAt?: number; mutateDuringQa?: boolean; canonical?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-preserve-design-'));
  roots.push(root);
  const projectId = toProjectId('preserve-design');
  const controller = new AbortController();
  const snapshots: PresentationDesignCompilationSnapshot[] = [];
  const buffers: Uint8Array[] = [];
  const writes: GenerateDocumentFileInput[] = [];
  const preparedRecords: PresentationDesignAttempt[] = [];
  const storage = new NodeProjectStorage(root);
  const executionId = 'execution-preserve-design';
  let existingFile: { file: FileReference; bytes: Uint8Array } | undefined;
  if (options.preserveExisting) {
    const baseline = await new DocumentGenerationRunner({ rootDirectory: root, projectId }).run({ kind: 'ppt',
      outline: repairProductionOutline, title: repairProductionOutline.title, contentFingerprint: 'b'.repeat(64),
      draftRevision: 1, sourceDraftId: 'prior-delivered-document' });
    if (baseline.file.locator.kind !== 'project') throw new Error('Expected a project file');
    existingFile = { file: baseline.file, bytes: await readFile(path.join(root, baseline.file.locator.relativePath)) };
  }
  let renders = 0;
  const planner = vi.fn(async () => repair(3));
  const runner = new DocumentGenerationRunner({ rootDirectory: root, projectId,
    generateTemporaryFile: async input => {
      writes.push(input);
      const candidate = await generateTemporaryDocumentFile({ ...input,
        onPlanPrepared: options.skipPlanAt === writes.length - 1 ? undefined : async plan => {
          if (options.rejectPlan) throw new Error('synthetic_plan_persistence_failed');
          await input.onPlanPrepared?.(plan);
          const record = await storage.readJson<PresentationDesignAttempt>(presentationAttemptPath(executionId, writes.length - 1));
          if (!record) throw new Error('The plan must be durable before producing artifact bytes');
          preparedRecords.push(record);
        },
        onDesignCompiled: async snapshot => { snapshots.push(snapshot); await input.onDesignCompiled?.(snapshot); }
      });
      buffers.push(await readFile(candidate.temporaryPath));
      if (options.cancelRepair && writes.length === 2) controller.abort();
      return candidate;
    },
    renderPreview: async temporaryPath => {
      if (options.mutateDuringQa) {
        const bytes = await readFile(temporaryPath);
        // Change a ZIP central-directory timestamp while retaining valid bytes and size.
        const centralHeader = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        if (centralHeader < 0) throw new Error('Expected a real PPTX ZIP directory');
        bytes[centralHeader + 12] ^= 1;
        await writeFile(temporaryPath, bytes);
      }
      return { previewCount: 4, diagnostics: ++renders === 1 && !options.mutateDuringQa || options.repeat ? [diagnostic] : [] };
    }
  });
  const original = buildDocumentContentSnapshot({ outline: repairProductionOutline, identityScope: 'doc-existing-host-snapshot' });
  const canonical = buildDocumentContentSnapshot({ outline: repairProductionOutline, previousSnapshot: {
    ...original, nextIdentity: original.nextIdentity + 1,
    issuedIds: [...original.issuedIds, `${original.identityScope}:a${original.nextIdentity}`],
    sections: original.sections.map((section, index) => ({ ...section,
      sourceRefs: [`source-section-${index}`], preserve: [`keep-section-${index}`],
      blocks: section.blocks.map((block, blockIndex) => ({ ...block, sourceRefs: [`source-block-${index}-${blockIndex}`], preserve: ['keep-block'] })) }))
  } });
  const result = runner.run({ kind: 'ppt', title: repairProductionOutline.title, outline: repairProductionOutline, executionId,
    userRequirement: 'Keep all facts; adjust only the overflowing page layout',
    contentFingerprint: createHash('sha256').update(JSON.stringify(repairProductionOutline)).digest('hex'),
    draftRevision: 3, sourceDraftId: 'draft-preserve-design', requestLlmRepair: planner, signal: controller.signal,
    ...(options.canonical ? { documentIR: { operation: 'create' as const, attachmentRefs: [], canonicalContent: canonical,
      content: documentContentSnapshotToLegacyContent(canonical) } } : {}),
    ...(!options.legacy ? { requestArtDirection: async () => repairProductionDesign() } : {})
  });
  return { root, projectId, result, snapshots, buffers, writes, planner, controller, preparedRecords, storage, executionId, existingFile, canonical };
}

describe('production design remains authoritative through a forced layout repair', () => {
  it('recompiles the same facts and references with changed target geometry, then publishes one Work', async () => {
    const data = await harness();
    const result = await data.result;
    expect(result.execution.state).toBe('completed');
    expect(data.planner).toHaveBeenCalledTimes(1);
    expect(data.writes).toHaveLength(2);
    expect(data.snapshots.map(snapshot => snapshot.designPath), JSON.stringify(data.snapshots.map(snapshot => ({ fallbackReason: snapshot.fallbackReason, diagnostics: snapshot.diagnostics })))).toEqual(['design-aware', 'design-aware']);
    expect(data.writes.every(write => write.designIR !== undefined)).toBe(true);
    const [before, after] = await Promise.all(data.buffers.map(readRepairArtifact));
    for (const fact of repairProductionFacts) {
      expect(before.text).toContain(fact);
      expect(after.text).toContain(fact);
    }
    expect(before.slides[1].shapes.map(shape => shape.geometry)).not.toEqual(after.slides[1].shapes.map(shape => shape.geometry));
    for (const index of [0, 2, 3]) expect(after.slides[index].xml).toBe(before.slides[index].xml);
    expect(data.writes[1].designIR?.pages.map(page => page.contentRoles)).toEqual(data.writes[0].designIR?.pages.map(page => page.contentRoles));
    expect(data.writes[1].designIR?.pages.map(page => page.hierarchy)).toEqual(data.writes[0].designIR?.pages.map(page => page.hierarchy));
    const [initialPlan, repairedPlan] = data.preparedRecords;
    expect(repairedPlan).toMatchObject({ contentHash: initialPlan.contentHash, contentVersion: initialPlan.contentVersion,
      designVersion: 2, layoutVersion: 2, renderVersion: 2,
      parentAttempt: { attempt: 0, attemptHash: initialPlan.attemptHash } });
    expect(repairedPlan.designHash).not.toBe(initialPlan.designHash);
    expect(repairedPlan.layoutHash).not.toBe(initialPlan.layoutHash);
    expect(repairedPlan.renderHash).not.toBe(initialPlan.renderHash);
    expect(repairedPlan.plan.layoutIR!.pages.map(page => page.pageId)).toEqual(initialPlan.plan.layoutIR!.pages.map(page => page.pageId));
    expect(repairedPlan.targetPageIds).toEqual([initialPlan.plan.layoutIR!.pages[1].pageId]);
    expect(await data.storage.readJson(presentationAttemptPath(data.executionId, 0, true))).toMatchObject({ kind: 'candidate_qa_receipt', qaOutcome: 'failed', publication: 'not_authorized', diagnosisCodes: ['text_overflow'] });
    expect(await data.storage.readJson(presentationAttemptPath(data.executionId, 1, true))).toMatchObject({ qaOutcome: 'passed', publication: 'not_authorized' });
    expect(await new JsonWorkRepository(new NodeProjectStorage(data.root), data.projectId).list(data.projectId)).toHaveLength(1);
  });

  it('keeps the design on repeated diagnostics and publishes neither failed candidate', async () => {
    const data = await harness({ repeat: true });
    await expect(data.result).rejects.toMatchObject({ code: 'verification_failed' });
    expect(data.planner).toHaveBeenCalledTimes(1);
    expect(data.snapshots.map(snapshot => snapshot.designPath)).toEqual(['design-aware', 'design-aware']);
    expect(await readdir(path.join(data.root, 'files', 'documents'))).toEqual([]);
    expect(await new JsonWorkRepository(new NodeProjectStorage(data.root), data.projectId).list(data.projectId)).toEqual([]);
  });

  it('closes a cancelled repair candidate without publishing it', async () => {
    const data = await harness({ cancelRepair: true });
    await expect(data.result).rejects.toMatchObject({ code: 'cancelled' });
    expect(data.planner).toHaveBeenCalledTimes(1);
    expect(data.writes).toHaveLength(2);
    expect(data.snapshots.map(snapshot => snapshot.designPath)).toEqual(['design-aware', 'design-aware']);
    expect(await readdir(path.join(data.root, 'files', 'documents'))).toEqual([]);
  });

  it('records an explicit legacy fallback reason for every attempt when the original design is unavailable', async () => {
    const data = await harness({ legacy: true });
    await data.result;
    expect(data.writes).toHaveLength(2);
    expect(data.snapshots.map(snapshot => [snapshot.designPath, snapshot.fallbackReason])).toEqual([
      ['legacy-fallback', 'missing_design_ir'], ['legacy-fallback', 'missing_design_ir']
    ]);
    expect(data.preparedRecords).toHaveLength(2);
    expect(data.preparedRecords[1].plan.contentSnapshot.sections.map(section => section.sectionId)).toEqual(
      data.preparedRecords[0].plan.contentSnapshot.sections.map(section => section.sectionId));
    expect(data.preparedRecords[1].plan.contentSnapshot.sections.map(section => section.blocks)).toEqual(
      data.preparedRecords[0].plan.contentSnapshot.sections.map(section => section.blocks));
  });

  it('blocks artifact writing and Work publication when the mandatory private plan callback fails', async () => {
    const data = await harness({ rejectPlan: true });
    await expect(data.result).rejects.toThrow('synthetic_plan_persistence_failed');
    expect(data.buffers).toEqual([]);
    expect(data.planner).not.toHaveBeenCalled();
    expect(await readdir(path.join(data.root, 'files', 'documents'))).toEqual([]);
    expect(await new JsonWorkRepository(data.storage, data.projectId).list(data.projectId)).toEqual([]);
  });

  it.each([0, 1])('refuses publication and cleans both candidates when writer ignores the plan callback at attempt %s', async skipPlanAt => {
    const data = await harness({ skipPlanAt });
    await expect(data.result).rejects.toMatchObject({ code: 'verification_failed' });
    expect(data.preparedRecords).toHaveLength(skipPlanAt);
    expect(data.planner).toHaveBeenCalledTimes(skipPlanAt);
    expect(await readdir(path.join(data.root, 'files', 'documents'))).toEqual([]);
    expect(await new JsonWorkRepository(data.storage, data.projectId).list(data.projectId)).toEqual([]);
  });

  it('refuses publication when the candidate file changes during QA after its receipt Hash was fixed', async () => {
    const data = await harness({ mutateDuringQa: true });
    await expect(data.result).rejects.toMatchObject({ code: 'verification_failed', message: 'The file no longer matches the candidate that passed QA' });
    expect(await data.storage.readJson(presentationAttemptPath(data.executionId, 0, true))).toMatchObject({ qaOutcome: 'passed', publication: 'not_authorized' });
    expect(await readdir(path.join(data.root, 'files', 'documents'))).toEqual([]);
    expect(await new JsonWorkRepository(data.storage, data.projectId).list(data.projectId)).toEqual([]);
  });

  it('retains the admitted canonical revision, stable identities and nested provenance through production and repair', async () => {
    const data = await harness({ canonical: true });
    await data.result;
    expect(data.preparedRecords.map(record => record.plan.contentSnapshot)).toEqual([data.canonical, data.canonical]);
    expect(data.writes.map(write => write.contentSnapshot)).toEqual([data.canonical, data.canonical]);
  });

  it('assigns separate Host identity scopes when compiling two new documents with identical facts', () => {
    const compiler = new PlatformDocumentDraftCompiler();
    const first = compiler.compileIR({ outline: repairProductionOutline, operation: 'create' }).canonicalContent!;
    const second = compiler.compileIR({ outline: repairProductionOutline, operation: 'create' }).canonicalContent!;
    expect(first.identityScope).not.toBe(second.identityScope);
    expect(first.sections[0].sectionId).not.toBe(second.sections[0].sectionId);
    expect(first.title).toBe(second.title);
    const admitted = { outline: repairProductionOutline, operation: 'create' as const, identitySeed: 'host-conversation-message-one' };
    expect(compiler.compileIR(admitted)).toEqual(compiler.compileIR(admitted));
    expect(compiler.compileIR({ ...admitted, identitySeed: 'host-conversation-message-two' }).canonicalContent!.identityScope)
      .not.toBe(compiler.compileIR(admitted).canonicalContent!.identityScope);
  });

  it('preserves the already delivered file and Work when the new design repair fails', async () => {
    const data = await harness({ repeat: true, preserveExisting: true });
    await expect(data.result).rejects.toMatchObject({ code: 'verification_failed' });
    const previous = data.existingFile!;
    if (previous.file.locator.kind !== 'project') throw new Error('Expected a project file');
    expect(await readFile(path.join(data.root, previous.file.locator.relativePath))).toEqual(previous.bytes);
    expect(await readdir(path.join(data.root, 'files', 'documents'))).toHaveLength(1);
    const works = await new JsonWorkRepository(data.storage, data.projectId).list(data.projectId);
    expect(works).toHaveLength(1);
    expect(works[0].fileId).toBe(previous.file.id);
    expect(data.preparedRecords.map(record => record.plan.snapshot.designPath)).toEqual(['design-aware', 'design-aware']);
  });
});
