import { createHash } from 'node:crypto';
import { documentContentSnapshotToOutline, parseDocumentContentSnapshot } from '../../domain/entities/document-content-snapshot';
import { parsePresentationDesignIR } from '../../domain/entities/presentation-design-contract';
import { canonicalizeLayoutJson } from '../../domain/entities/presentation-layout-ir';
import { toProjectRelativePath, type NodeProjectStorage } from '../storage';
import { computeDocumentContentDigest, derivePresentationRenderPlanFromLayoutIR, parseVerifiedProductionPresentationLayoutIR } from './presentation-layout-ir-adapter';
import type { PresentationProductionPlan } from './presentation-production-plan';

/** Private Host boundary; never copied into progress events or Provider inputs. */
export type PreparedPresentationDesignPlan = PresentationProductionPlan;

export interface PresentationDesignAttempt {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly sourceDraftId: string;
  readonly draftRevision: number;
  readonly attempt: number;
  readonly contentVersion: number;
  readonly designVersion?: number;
  readonly layoutVersion?: number;
  readonly renderVersion?: number;
  readonly contentHash: string;
  readonly designHash?: string;
  readonly layoutHash?: string;
  readonly renderHash?: string;
  readonly parentAttempt?: { readonly attempt: number; readonly attemptHash: string };
  readonly targetSectionIds: readonly string[];
  readonly targetPageIds: readonly string[];
  readonly diagnosisCodes: readonly string[];
  readonly createdAt: string;
  readonly plan: PreparedPresentationDesignPlan;
  readonly attemptHash: string;
}

/** A compiler/QA observation is never a registration or recovery authority. */
export interface PresentationCandidateQaReceipt {
  readonly schemaVersion: 1;
  readonly kind: 'candidate_qa_receipt';
  readonly attempt: number;
  readonly attemptHash: string;
  readonly artifactHash?: string;
  readonly qaOutcome: 'passed' | 'failed' | 'cancelled';
  readonly publication: 'not_authorized';
  readonly diagnosisCodes: readonly string[];
  readonly createdAt: string;
}

/** Closed readback contract: hashes and versions must describe the same validated private plan. */
export function parsePresentationDesignAttempt(value: unknown): PresentationDesignAttempt {
  const raw = object(value);
  exact(raw, ['schemaVersion', 'executionId', 'sourceDraftId', 'draftRevision', 'attempt', 'contentVersion',
    'designVersion', 'layoutVersion', 'renderVersion', 'contentHash', 'designHash', 'layoutHash', 'renderHash',
    'parentAttempt', 'targetSectionIds', 'targetPageIds', 'diagnosisCodes', 'createdAt', 'plan', 'attemptHash']);
  if (raw.schemaVersion !== 1 || !id(raw.executionId) || !id(raw.sourceDraftId) ||
    !integer(raw.draftRevision, 0, 1_000_000) || !integer(raw.attempt, 0, 2) || !integer(raw.contentVersion, 1, 1_000_000) ||
    !hash(raw.contentHash) || !hash(raw.attemptHash) || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) {
    throw new TypeError('design_attempt_invalid');
  }
  const planRaw = object(raw.plan);
  exact(planRaw, ['contentSnapshot', 'outline', 'designIR', 'layoutIR', 'renderPlan', 'snapshot']);
  const plan = validatePreparedPlan(planRaw as unknown as PreparedPresentationDesignPlan);
  const version = Number(raw.attempt) + 1;
  const validateVersion = (name: 'design' | 'layout' | 'render', payload: unknown, digestValue?: string) => {
    if (payload === undefined ? raw[`${name}Version`] !== undefined || raw[`${name}Hash`] !== undefined
      : raw[`${name}Version`] !== version || raw[`${name}Hash`] !== digestValue) throw new TypeError('design_attempt_identity_mismatch');
  };
  validateVersion('design', plan.designIR, plan.designIR ? digest(plan.designIR) : undefined);
  validateVersion('layout', plan.layoutIR, plan.layoutIR?.identity.layoutDigest);
  validateVersion('render', plan.renderPlan, plan.renderPlan ? digest(plan.renderPlan) : undefined);
  if (raw.contentVersion !== plan.contentSnapshot.revision || raw.contentHash !== computeDocumentContentDigest(plan.contentSnapshot)) {
    throw new TypeError('design_attempt_identity_mismatch');
  }
  const targetSectionIds = safeList(raw.targetSectionIds, 40);
  const targetPageIds = safeList(raw.targetPageIds, 40);
  if (targetSectionIds.some(sectionId => !plan.contentSnapshot.sections.some(section => section.sectionId === sectionId))) {
    throw new TypeError('design_attempt_target_invalid');
  }
  const expectedPages = plan.layoutIR?.pages.filter(page => page.source.kind === 'content' && targetSectionIds.includes(page.source.sectionId)).map(page => page.pageId) ?? [];
  if (digest(targetPageIds) !== digest(expectedPages)) throw new TypeError('design_attempt_target_invalid');
  codes(raw.diagnosisCodes);
  if (raw.attempt === 0) {
    if (raw.parentAttempt !== undefined) throw new TypeError('design_attempt_parent_mismatch');
  } else {
    const parent = object(raw.parentAttempt);
    exact(parent, ['attempt', 'attemptHash']);
    if (parent.attempt !== Number(raw.attempt) - 1 || !hash(parent.attemptHash)) throw new TypeError('design_attempt_parent_mismatch');
  }
  const { attemptHash, ...body } = raw;
  if (digest(body) !== attemptHash || JSON.stringify(raw).length > 32_000_000) throw new TypeError('design_attempt_integrity_mismatch');
  return structuredClone(raw) as unknown as PresentationDesignAttempt;
}

