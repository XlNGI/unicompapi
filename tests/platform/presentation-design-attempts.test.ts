import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDocumentContentSnapshot } from '../../src/domain/entities/document-content-snapshot';
import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import { buildFallbackPresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import { NodeProjectStorage } from '../../src/platform/storage';
import { persistPreparedPresentationAttempt, persistPresentationAttemptReceipt, presentationAttemptPath } from '../../src/platform/documents/presentation-design-attempts';
import { compilePresentationRenderPlan, buildPresentationDesignSnapshot } from '../../src/platform/documents/presentation-render-plan-compiler';
import { derivePresentationRenderPlanFromLayoutIR } from '../../src/platform/documents/presentation-layout-ir-adapter';
import { resolvePresentationTemplate } from '../../src/platform/documents/presentation-template';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const outline: DocumentOutline = { kind: 'ppt', title: 'Evidence', sections: [{ heading: 'Pilot facts', level: 1,
  blocks: [{ type: 'bullets', items: ['Retention 92%', 'Throughput +35%'] }] }] };

function prepared() {
  const contentSnapshot = buildDocumentContentSnapshot({ outline, identityScope: 'host-draft-evidence' });
  const designIR = buildFallbackPresentationDesignIR(outline);
  const compiled = compilePresentationRenderPlan(outline, designIR, resolvePresentationTemplate('business_minimal').tokens, { contentSnapshot });
  const layoutIR = compiled.layoutIR!;
  return { contentSnapshot, outline, designIR, layoutIR, renderPlan: derivePresentationRenderPlanFromLayoutIR(layoutIR, contentSnapshot),
    snapshot: buildPresentationDesignSnapshot(compiled, { requested: true, legacyPageCount: 3, designPath: 'design-aware' }) };
}

async function context() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-design-attempt-'));
  roots.push(root);
  return { root, storage: new NodeProjectStorage(root), executionId: 'execution-host-owned', sourceDraftId: 'draft-evidence',
    draftRevision: 1, attempt: 0, now: '2026-10-06T04:00:00.000Z', prepared: prepared() };
}

