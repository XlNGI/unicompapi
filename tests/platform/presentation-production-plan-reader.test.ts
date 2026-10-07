import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toProjectId, toWorkId } from '../../src/domain';
import { canonicalizeLayoutJson } from '../../src/domain/entities/presentation-layout-ir';
import { NodeProjectStorage, projectStoragePaths, toProjectRelativePath } from '../../src/platform/storage';
import { JsonExecutionRepository, JsonFileReferenceRepository, JsonTaskRepository, JsonWorkRepository } from '../../src/platform/repositories/json-repositories';
import { DocumentGenerationRunner } from '../../src/platform/documents/document-generation-runner';
import { RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import { persistPreparedPresentationAttempt, persistPresentationAttemptReceipt, presentationAttemptPath, type PresentationDesignAttempt } from '../../src/platform/documents/presentation-design-attempts';
import { fixedDesignDirections, fixedDesignOutline } from '../fixtures/presentation-design-directions';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalizeLayoutJson(value))).digest('hex');
const safeFailure = { code: 'revision_scope_violation' };

async function fixture() {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-private-plan-read-'));
  roots.push(rootDirectory);
  const projectId = toProjectId('private-plan-readback');
  const storage = new NodeProjectStorage(rootDirectory);
  const result = await new DocumentGenerationRunner({ rootDirectory, projectId }).run({ kind: 'ppt',
    outline: fixedDesignOutline, title: fixedDesignOutline.title, contentFingerprint: digest(fixedDesignOutline),
    sourceDraftId: 'registered-plan-draft', draftRevision: 2,
    requestArtDirection: async () => fixedDesignDirections().editorial });
  const reader = new RegisteredPresentationReader({ rootDirectory, projectId });
  const attemptPath = presentationAttemptPath(result.execution.id, 0);
  const receiptPath = presentationAttemptPath(result.execution.id, 0, true);
  const attempt = await storage.readJson<PresentationDesignAttempt>(attemptPath);
  if (!attempt || result.file.locator.kind !== 'project') throw new Error('Expected a durable registered fixture');
  return { rootDirectory, projectId, storage, result, reader, attempt, attemptPath, receiptPath,
    artifactPath: path.join(rootDirectory, result.file.locator.relativePath) };
}