/** One immutable, validated compiler input is durable before the PPT writer runs. */
export async function persistPreparedPresentationAttempt(input: {
  readonly storage: NodeProjectStorage;
  readonly executionId: string;
  readonly sourceDraftId: string;
  readonly draftRevision: number;
  readonly attempt: number;
  readonly prepared: PreparedPresentationDesignPlan;
  readonly previousAttempt?: PresentationDesignAttempt;
  readonly targetSectionIds?: readonly string[];
  readonly diagnosisCodes?: readonly string[];
  readonly now: string;
}): Promise<PresentationDesignAttempt> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0 || input.attempt > 2 ||
    !Number.isSafeInteger(input.draftRevision) || input.draftRevision < 0 ||
    !input.executionId || input.executionId.length > 256 || !input.sourceDraftId || input.sourceDraftId.length > 256 ||
    !Number.isFinite(Date.parse(input.now))) throw new TypeError('design_attempt_invalid');
  if ((input.attempt === 0) !== (input.previousAttempt === undefined) || (input.previousAttempt &&
    (input.previousAttempt.executionId !== input.executionId || input.previousAttempt.attempt !== input.attempt - 1))) {
    throw new TypeError('design_attempt_parent_mismatch');
  }
  if (input.previousAttempt) {
    const { attemptHash, ...parent } = input.previousAttempt;
    const persisted = await input.storage.readJson(presentationAttemptPath(input.executionId, input.attempt - 1));
    if (digest(parent) !== attemptHash || persisted === undefined || digest(persisted) !== digest(input.previousAttempt)) {
      throw new TypeError('design_attempt_parent_mismatch');
    }
  }
  const { contentSnapshot, outline, designIR, layoutIR, renderPlan, snapshot } = validatePreparedPlan(input.prepared);
  const targetSectionIds = [...(input.targetSectionIds ?? [])];
  if (new Set(targetSectionIds).size !== targetSectionIds.length || targetSectionIds.some(id => !contentSnapshot.sections.some(section => section.sectionId === id))) {
    throw new TypeError('design_attempt_target_invalid');
  }
  const targetPageIds = layoutIR?.pages.filter(page => page.source.kind === 'content' && targetSectionIds.includes(page.source.sectionId)).map(page => page.pageId) ?? [];
  const diagnosisCodes = [...(input.diagnosisCodes ?? [])];
  if (diagnosisCodes.length > 40 || diagnosisCodes.some(code => !/^[a-z][a-z0-9_]{0,79}$/u.test(code))) throw new TypeError('design_attempt_diagnosis_invalid');
  const version = input.attempt + 1;
  const record = {
    schemaVersion: 1 as const, executionId: input.executionId, sourceDraftId: input.sourceDraftId,
    draftRevision: input.draftRevision, attempt: input.attempt, contentVersion: contentSnapshot.revision,
    ...(designIR ? { designVersion: version, designHash: digest(designIR) } : {}),
    ...(layoutIR ? { layoutVersion: version, layoutHash: layoutIR.identity.layoutDigest } : {}),
    ...(renderPlan ? { renderVersion: version, renderHash: digest(renderPlan) } : {}),
    contentHash: computeDocumentContentDigest(contentSnapshot),
    ...(input.previousAttempt ? { parentAttempt: { attempt: input.previousAttempt.attempt, attemptHash: input.previousAttempt.attemptHash } } : {}),
    targetSectionIds, targetPageIds, diagnosisCodes, createdAt: input.now,
    plan: { contentSnapshot, outline, ...(designIR ? { designIR } : {}), ...(layoutIR ? { layoutIR } : {}),
      ...(renderPlan ? { renderPlan } : {}), snapshot }
  };
  const result: PresentationDesignAttempt = { ...record, attemptHash: digest(record) };
  await input.storage.mutateJsonAtomically(presentationAttemptPath(input.executionId, input.attempt), previous => {
    if (previous !== undefined && digest(previous) !== digest(result)) throw new TypeError('design_attempt_conflict');
    return result;
  });
  return result;
}