describe('immutable private design attempt evidence', () => {
  it('persists matching content/design/layout/render identities, stable target pages and parent attempt', async () => {
    const input = await context();
    const first = await persistPreparedPresentationAttempt(input);
    const second = await persistPreparedPresentationAttempt({ ...input, attempt: 1, previousAttempt: first,
      targetSectionIds: [input.prepared.contentSnapshot.sections[0].sectionId], diagnosisCodes: ['text_overflow'] });
    expect(first).toMatchObject({ attempt: 0, contentVersion: 1, designVersion: 1, layoutVersion: 1, renderVersion: 1 });
    expect(second).toMatchObject({ attempt: 1, contentVersion: 1, designVersion: 2, layoutVersion: 2, renderVersion: 2,
      contentHash: first.contentHash, parentAttempt: { attempt: 0, attemptHash: first.attemptHash } });
    expect(second.targetPageIds).toEqual([input.prepared.layoutIR.pages[1].pageId]);
    expect(await input.storage.readJson(presentationAttemptPath(input.executionId, 1))).toEqual(second);
    await persistPresentationAttemptReceipt({ storage: input.storage, attempt: first, outcome: 'failed', artifactHash: 'a'.repeat(64),
      diagnosisCodes: ['text_overflow'], now: input.now });
    expect(await input.storage.readJson(presentationAttemptPath(input.executionId, 0))).toEqual(first);
    expect(await input.storage.readJson(presentationAttemptPath(input.executionId, 0, true))).toMatchObject({
      kind: 'candidate_qa_receipt', attemptHash: first.attemptHash, qaOutcome: 'failed', publication: 'not_authorized', artifactHash: 'a'.repeat(64), diagnosisCodes: ['text_overflow']
    });
  });

  it('rejects stale content, altered render geometry, absent parent and invalid targets before a durable candidate is admitted', async () => {
    const input = await context();
    await expect(persistPreparedPresentationAttempt({ ...input, prepared: { ...input.prepared,
      outline: { ...outline, title: 'Different claims' } } })).rejects.toThrow('design_attempt_content_mismatch');
    const renderPlan = structuredClone(input.prepared.renderPlan);
    (renderPlan.pages[1].elements[0].geometry as { x: number }).x += 0.1;
    await expect(persistPreparedPresentationAttempt({ ...input, prepared: { ...input.prepared, renderPlan } })).rejects.toThrow('design_attempt_render_mismatch');
    await expect(persistPreparedPresentationAttempt({ ...input, attempt: 1 })).rejects.toThrow('design_attempt_parent_mismatch');
    await expect(persistPreparedPresentationAttempt({ ...input, targetSectionIds: ['wrong-document-section'] })).rejects.toThrow('design_attempt_target_invalid');
    expect(await input.storage.readJson(presentationAttemptPath(input.executionId, 0))).toBeUndefined();
  });

  it('cannot overwrite a previously admitted plan with another input', async () => {
    const input = await context();
    const first = await persistPreparedPresentationAttempt(input);
    await expect(persistPreparedPresentationAttempt({ ...input, now: '2026-10-06T04:00:01.000Z' })).rejects.toThrow('design_attempt_conflict');
    expect(await input.storage.readJson(presentationAttemptPath(input.executionId, 0))).toEqual(first);
  });

  it('refuses a receipt without a durable primary plan even when a valid backup exists', async () => {
    const input = await context();
    const first = await persistPreparedPresentationAttempt(input);
    const primary = presentationAttemptPath(input.executionId, 0);
    await input.storage.writeJsonAtomically(primary, first, { backup: true });
    await input.storage.remove(primary);
    await expect(persistPresentationAttemptReceipt({ storage: input.storage, attempt: first, outcome: 'passed', now: input.now }))
      .rejects.toThrow('design_attempt_receipt_parent_missing');
    expect(await input.storage.readJson(presentationAttemptPath(input.executionId, 0, true))).toBeUndefined();
    expect((await input.storage.readJsonWithBackup(primary, value => value))?.source).toBe('backup');
  });

  it.each([
    { name: 'attempt index', mutation: { attempt: 3 }, error: 'design_attempt_invalid' },
    { name: 'attempt digest', mutation: { attemptHash: 'f'.repeat(64) }, error: 'design_attempt_integrity_mismatch' },
    { name: 'content version', mutation: { contentVersion: 2 }, error: 'design_attempt_identity_mismatch' },
    { name: 'layout digest', mutation: { layoutHash: 'e'.repeat(64) }, error: 'design_attempt_identity_mismatch' },
    { name: 'unexpected parent', mutation: { parentAttempt: { attempt: 0, attemptHash: 'a'.repeat(64) } }, error: 'design_attempt_parent_mismatch' }
  ])('refuses a receipt with an altered $name without changing the durable plan', async ({ mutation, error }) => {
    const input = await context();
    const first = await persistPreparedPresentationAttempt(input);
    await expect(persistPresentationAttemptReceipt({ storage: input.storage, attempt: { ...first, ...mutation },
      outcome: 'passed', artifactHash: 'a'.repeat(64), now: input.now })).rejects.toThrow(error);
    expect(await input.storage.readJson(presentationAttemptPath(input.executionId, 0))).toEqual(first);
    expect(await input.storage.readJson(presentationAttemptPath(input.executionId, 0, true))).toBeUndefined();
  });

  it('rechecks the durable parent after a receipt transaction waits for its lock', async () => {
    const input = await context();
    const first = await persistPreparedPresentationAttempt(input);
    const alternateInput = await context();
    const alternate = await persistPreparedPresentationAttempt({ ...alternateInput, now: '2026-10-06T04:00:01.000Z' });
    const receiptPath = presentationAttemptPath(input.executionId, 0, true);
    let release!: () => void;
    let acquired!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const owner = input.storage.withExclusiveAccess([receiptPath], async () => { acquired(); await hold; });
    await locked;
    const writing = persistPresentationAttemptReceipt({ storage: input.storage, attempt: first, outcome: 'passed', now: input.now });
    try {
      await input.storage.writeJsonAtomically(presentationAttemptPath(input.executionId, 0), alternate);
    } finally {
      release();
    }
    await owner;
    await expect(writing).rejects.toThrow('design_attempt_receipt_parent_mismatch');
    expect(await input.storage.readJson(presentationAttemptPath(input.executionId, 0))).toEqual(alternate);
    expect(await input.storage.readJson(receiptPath)).toBeUndefined();
  });

  it('refuses a damaged primary instead of issuing a receipt from an intact backup', async () => {
    const input = await context();
    const first = await persistPreparedPresentationAttempt(input);
    const primary = presentationAttemptPath(input.executionId, 0);
    await input.storage.writeJsonAtomically(primary, first, { backup: true });
    await writeFile(path.join(input.root, primary), '{"incomplete":', 'utf8');
    await expect(persistPresentationAttemptReceipt({ storage: input.storage, attempt: first, outcome: 'passed', now: input.now }))
      .rejects.toThrow(SyntaxError);
    expect(await input.storage.readJson(presentationAttemptPath(input.executionId, 0, true))).toBeUndefined();
    expect((await input.storage.readJsonWithBackup(primary, value => value))?.source).toBe('backup');
  });

  it.each([
    { name: 'identical replay', changes: {} },
    { name: 'different QA outcome', changes: { outcome: 'passed' as const } },
    { name: 'different artifact', changes: { artifactHash: 'b'.repeat(64) } },
    { name: 'different diagnosis or time', changes: { diagnosisCodes: ['overlap'], now: '2026-10-06T04:00:02.000Z' } }
  ])('keeps the original receipt immutable after $name', async ({ changes }) => {
    const input = await context();
    const first = await persistPreparedPresentationAttempt(input);
    const receiptInput = { storage: input.storage, attempt: first, outcome: 'failed' as const,
      artifactHash: 'a'.repeat(64), diagnosisCodes: ['text_overflow'], now: input.now };
    await persistPresentationAttemptReceipt(receiptInput);
    const receiptPath = presentationAttemptPath(input.executionId, 0, true);
    const original = await input.storage.readJson(receiptPath);
    await expect(persistPresentationAttemptReceipt({ ...receiptInput, ...changes })).rejects.toThrow('design_attempt_receipt_conflict');
    expect(await input.storage.readJson(receiptPath)).toEqual(original);
    expect(original).toMatchObject({ qaOutcome: 'failed', publication: 'not_authorized', artifactHash: 'a'.repeat(64), attemptHash: first.attemptHash });
    expect(await input.storage.readJson(presentationAttemptPath(input.executionId, 0))).toEqual(first);
  });
});
