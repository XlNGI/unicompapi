import { createHash } from 'node:crypto';
import type { FileReference, ProjectId, Work } from '../../domain';
import { DocumentGenerationApplicationError } from '../../application/document-generation-service';
import { canonicalizeLayoutJson } from '../../domain/entities/presentation-layout-ir';
import { JsonExecutionRepository, JsonFileReferenceRepository, JsonTaskRepository, JsonWorkRepository } from '../repositories/json-repositories';
import { NodeProjectStorage, toProjectRelativePath, type JsonStorageLoadResult, type ProjectRelativePath } from '../storage';
import { parsePresentationDesignAttempt, presentationAttemptPath, type PresentationCandidateQaReceipt, type PresentationDesignAttempt } from './presentation-design-attempts';
import type { PresentationProductionPlan } from './presentation-production-plan';

/** Private Host evidence attached to an already registered and verified artifact. */
export interface VerifiedPresentationProductionPlan {
  readonly attempt: PresentationDesignAttempt;
  readonly plan: PresentationProductionPlan;
}

/**
 * Receipts never authorize publication. The caller must first read the registered
 * Work through the safe file reader; this boundary then verifies its current
 * primary identities and the bounded, immutable compiler evidence.
 */
export async function readRegisteredPresentationProductionPlan(input: {
  readonly rootDirectory: string;
  readonly projectId: ProjectId;
  readonly work: Work;
  readonly file: FileReference;
  readonly buffer: Uint8Array;
}): Promise<VerifiedPresentationProductionPlan | undefined> {
  try {
    const storage = new PrimaryOnlyProjectStorage(input.rootDirectory);
    const checksum = createHash('sha256').update(input.buffer).digest('hex');
    if (input.buffer.byteLength > 20 * 1024 * 1024 || input.file.checksumSha256 !== checksum ||
      input.file.sizeBytes !== input.buffer.byteLength) invalid();
    const verifyRegisteredIdentity = async () => {
      const [work, file] = await Promise.all([
        new JsonWorkRepository(storage, input.projectId).get(input.work.id),
        new JsonFileReferenceRepository(storage, input.projectId).get(input.file.id)
      ]);
      if (!work || !file || digest(work) !== digest(input.work) || digest(file) !== digest(input.file) ||
        work.projectId !== input.projectId || file.projectId !== input.projectId || work.mediaKind !== 'document' ||
        work.fileId !== file.id || work.sourceExecutionId !== file.sourceExecutionId || file.state !== 'available' ||
        file.checksumSha256 !== checksum || file.locator.kind !== 'project') invalid();
    };
    await verifyRegisteredIdentity();
    const attempts: PresentationDesignAttempt[] = [];
    const matches: PresentationDesignAttempt[] = [];
    let hasEvidence = false;
    for (let index = 0; index <= 2; index += 1) {
      const [rawAttempt, rawReceipt] = await Promise.all([
        primaryEvidence(storage, presentationAttemptPath(input.work.sourceExecutionId, index)),
        primaryEvidence(storage, presentationAttemptPath(input.work.sourceExecutionId, index, true))
      ]);
      if (rawAttempt === undefined && rawReceipt === undefined) continue;
      hasEvidence = true;
      if (rawAttempt === undefined || attempts.length !== index) invalid();
      const attempt = parsePresentationDesignAttempt(rawAttempt);
      if (attempt.executionId !== input.work.sourceExecutionId || attempt.attempt !== index ||
        (index > 0 && (attempt.parentAttempt?.attempt !== index - 1 ||
          attempt.parentAttempt?.attemptHash !== attempts[index - 1].attemptHash))) invalid();
      attempts.push(attempt);
      if (rawReceipt === undefined) invalid();
      const receipt = parseReceipt(rawReceipt);
      if (receipt.attempt !== index || receipt.attemptHash !== attempt.attemptHash ||
        Date.parse(receipt.createdAt) < Date.parse(attempt.createdAt)) invalid();
      if (receipt.qaOutcome === 'passed' && receipt.artifactHash === checksum) matches.push(attempt);
    }
    // Legacy artifacts have no private evidence. Physical observations remain valid.
    if (!hasEvidence) return undefined;
    if (matches.length !== 1) invalid();
    const selected = matches[0];
    const [task, execution] = await Promise.all([
      new JsonTaskRepository(storage, input.projectId).get(input.work.sourceTaskId),
      new JsonExecutionRepository(storage).get(input.work.sourceExecutionId)
    ]);
    if (!task || !execution || task.projectId !== input.projectId || task.id !== input.work.sourceTaskId ||
      execution.taskId !== task.id || !task.executionIds.includes(execution.id) ||
      !['registering_work', 'completed'].includes(execution.state) || execution.workId !== input.work.id ||
      execution.outputFileId !== input.file.id || task.submission.kind !== 'document_generation' ||
      task.submission.document.kind !== 'ppt') invalid();
    const submission = task.submission.document;
    if (attempts.some(attempt => attempt.sourceDraftId !== task.sourceDraftId ||
      attempt.draftRevision !== submission.draftRevision)) invalid();
    await verifyRegisteredIdentity();
    return { attempt: selected, plan: structuredClone(selected.plan) };
  } catch (error) {
    if (error instanceof DocumentGenerationApplicationError) throw error;
    throw new DocumentGenerationApplicationError('revision_scope_violation',
      'PPT 的生产计划与当前作品版本不一致，请核对作品后重新发起修改。');
  }
}

/** Repository validation is retained, while backup restoration cannot grant authority. */
class PrimaryOnlyProjectStorage extends NodeProjectStorage {
  override async readJsonWithBackup<T>(relativePath: ProjectRelativePath,
    parse: (value: unknown) => T): Promise<JsonStorageLoadResult<T> | undefined> {
    const value = await this.readJson<unknown>(relativePath);
    return value === undefined ? undefined : { value: parse(value), source: 'primary' };
  }
}

async function primaryEvidence(storage: NodeProjectStorage, relativePath: ProjectRelativePath): Promise<unknown | undefined> {
  const primary = await storage.readJson<unknown>(relativePath);
  if (primary === undefined && await storage.readJson<unknown>(toProjectRelativePath(`${relativePath}.bak`)) !== undefined) invalid();
  return primary;
}

function parseReceipt(value: unknown): PresentationCandidateQaReceipt {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const raw = value as Record<string, unknown>;
  const allowed = ['schemaVersion', 'kind', 'attempt', 'attemptHash', 'artifactHash', 'qaOutcome', 'publication', 'diagnosisCodes', 'createdAt'];
  if (Object.keys(raw).some(key => !allowed.includes(key)) || raw.schemaVersion !== 1 || raw.kind !== 'candidate_qa_receipt' ||
    !Number.isSafeInteger(raw.attempt) || Number(raw.attempt) < 0 || Number(raw.attempt) > 2 || !hash(raw.attemptHash) ||
    (raw.artifactHash !== undefined && !hash(raw.artifactHash)) || !['passed', 'failed', 'cancelled'].includes(String(raw.qaOutcome)) ||
    (raw.qaOutcome === 'passed' && !hash(raw.artifactHash)) || raw.publication !== 'not_authorized' ||
    !Array.isArray(raw.diagnosisCodes) || raw.diagnosisCodes.length > 40 ||
    raw.diagnosisCodes.some(code => typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/u.test(code)) ||
    typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) invalid();
  return structuredClone(raw) as unknown as PresentationCandidateQaReceipt;
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeLayoutJson(value))).digest('hex');
}
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function invalid(): never { throw new TypeError('presentation_production_plan_invalid'); }