/** Artifact/QA evidence is separate from the immutable pre-write plan identity. */
export async function persistPresentationAttemptReceipt(input: {
  readonly storage: NodeProjectStorage;
  readonly attempt: PresentationDesignAttempt;
  readonly artifactHash?: string;
  readonly outcome: 'passed' | 'failed' | 'cancelled';
  readonly diagnosisCodes?: readonly string[];
  readonly now: string;
}): Promise<void> {
  if (!Number.isFinite(Date.parse(input.now)) || !['passed', 'failed', 'cancelled'].includes(input.outcome) ||
    (input.artifactHash !== undefined && !/^[a-f0-9]{64}$/u.test(input.artifactHash))) throw new TypeError('design_attempt_artifact_invalid');
  const diagnosisCodes = [...(input.diagnosisCodes ?? [])];
  if (diagnosisCodes.length > 40 || diagnosisCodes.some(code => !/^[a-z][a-z0-9_]{0,79}$/u.test(code))) throw new TypeError('design_attempt_diagnosis_invalid');
  const expected = parsePresentationDesignAttempt(input.attempt);
  await input.storage.mutateJsonAtomically(presentationAttemptPath(expected.executionId, expected.attempt, true), async previous => {
    if (previous !== undefined) throw new TypeError('design_attempt_receipt_conflict');
    // Recheck the immutable dependency inside the receipt transaction after any queued wait.
    const durableRaw = await input.storage.readJson(presentationAttemptPath(expected.executionId, expected.attempt));
    if (durableRaw === undefined) throw new TypeError('design_attempt_receipt_parent_missing');
    const durable = parsePresentationDesignAttempt(durableRaw);
    if (digest(durable) !== digest(expected)) throw new TypeError('design_attempt_receipt_parent_mismatch');
    const receipt: PresentationCandidateQaReceipt = { schemaVersion: 1, kind: 'candidate_qa_receipt',
      attempt: durable.attempt, attemptHash: durable.attemptHash,
      ...(input.artifactHash ? { artifactHash: input.artifactHash } : {}), qaOutcome: input.outcome,
      publication: 'not_authorized', diagnosisCodes, createdAt: input.now };
    return receipt;
  });
}