describe('private production plan readback for a verified registered PPT', () => {
  it('returns the exact durable content and layout identities without altering the registered artifact', async () => {
    const data = await fixture();
    const before = await readFile(data.artifactPath);
    const read = await data.reader.readWithProductionPlan(data.result.work.id);
    expect(read.productionPlan?.attempt).toEqual(data.attempt);
    expect(read.productionPlan?.plan).toEqual(data.attempt.plan);
    expect(read.productionPlan?.plan.layoutIR?.identity.layoutDigest).toBe(data.attempt.layoutHash);
    expect(read.productionPlan?.plan.contentSnapshot.sections[0].sectionId).toBe(data.attempt.plan.contentSnapshot.sections[0].sectionId);
    expect(await readFile(data.artifactPath)).toEqual(before);
    expect(await new JsonWorkRepository(data.storage, data.projectId).list(data.projectId)).toHaveLength(1);
  });

  it('keeps ordinary physical reads independent of private plan parsing', async () => {
    const data = await fixture();
    const readJson = vi.spyOn(NodeProjectStorage.prototype, 'readJson');
    const read = await data.reader.read(data.result.work.id);
    expect(read.pages).toHaveLength(3);
    expect(readJson.mock.calls.some(([relative]) => relative.includes('document-design-attempts'))).toBe(false);
    await data.reader.readWithProductionPlan(data.result.work.id);
    expect(readJson.mock.calls.some(([relative]) => relative.includes('document-design-attempts'))).toBe(true);
  });

  it('supports registered legacy files with no private plan and preserves the observed pages', async () => {
    const data = await fixture();
    await data.storage.remove(data.attemptPath);
    await data.storage.remove(data.receiptPath);
    const read = await data.reader.readWithProductionPlan(data.result.work.id);
    expect(read.productionPlan).toBeUndefined();
    expect(read.pages).toHaveLength(3);
  });

  it('does not let a passed candidate receipt substitute for a registered Work', async () => {
    const data = await fixture();
    await expect(data.reader.readWithProductionPlan(toWorkId('unregistered-candidate'))).rejects.toMatchObject(safeFailure);
    expect(await new JsonWorkRepository(data.storage, data.projectId).list(data.projectId)).toHaveLength(1);
  });

  it('rejects ambiguous passed candidates even when both receipts claim the registered artifact hash', async () => {
    const data = await fixture();
    const next = await persistPreparedPresentationAttempt({ storage: data.storage, executionId: data.result.execution.id,
      sourceDraftId: data.attempt.sourceDraftId, draftRevision: data.attempt.draftRevision, attempt: 1,
      prepared: data.attempt.plan, previousAttempt: data.attempt, now: new Date().toISOString() });
    await persistPresentationAttemptReceipt({ storage: data.storage, attempt: next, artifactHash: data.result.file.checksumSha256,
      outcome: 'passed', now: new Date().toISOString() });
    await expect(data.reader.readWithProductionPlan(data.result.work.id)).rejects.toMatchObject(safeFailure);
  });

  it('rejects a missing parent attempt instead of treating its descendant as a legacy file', async () => {
    const data = await fixture();
    const next = await persistPreparedPresentationAttempt({ storage: data.storage, executionId: data.result.execution.id,
      sourceDraftId: data.attempt.sourceDraftId, draftRevision: data.attempt.draftRevision, attempt: 1,
      prepared: data.attempt.plan, previousAttempt: data.attempt, now: new Date().toISOString() });
    await persistPresentationAttemptReceipt({ storage: data.storage, attempt: next, artifactHash: data.result.file.checksumSha256,
      outcome: 'passed', now: new Date().toISOString() });
    await data.storage.remove(data.attemptPath);
    await data.storage.remove(data.receiptPath);
    await expect(data.reader.readWithProductionPlan(data.result.work.id)).rejects.toMatchObject(safeFailure);
  });

  it('validates the entire parent chain and selects only the unique passed attempt for the actual file hash', async () => {
    const data = await fixture();
    const receipt = await data.storage.readJson<Record<string, unknown>>(data.receiptPath);
    await data.storage.writeJsonAtomically(data.receiptPath, { ...receipt, qaOutcome: 'failed' });
    const next = await persistPreparedPresentationAttempt({ storage: data.storage, executionId: data.result.execution.id,
      sourceDraftId: data.attempt.sourceDraftId, draftRevision: data.attempt.draftRevision, attempt: 1,
      prepared: data.attempt.plan, previousAttempt: data.attempt, now: new Date().toISOString() });
    await persistPresentationAttemptReceipt({ storage: data.storage, attempt: next, artifactHash: data.result.file.checksumSha256,
      outcome: 'passed', now: new Date().toISOString() });
    expect((await data.reader.readWithProductionPlan(data.result.work.id)).productionPlan?.attempt.attempt).toBe(1);
    const corrupt = { ...next, parentAttempt: { attempt: 0, attemptHash: 'a'.repeat(64) } };
    const body = Object.fromEntries(Object.entries(corrupt).filter(([key]) => key !== 'attemptHash'));
    await data.storage.writeJsonAtomically(presentationAttemptPath(data.result.execution.id, 1), { ...body, attemptHash: digest(body) });
    await expect(data.reader.readWithProductionPlan(data.result.work.id)).rejects.toMatchObject(safeFailure);
  });

  it.each(['contentHash', 'designHash', 'layoutHash', 'renderHash', 'attemptHash'] as const)(
    'rejects an altered %s even when the artifact bytes remain intact', async name => {
      const data = await fixture();
      await data.storage.writeJsonAtomically(data.attemptPath, { ...data.attempt, [name]: 'a'.repeat(64) });
      await expect(data.reader.readWithProductionPlan(data.result.work.id)).rejects.toMatchObject(safeFailure);
      expect((await data.reader.read(data.result.work.id)).file.checksumSha256).toBe(data.result.file.checksumSha256);
    });

  it.each(['wrong_artifact', 'publication_authorized', 'qa_failed', 'unknown_field'])(
    'rejects a receipt with %s without treating QA evidence as publication authority', async change => {
      const data = await fixture();
      const receipt = await data.storage.readJson<Record<string, unknown>>(data.receiptPath);
      const changes = change === 'wrong_artifact' ? { artifactHash: 'b'.repeat(64) }
        : change === 'publication_authorized' ? { publication: 'authorized' }
          : change === 'qa_failed' ? { qaOutcome: 'failed' } : { outputPath: data.artifactPath };
      await data.storage.writeJsonAtomically(data.receiptPath, { ...receipt, ...changes });
      await expect(data.reader.readWithProductionPlan(data.result.work.id)).rejects.toMatchObject(safeFailure);
    });

  it('rejects an execution alias even with a recomputed attempt hash and valid file bytes', async () => {
    const data = await fixture();
    const body = Object.fromEntries(Object.entries({ ...data.attempt, executionId: 'unrelated-execution' }).filter(([key]) => key !== 'attemptHash'));
    const replacement = { ...body, attemptHash: digest(body) };
    await data.storage.writeJsonAtomically(data.attemptPath, replacement);
    const receipt = await data.storage.readJson<Record<string, unknown>>(data.receiptPath);
    await data.storage.writeJsonAtomically(data.receiptPath, { ...receipt, attemptHash: replacement.attemptHash });
    await expect(data.reader.readWithProductionPlan(data.result.work.id)).rejects.toMatchObject(safeFailure);
  });

  it.each(['attempt', 'receipt'] as const)('does not trust a %s recovered only from backup', async name => {
    const data = await fixture();
    const relative = name === 'attempt' ? data.attemptPath : data.receiptPath;
    const value = await data.storage.readJson(relative);
    await data.storage.writeJsonAtomically(toProjectRelativePath(`${relative}.bak`), value);
    await data.storage.remove(relative);
    await expect(data.reader.readWithProductionPlan(data.result.work.id)).rejects.toMatchObject(safeFailure);
  });

  it('rejects malformed primary JSON even when its backup is valid', async () => {
    const data = await fixture();
    await data.storage.writeJsonAtomically(toProjectRelativePath(`${data.attemptPath}.bak`), data.attempt);
    await writeFile(path.join(data.rootDirectory, data.attemptPath), '{corrupt');
    await expect(data.reader.readWithProductionPlan(data.result.work.id)).rejects.toMatchObject(safeFailure);
  });

  it('requires primary Work and File identity before exposing a private plan', async () => {
    const data = await fixture();
    const works = await data.storage.readJson(projectStoragePaths.entities.works);
    await data.storage.writeJsonAtomically(toProjectRelativePath(`${projectStoragePaths.entities.works}.bak`), works);
    await data.storage.remove(projectStoragePaths.entities.works);
    expect((await data.reader.read(data.result.work.id)).work.id).toBe(data.result.work.id);
    await expect(data.reader.readWithProductionPlan(data.result.work.id)).rejects.toMatchObject(safeFailure);
  });

  it.each(['task', 'execution'] as const)('requires the registered %s linkage to match the plan', async entity => {
    const data = await fixture();
    if (entity === 'task') {
      await new JsonTaskRepository(data.storage, data.projectId).save({ ...data.result.task, sourceDraftId: 'other-draft' as typeof data.result.task.sourceDraftId });
    } else {
      await new JsonExecutionRepository(data.storage).save({ ...data.result.execution, workId: toWorkId('unrelated-work') });
    }
    await expect(data.reader.readWithProductionPlan(data.result.work.id)).rejects.toMatchObject(safeFailure);
  });

  it('verifies the actual local artifact rather than trusting a matching candidate receipt', async () => {
    const data = await fixture();
    await writeFile(data.artifactPath, 'different bytes');
    await expect(data.reader.readWithProductionPlan(data.result.work.id)).rejects.toMatchObject(safeFailure);
    expect((await new JsonFileReferenceRepository(data.storage, data.projectId).get(data.result.file.id))?.checksumSha256)
      .toBe(data.result.file.checksumSha256);
  });
});