export function presentationAttemptPath(executionId: string, attempt: number, receipt = false) {
  return toProjectRelativePath(`entities/document-design-attempts/${createHash('sha256').update(executionId).digest('hex')}/attempt-${attempt}${receipt ? '-receipt' : ''}.json`);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeLayoutJson(value))).digest('hex');
}

function validatePreparedPlan(value: PreparedPresentationDesignPlan): PreparedPresentationDesignPlan {
  const contentSnapshot = parseDocumentContentSnapshot(value.contentSnapshot);
  const outline = documentContentSnapshotToOutline(contentSnapshot);
  if (digest(outline) !== digest(value.outline)) throw new TypeError('design_attempt_content_mismatch');
  const designIR = value.designIR === undefined ? undefined : parsePresentationDesignIR(value.designIR, { outline });
  const layoutIR = value.layoutIR === undefined ? undefined : parseVerifiedProductionPresentationLayoutIR(value.layoutIR,
    { content: contentSnapshot, ...(designIR ? { design: designIR } : {}) });
  const renderPlan = layoutIR === undefined ? undefined : derivePresentationRenderPlanFromLayoutIR(layoutIR, contentSnapshot);
  if ((renderPlan === undefined) !== (value.renderPlan === undefined) ||
    (renderPlan && digest(renderPlan) !== digest(value.renderPlan))) throw new TypeError('design_attempt_render_mismatch');
  const snapshot = object(value.snapshot);
  exact(snapshot, ['designPath', 'fallbackReason', 'designIR', 'artDirectionStatus', 'designIrStatus', 'layoutStatus',
    'renderPlanStatus', 'repairCount', 'repairs', 'diagnostics', 'strategies', 'pages']);
  if (!['design-aware', 'legacy-fallback'].includes(String(snapshot.designPath)) ||
    !['validated', 'invalid', 'missing'].includes(String(snapshot.artDirectionStatus)) ||
    !['validated', 'invalid', 'missing'].includes(String(snapshot.designIrStatus)) ||
    !['success', 'failed', 'skipped'].includes(String(snapshot.layoutStatus)) ||
    !['valid', 'invalid', 'skipped'].includes(String(snapshot.renderPlanStatus)) || !integer(snapshot.repairCount, 0, 4) ||
    !boundedArray(snapshot.repairs, 4) || !boundedArray(snapshot.diagnostics, 40) ||
    !boundedArray(snapshot.strategies, 40) || !boundedArray(snapshot.pages, 40) || !snapshot.pages.length) {
    throw new TypeError('design_attempt_snapshot_invalid');
  }
  if (snapshot.designPath === 'design-aware' && (!designIR || !layoutIR || !renderPlan)) throw new TypeError('design_attempt_plan_missing');
  if (snapshot.designPath === 'legacy-fallback' && (typeof snapshot.fallbackReason !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/u.test(snapshot.fallbackReason))) {
    throw new TypeError('design_attempt_fallback_reason_missing');
  }
  if (snapshot.designIR !== undefined && (!designIR || digest(parsePresentationDesignIR(snapshot.designIR, { outline })) !== digest(designIR))) {
    throw new TypeError('design_attempt_identity_mismatch');
  }
  return { contentSnapshot, outline, ...(designIR ? { designIR } : {}), ...(layoutIR ? { layoutIR } : {}),
    ...(renderPlan ? { renderPlan } : {}), snapshot: structuredClone(value.snapshot) };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('design_attempt_invalid');
  }
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('design_attempt_unknown_field');
}
function integer(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
function id(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f]/u.test(value); }
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function boundedArray(value: unknown, maximum: number): value is readonly unknown[] { return Array.isArray(value) && value.length <= maximum; }
function safeList(value: unknown, maximum: number): readonly string[] {
  if (!boundedArray(value, maximum) || value.some(item => !id(item)) || new Set(value).size !== value.length) throw new TypeError('design_attempt_invalid');
  return value as readonly string[];
}
function codes(value: unknown): void {
  if (!boundedArray(value, 40) || value.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/u.test(item))) throw new TypeError('design_attempt_diagnosis_invalid');
}
