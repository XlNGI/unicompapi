import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  parseDocumentIR, toDocumentTaskRuntimeId,
  type ConversationId, type DocumentIR, type DocumentOutline, type DocumentWorkspaceKind, type FileReference,
  type MessageId, type ProjectId, type Work, type WorkId, type DocumentTaskRuntime
} from '../../domain';
import { createCanonicalToolRegistry, validateCanonicalToolArguments, type CanonicalToolArguments, type CanonicalToolContract, type DocumentToolResult, type ToolExecutionContext } from '../../domain/entities/canonical-tool-contract';
import { HostExecutionBudget } from '../../application/execution-budget';
import { DocumentTaskRuntimeService } from '../../application/document-task-runtime-service';
import { createReadDocumentStructureBinding } from '../../application/read-document-structure-tool';
import type { GeneratePptxToolDependencies } from '../../application/generate-pptx-tool';
import type { PresentationArtDirectionPlanner } from '../../application/presentation-art-direction';
import type { DocumentGenerationExecutionInput } from '../../application/document-generation-service';
import { createDocumentToolCallingBridge } from '../providers/document-tool-bridge';
import { JsonDocumentTaskRuntimeRepository } from '../repositories/json-document-task-runtime-repository';
import { NodeProjectStorage } from '../storage';
import { RegisteredPresentationReader } from './registered-presentation-reader';
import { readRegisteredOfficeDocument } from './registered-office-reader';
import { applyStructuredDocumentPatch, parseDocumentPatch } from './structured-document-tools';
import { compilePresentationRenderPlan } from './presentation-render-plan-compiler';
import { planExecutablePresentationDesign } from './presentation-design-planning';
import { presentationTemplateIds, resolvePresentationTemplate } from './presentation-template';
import type { PresentationProductionPlan } from './presentation-production-plan';
import type { PptxPhysicalPage } from './pptx-page-reader';
import { DocumentGenerationRunner } from './document-generation-runner';
import { PlatformDocumentGenerationExecutor } from './document-generation-application-adapters';
import { generateTemporaryDocumentFile } from './office-document-generator';
import type { DocumentRenderAdapter } from './temporary-document-workflow';
import { DocumentIdentityIndexStore } from './document-identity-index-store';
import { DocumentMutationHeadStore } from './document-mutation-head-store';
import { buildPresentationIdentityManifest, type PresentationIdentityManifest } from './presentation-identity-manifest';
import { hasControlledDocumentVersionEvidence } from './document-controlled-version-evidence';
import { carryForwardPresentationDesignIdentity, preserveUntargetedPresentationParts } from './presentation-revision-materializer';
import { parseDocumentVersionPin, type DocumentVersionPin } from '../../domain/entities/document-version-pin';
import type { ConversationDocumentToolSession } from './conversation-document-tool-session';
import type { DocumentAtomicToolBinding } from '../../application/document-atomic-tools';
import type { DocumentMutationHead } from '../../application/document-mutation-coordinator';
import { emitProductionDiagnostic } from '../conversation-production-trace';
import { presentationContentInventory, reorganizePresentationContent } from '../../application/presentation-content-reorganization';
import { canonicalizeLayoutJson } from '../../domain/entities/presentation-layout-ir';
import { PresentationRevisionLedger } from './presentation-revision-ledger';
import type { DocumentPatch } from './structured-document-tools';
import type { DocumentRevisionPatch } from '../../application/document-revision-agent';

export interface ConversationDocumentRevisionSelection {
  readonly kind: 'revision'; readonly projectId: ProjectId; readonly conversationId: ConversationId;
  readonly currentUserMessageId: MessageId; readonly userMessageRevision: number; readonly userMessageHash: string;
  readonly sourceMessageId: MessageId; readonly revision: number; readonly workId: WorkId;
  readonly fileId: FileReference['id']; readonly checksumSha256: string; readonly sizeBytes: number;
  readonly fileName: string; readonly sourceExecutionId: string; readonly fileUpdatedAt: string;
  readonly documentKind: DocumentWorkspaceKind; readonly scope: 'document' | 'page' | 'section'; readonly ordinal?: number;
  readonly writeAuthorized: boolean; readonly bindingHash: string;
  readonly briefHash: string;
  readonly allowContentReorganization?: boolean; readonly allowPaginationChange?: boolean;
}
interface Source {
  readonly work: Work; readonly file: FileReference; readonly fileName: string; readonly buffer: Uint8Array;
  readonly ir: DocumentIR; readonly outline?: DocumentOutline; readonly pages?: readonly PptxPhysicalPage[];
  readonly plan?: PresentationProductionPlan;
}
export interface ConversationDocumentRevisionOperationHost extends ConversationDocumentToolSession {
  readonly businessBinding: DocumentAtomicToolBinding;
  readonly readBinding: DocumentAtomicToolBinding;
  prepareForHost(head: DocumentMutationHead, observed: boolean): Promise<boolean>;
}

/** Same durable tool bridge and parent budget as other native document work; no extra Agent loop. */
export async function createConversationDocumentRevisionSession(options: {
  readonly rootDirectory: string; readonly projectId: ProjectId; readonly responseExecutionId: string;
  readonly selection: ConversationDocumentRevisionSelection; readonly signal?: AbortSignal;
  readonly executionBudget?: HostExecutionBudget; readonly generation: GeneratePptxToolDependencies;
  readonly renderPreview?: DocumentRenderAdapter; readonly requestArtDirection?: PresentationArtDirectionPlanner;
  readonly userRequirement: string;
  readonly validateBinding: () => Promise<boolean>;
  readonly externalRuntime?: { readonly service: DocumentTaskRuntimeService; readonly runtime: DocumentTaskRuntime };
}): Promise<ConversationDocumentRevisionOperationHost> {
  const selection = options.selection, storage = new NodeProjectStorage(options.rootDirectory);
  const registry = createCanonicalToolRegistry(), readContract = registry.get('read_document_structure')!;
  const writeContract = registry.get(selection.documentKind === 'ppt' ? 'revise_presentation' : 'revise_office')!;
  const controller = new AbortController(), cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const service = options.externalRuntime?.service ?? new DocumentTaskRuntimeService(new JsonDocumentTaskRuntimeRepository(storage, options.projectId), { validateBindings: options.validateBinding });
  const runtime = options.externalRuntime?.runtime ?? await service.create({ id: toDocumentTaskRuntimeId(`document-revision-${hash(options.responseExecutionId)}`),
    projectId: options.projectId, conversationId: selection.conversationId, sourceMessageId: selection.currentUserMessageId,
    executionId: options.responseExecutionId, documentKind: selection.documentKind, operation: selection.writeAuthorized ? 'edit' : 'analyze',
    budget: { maxSteps: options.executionBudget?.policy.maxToolCalls ?? 12, budgetUnits: options.executionBudget?.policy.budgetUnits ?? 32,
      timeoutMs: 540_000, ...(options.executionBudget ? { deadlineAt: options.executionBudget.policy.deadlineAt } : {}) } });
  const startedAt = Date.parse(runtime.createdAt);
  const budget = options.executionBudget ?? new HostExecutionBudget({ startedAt, deadlineAt: startedAt + 540_000,
    maxToolCalls: runtime.budget.maxSteps, budgetUnits: runtime.budget.budgetUnits }, { signal: controller.signal });
  const stop = () => controller.abort(); budget.signal.addEventListener('abort', stop, { once: true });
  let source: Source | undefined, currentWorkId = selection.workId, observedHash: string | undefined;
  let registeredWorkId: WorkId | undefined, unknown = false, closed = false, writeCompleted = false, checkpoint = { revision: 0, step: 0 };
  let contentReorganizationAttempted = false;
  let designRequestsUsed = 0;
  const requestDesign: PresentationArtDirectionPlanner = async request => {
    budget.assertCanProceed('design');
    if (!options.requestArtDirection || designRequestsUsed >= 3) throw new Error('design_revision_correction_limit');
    designRequestsUsed += 1;
    return options.requestArtDirection(request);
  };
  const identities = new DocumentIdentityIndexStore(storage), heads = new DocumentMutationHeadStore(storage);
  let head: DocumentVersionPin | undefined, baseIdentity: PresentationIdentityManifest | undefined;
  const live = async () => !closed && !controller.signal.aborted && await options.validateBinding();
  const assertLive = async () => { budget.assertCanProceed('tool'); if (!await live()) throw new Error('authorization_or_revision_invalid'); };
  const load = async (): Promise<Source> => {
    await assertLive();
    if (selection.documentKind !== 'ppt') return readRegisteredOfficeDocument({ ...options, workId: currentWorkId, kind: selection.documentKind });
    const current = await new RegisteredPresentationReader(options).readWithProductionPlan(currentWorkId);
    const ir = parseDocumentIR({ operation: runtime.operation, attachmentRefs: [], documentRef: currentWorkId,
      content: { title: current.fileName, pageCount: current.pages.length, sourceRefs: [], styleConstraints: [],
        sections: current.pages.map(page => ({ sectionId: `physical-${page.pageNumber}`, heading: page.heading || `第 ${page.pageNumber} 页`, preserve: [],
          blocks: (page.contentText.match(/[\s\S]{1,4000}/gu) ?? []).map((text, index) => ({ blockId: `physical-${page.pageNumber}-${index}`, kind: 'text', content: text, sourceRefs: [] })) })) } });
    if (JSON.stringify(ir).length > 28_000) throw new Error('document_scope_exceeded');
    return { ...current, ir, plan: current.productionPlan?.plan, outline: current.productionPlan?.plan.outline };
  };
  const refresh = async () => {
    const previous = source;
    const current = await load();
    await assertLive();
    if (previous && previous.work.id === current.work.id && previous.file.checksumSha256 !== current.file.checksumSha256) throw new Error('revision_conflict');
    source = current;
  };
  const version = () => source ? Number.parseInt(source.file.checksumSha256!.slice(0, 12), 16) : selection.userMessageRevision;
  const allowed = (): readonly (typeof writeContract.toolId)[] => source && selection.writeAuthorized &&
    (selection.documentKind !== 'ppt' || Boolean(options.requestArtDirection && options.renderPreview && source.plan &&
      (source.plan.designIR && source.plan.renderPlan || selection.scope === 'document' && source.pages?.length === source.plan.outline.sections.length + 2)))
    ? [readContract.toolId, writeContract.toolId] : [readContract.toolId];
  const context = (): ToolExecutionContext => ({ currentDocumentId: source?.work.id, currentDocumentIR: source?.ir,
    revision: version(), operation: runtime.operation, capabilities: allowed(),
    projectContext: { projectId: options.projectId, responseExecutionId: options.responseExecutionId },
    authorization: { canRead: Boolean(source) && !closed && !controller.signal.aborted,
      canWrite: Boolean(source && selection.writeAuthorized && observedHash === source.file.checksumSha256) && !writeCompleted && !closed && !controller.signal.aborted, allowedToolIds: allowed() },
    abortSignal: controller.signal, taskContext: { taskId: runtime.id, deadlineAt: budget.policy.deadlineAt, checkpoint } });
  const read = createReadDocumentStructureBinding({ registry, readPage: async ordinal => {
    const page = source?.pages?.[ordinal - 1];
    if (!page) throw new Error('target_not_found');
    return { pageNumber: page.pageNumber, heading: page.heading, text: page.contentText, hidden: page.hidden };
  } });
  const scopeAllowsRead = (args: CanonicalToolArguments) => selection.scope === 'document'
    ? selection.documentKind === 'ppt' ? args.scope !== 'section' : args.scope !== 'page'
    : args.scope === selection.scope && args.ordinal === selection.ordinal;
  const ensureHead = async () => {
    if (!source || selection.documentKind !== 'ppt') return;
    const existing = await identities.getForWork(source.work.id);
    if (!existing && await hasControlledDocumentVersionEvidence({ ...options, storage, work: source.work })) throw new Error('identity_unresolved');
    baseIdentity = existing ?? await identities.ensureForWork({ workId: source.work.id, build: () => buildPresentationIdentityManifest({
      buffer: source!.buffer, documentLineageId: `lineage-${hash(`${options.projectId}:${source!.work.id}`)}`,
      workId: source!.work.id, fileId: source!.file.id, sourceExecutionId: source!.work.sourceExecutionId, revision: 1 }) });
    const pin: DocumentVersionPin = { documentLineageId: baseIdentity.documentLineageId, headWorkId: source.work.id,
      fileId: source.file.id, sourceExecutionId: source.work.sourceExecutionId, runtimeRevision: baseIdentity.revision,
      identityIndexVersion: baseIdentity.identityIndexVersion, checksumSha256: source.file.checksumSha256! };
    await heads.save(pin); head = parseDocumentVersionPin(pin);
  };
  const validateSource = async () => {
    await assertLive();
    const fresh = await load();
    if (!source || fresh.file.checksumSha256 !== source.file.checksumSha256 || fresh.work.id !== source.work.id) throw new Error('revision_conflict');
    if (head && JSON.stringify(await heads.get(head.documentLineageId)) !== JSON.stringify(head)) throw new Error('revision_conflict');
  };
  const readBinding: DocumentAtomicToolBinding = { ...read,
      authorize: async (args, ctx) => scopeAllowsRead(args) && await live() && await read.authorize(args, ctx),
      execute: async (args, ctx) => {
        await validateSource();
        const result = await read.execute(args, { ...ctx, currentDocumentIR: source!.ir });
        if (result.status === 'success') observedHash = source!.file.checksumSha256;
        return { ...result, observation: { ...result.observation, fileName: source!.fileName, documentKind: selection.documentKind,
          structureUnit: selection.documentKind === 'ppt' ? 'physical_page' : selection.documentKind === 'excel' ? 'worksheet' : 'section',
          ...(selection.allowContentReorganization && selection.scope === 'document' && args.scope === 'document' && source!.plan ? {
            contentReorganizationAllowed: true, paginationChangeAllowed: selection.allowPaginationChange === true,
            contentInventory: presentationContentInventory(source!.plan.contentSnapshot)
          } : {}),
          limitations: selection.documentKind === 'excel' ? 'Verified worksheet structure. Formulas are not evaluated; displayed cached results may be stale.'
            : 'Verified structured text only; visual interpretation has not been performed.' } };
      }
    };
  const businessBinding: DocumentAtomicToolBinding = {
      contract: writeContract,
      authorize: async (_args, ctx) => !writeCompleted && selection.writeAuthorized && Boolean(source && observedHash === source.file.checksumSha256 && ctx.currentDocumentId === source.work.id) &&
        await live() && ctx.authorization.allowedToolIds.includes(writeContract.toolId),
      preflight: async args => {
        if (!source || observedHash !== source.file.checksumSha256) return failure('read_current_document_first');
        if (selection.documentKind === 'ppt') {
          if (selection.scope !== 'document' && (args.scope !== selection.scope || args.ordinal !== selection.ordinal)) return failure('revision_scope_violation');
          if (args.scope === 'page' && Number(args.ordinal) > (source.pages?.length ?? 0)) return failure('revision_scope_violation');
          if (args.contentOrganization !== undefined) {
            if (!selection.allowContentReorganization || selection.scope !== 'document' || args.scope !== 'document' || !source.plan) return failure('revision_scope_violation');
            if (contentReorganizationAttempted) return failure('content_reorganization_limit');
            try { reorganizePresentationContent(source.plan.contentSnapshot, String(args.contentOrganization), { allowPaginationChange: selection.allowPaginationChange === true }); }
            catch { return failure('content_reorganization_invalid'); }
          }
        } else {
          let changes: readonly CanonicalToolArguments[];
          try { changes = officeChanges(args, writeContract); } catch { return failure('invalid_patch'); }
          for (const change of changes) {
            if (selection.scope === 'section' && change.sectionOrdinal !== selection.ordinal) return failure('revision_scope_violation');
            if (selection.documentKind === 'word' && change.operation === 'update_cells' || selection.documentKind === 'excel' && change.operation === 'replace_text') return failure('unsupported_operation');
          }
          try { for (const change of changes) applyStructuredDocumentPatch(source.outline!, officePatch(source.outline!, change, selection.documentKind)); }
          catch { return failure('target_not_found'); }
        }
        return undefined;
      },
      execute: async (args, ctx): Promise<DocumentToolResult> => {
        let phase = 'validation', publicationStarted = false;
        let ledger: PresentationRevisionLedger | undefined, unchanged = false;
        try {
        await validateSource();
        const original = source!;
        const executionId = `document-revision-output-${hash(`${options.responseExecutionId}:${ctx.callId}`)}`;
        let input: DocumentGenerationExecutionInput;
        let targets: number[] = [];
        let contentReorganized = false;
        let executor = options.generation.executor;
        if (selection.documentKind === 'ppt') {
          phase = 'identity_admission';
          await ensureHead();
          ledger = new PresentationRevisionLedger(storage, { basePin: head!, idempotencyKey: ctx.idempotencyKey,
            requestFingerprint: hash(JSON.stringify(args)) });
          await ledger.claim();
          let plan = original.plan!;
          if (!plan || !options.requestArtDirection || !options.renderPreview ||
            (!plan.designIR || !plan.renderPlan) && (args.scope !== 'document' || original.pages?.length !== plan.outline.sections.length + 2)) return failure('visual_plan_unavailable');
          const sourceDesign = plan.designIR, recordedRenderPlan = plan.renderPlan;
          targets = args.scope === 'page' ? [Number(args.ordinal)] : original.pages!.map(page => page.pageNumber);
          // Recover only a token set that reproduces the persisted source plan exactly.
          // This is compiler evidence matching, never choosing a new composition.
          const verifiedTemplate = sourceDesign && recordedRenderPlan ? presentationTemplateIds.map(id => resolvePresentationTemplate(id)).find(candidate => {
            const compiled = compilePresentationRenderPlan(plan.outline, sourceDesign, candidate.tokens, { contentSnapshot: plan.contentSnapshot });
            return compiled.plan && samePages(compiled.plan.pages, recordedRenderPlan.pages);
          }) : resolvePresentationTemplate('work_report');
          if (!verifiedTemplate) return failure('source_style_unavailable');
          const template = verifiedTemplate.id, tokens = verifiedTemplate.tokens;
          if (args.contentOrganization !== undefined) {
            contentReorganizationAttempted = true;
            const regrouped = reorganizePresentationContent(plan.contentSnapshot, String(args.contentOrganization), { allowPaginationChange: selection.allowPaginationChange === true });
            plan = { ...plan, outline: regrouped.outline, contentSnapshot: regrouped.content };
            contentReorganized = true;
            targets = Array.from({ length: regrouped.outline.sections.length + 2 }, (_value, index) => index + 1);
          }
          phase = 'design';
          const designed = await planExecutablePresentationDesign({ outline: plan.outline, documentIR: parseDocumentIR({
            operation: 'edit', attachmentRefs: [], canonicalContent: plan.contentSnapshot }),
            userRequirement: `${options.userRequirement.slice(0, 10_000)}\n本次模型建议（参考参数，以用户需求和范围为准）：${String(args.request)}${contentReorganized
              ? `\nContent regrouping has already been validated.${sourceDesign ? ` Preserve this original globalDesign exactly: ${JSON.stringify(sourceDesign.globalDesign)}` : ''}` : ''}`.slice(0, 16_000),
            request: requestDesign, signal: ctx.abortSignal, executionBudget: budget, requireDesignTree: true,
            tokens, assets: [], ...(!contentReorganized && sourceDesign && recordedRenderPlan ? { designFeedback: { previousDesign: sourceDesign, targetPages: targets,
              diagnostics: targets.map(pageNumber => ({ code: 'user_visual_revision', pageNumber })),
              ...(args.scope === 'document' ? { allowGlobalDesignChange: true } : {}) } } : {}) });
          if (designed.outcomeUnknown) { unknown = true; await ledger.finish('failed'); return failure('reconciliation_required', 'unknown'); }
          if (!designed.designIR) return failure('design_revision_failed');
          if (contentReorganized && sourceDesign && JSON.stringify(canonicalizeLayoutJson(designed.designIR.globalDesign)) !== JSON.stringify(canonicalizeLayoutJson(sourceDesign.globalDesign))) return failure('revision_scope_violation');
          const compiled = compilePresentationRenderPlan(plan.outline, designed.designIR, tokens, { contentSnapshot: plan.contentSnapshot });
          if (!compiled.plan || compiled.plan.pages.some((page, index) => !targets.includes(page.pageNumber) && (!recordedRenderPlan || !samePages([page], [recordedRenderPlan.pages[index]])))) return failure('revision_scope_violation');
          if (recordedRenderPlan && samePages(compiled.plan.pages, recordedRenderPlan.pages)) {
            registeredWorkId = original.work.id; unchanged = true; writeCompleted = true;
            await service.recordRegisteredWork(runtime, original.work.id);
            return { schemaVersion: 1, status: 'success', observation: { changed: false, operation: 'already_compliant', fileName: original.fileName },
              artifactRefs: [{ kind: 'work', ref: original.work.id }] };
          }
          const renderer = options.renderPreview;
          executor = new PlatformDocumentGenerationExecutor(new DocumentGenerationRunner({ ...options, renderPreview: renderer, requireRenderForPpt: true,
            allowLegacyArtDirectionFallback: false, generateTemporaryFile: async generatedInput => {
              const generated = await generateTemporaryDocumentFile(generatedInput);
              const candidate = await readFile(generated.temporaryPath);
              const bytes = contentReorganized ? candidate : await preserveUntargetedPresentationParts(original.buffer, candidate, targets, ctx.abortSignal);
              await writeFile(generated.temporaryPath, bytes);
              return { ...generated, sizeBytes: bytes.byteLength };
            } }));
          input = { executionId, kind: 'ppt', title: plan.outline.title, outline: plan.outline, designIR: designed.designIR,
            documentIR: parseDocumentIR({ operation: 'edit', attachmentRefs: [], canonicalContent: plan.contentSnapshot }),
            contentFingerprint: hash(JSON.stringify([original.file.checksumSha256, plan.contentSnapshot, designed.designIR])), draftRevision: selection.userMessageRevision,
            sourceDraftId: runtime.id, parentWorkId: original.work.id, sourceChecksumSha256: original.file.checksumSha256,
            presentationTemplate: template, executionBudget: budget, validateSource, images: [], signal: ctx.abortSignal, onCancellationClosed: async () => undefined };
          input = { ...input, requestArtDirection: requestDesign, userRequirement: String(args.request),
            designCorrectionCount: Math.min(2, Math.max(0, designRequestsUsed - 1)), designRevisionTargetPages: targets };
        } else {
          const outline = original.outline!;
          const patches = officeChanges(args, writeContract).map(change => officePatch(outline, change, selection.documentKind));
          let changed = outline;
          for (const patch of patches) changed = applyStructuredDocumentPatch(changed, patch).document;
          if (JSON.stringify(canonicalizeLayoutJson(changed)) === JSON.stringify(canonicalizeLayoutJson(outline))) {
            registeredWorkId = original.work.id; writeCompleted = true;
            await service.recordRegisteredWork(runtime, original.work.id);
            return { schemaVersion: 1, status: 'success', observation: { changed: false, operation: 'already_compliant', fileName: original.fileName },
              artifactRefs: [{ kind: 'work', ref: original.work.id }] };
          }
          const revisionPatches = patches.map(toRevisionPatch);
          input = { executionId, kind: selection.documentKind, title: changed.title, outline: changed,
            contentFingerprint: hash(JSON.stringify([original.file.checksumSha256, patches])), draftRevision: selection.userMessageRevision,
            sourceDraftId: runtime.id, parentWorkId: original.work.id, sourceChecksumSha256: original.file.checksumSha256,
            ...(revisionPatches.length === 1 ? { revisionPatch: revisionPatches[0] } : { revisionPatches }),
            executionBudget: budget, validateSource, images: [], signal: ctx.abortSignal, onCancellationClosed: async () => undefined };
        }
        phase = 'publication'; publicationStarted = true;
        await ledger?.beginPublication();
        const result = await executor.run(input);
        registeredWorkId = result.workId;
        writeCompleted = true;
        await service.recordRegisteredWork(runtime, result.workId);
        if (selection.documentKind === 'ppt' && baseIdentity && head) {
          phase = 'identity_commit';
          const current = await new RegisteredPresentationReader(options).read(result.workId);
          const nextIdentity = await identities.ensureForWork({ workId: result.workId, build: () => contentReorganized
            ? buildPresentationIdentityManifest({ buffer: current.buffer, documentLineageId: baseIdentity!.documentLineageId,
                revision: baseIdentity!.revision + 1, workId: current.work.id, fileId: current.file.id, sourceExecutionId: current.work.sourceExecutionId })
            : carryForwardPresentationDesignIdentity({ previous: baseIdentity!, buffer: current.buffer, targetPages: targets,
                workId: current.work.id, fileId: current.file.id, sourceExecutionId: current.work.sourceExecutionId }) });
          const next: DocumentVersionPin = { documentLineageId: nextIdentity.documentLineageId, headWorkId: current.work.id,
            fileId: current.file.id, sourceExecutionId: current.work.sourceExecutionId, runtimeRevision: nextIdentity.revision,
            identityIndexVersion: nextIdentity.identityIndexVersion, checksumSha256: current.file.checksumSha256! };
          await ledger?.finish('commit_prepared', next);
          phase = 'head_commit';
          if (!await heads.compareAndSwap(head, next, { revalidate: async () => {
            if (ctx.abortSignal.aborted || !await live()) return false;
            const fresh = await load();
            return Boolean(source && fresh.work.id === source.work.id && fresh.file.checksumSha256 === source.file.checksumSha256);
          } })) { unknown = true; await ledger?.finish('reconciliation_required', next); return failure('reconciliation_required', 'unknown'); }
          head = parseDocumentVersionPin(next); baseIdentity = nextIdentity;
          await ledger?.finish('committed', next);
        }
        phase = 'readback'; currentWorkId = result.workId; source = undefined; observedHash = undefined;
        await refresh();
        return { schemaVersion: 1, status: 'success', observation: { changed: true, operation: 'revised', fileName: result.fileName,
          documentKind: selection.documentKind, ...(contentReorganized ? { contentReorganized: true } : {}) }, artifactRefs: [{ kind: 'work', ref: result.workId }] };
        } catch (error) {
          const raw = error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.message : '';
          const code = typeof raw === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(raw) ? raw : 'revision_failed';
          await emitProductionDiagnostic({ code: 'plan_validation', status: 'failed', operationId: `document_revision_${phase}_${code}`,
            facts: { tool: 'patch', purpose: 'tool' } });
          if (publicationStarted || code === 'reconciliation_required') { unknown = true; await ledger?.finish('reconciliation_required'); return failure('reconciliation_required', 'unknown'); }
          return failure(writeContract.diagnostics.failureCodes.includes(code) ? code : 'revision_failed');
        } finally {
          if (ledger?.claimed && !ledger.finished && !unknown && !publicationStarted) await ledger.finish(unchanged ? 'session_refreshed' : ctx.abortSignal.aborted ? 'cancelled' : 'failed');
        }
      }
    };
  const bridge = createDocumentToolCallingBridge({ registry, executionBudget: budget, maxCalls: runtime.budget.maxSteps,
    budgetUnits: runtime.budget.budgetUnits, timeoutMs: 180_000, getExecutionContext: context,
    runtime: { service: {
      beginToolCall: async (...args) => { const result = await service.beginToolCall(...args); checkpoint = { revision: result.runtime.revision, step: result.runtime.checkpoint.step }; return result; },
      recordObservation: async (...args) => { const result = await service.recordObservation(...args); checkpoint = { revision: result.revision, step: result.checkpoint.step }; return result; }
    }, scope: runtime }, bindings: [readBinding, businessBinding] });
  return { executionBudget: budget, businessBinding, readBinding,
    prepareForHost: async (headValue, observed) => {
      if (!options.externalRuntime || headValue.pin.headWorkId !== headValue.identity.workId || headValue.pin.checksumSha256 !== headValue.identity.artifactChecksumSha256) return false;
      if (currentWorkId !== headValue.pin.headWorkId) { source = undefined; currentWorkId = headValue.pin.headWorkId as WorkId; }
      await refresh();
      if (source?.file.checksumSha256 !== headValue.pin.checksumSha256) return false;
      observedHash = observed ? source.file.checksumSha256 : undefined;
      return !writeCompleted && Boolean(observedHash && allowed().includes(writeContract.toolId));
    },
    providerToolChoice: tools => !observedHash && tools?.length === 1 ? 'required' : undefined,
    prepareTools: async signal => {
      signal.throwIfAborted();
      await budget.run('prepare', async child => { child.throwIfAborted(); await refresh(); }, 30_000);
      if (writeCompleted && observedHash === source?.file.checksumSha256) return undefined;
      return bridge.tools.length ? bridge.tools : undefined;
    }, bridge: { execute: async request => {
      const result = await bridge.bridge.execute(request);
      if (result.status === 'unknown') unknown = true;
      return result;
    } },
    cancel: async () => { budget.cancel('cancelled'); controller.abort(); },
    close: async () => {
      if (closed) return;
      closed = true; controller.abort(); options.signal?.removeEventListener('abort', cancel); budget.signal.removeEventListener('abort', stop);
      if (!options.executionBudget) budget.dispose();
      if (options.externalRuntime) return;
      if (unknown || bridge.hasUnknownResult()) await service.markNeedsReconciliation(runtime);
      const stored = await service.require(runtime);
      if (['planning', 'running', 'paused'].includes(stored.status)) {
        if (registeredWorkId && !unknown && !bridge.hasUnknownResult()) await service.complete(runtime, registeredWorkId);
        else if (!selection.writeAuthorized && observedHash && !bridge.hasUnknownResult()) await service.completeRead(runtime);
        else await service.setStatus(runtime, budget.stopReason === 'cancelled' ? 'cancelled' : stored.toolCalls.at(-1)?.status === 'failed' ? 'failed' : 'paused');
      }
    }
  };
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function samePages(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function failure(code: string, status: 'failed' | 'unknown' = 'failed'): DocumentToolResult {
  return { schemaVersion: 1, status, diagnostics: [{ code, severity: 'error', message: code }] };
}

function officeChanges(args: CanonicalToolArguments, contract: CanonicalToolContract): readonly CanonicalToolArguments[] {
  if (args.operation !== 'apply_changes') return [args];
  const raw: unknown = JSON.parse(String(args.changes));
  if (!Array.isArray(raw) || !raw.length || raw.length > 16) throw new Error('invalid_patch');
  const changes = raw.map(item => validateCanonicalToolArguments(contract, item));
  if (changes.some(change => change.operation === 'apply_changes')) throw new Error('invalid_patch');
  const keys = changes.map(change => JSON.stringify([change.sectionOrdinal, change.blockOrdinal, change.row, change.column]));
  if (new Set(keys).size !== keys.length || changes.some(change => change.operation === 'clear_section' &&
    changes.filter(other => other.sectionOrdinal === change.sectionOrdinal).length > 1)) throw new Error('invalid_patch');
  return changes;
}
function officePatch(outline: DocumentOutline, args: CanonicalToolArguments, kind: DocumentWorkspaceKind): DocumentPatch {
  return parseDocumentPatch({ operation: args.operation, target: { sectionIndex: Number(args.sectionOrdinal) - 1,
    sectionHeading: outline.sections[Number(args.sectionOrdinal) - 1]?.heading,
    ...(args.blockOrdinal === undefined ? {} : { blockIndex: Number(args.blockOrdinal) - 1 }),
    ...(args.row === undefined ? {} : { rowIndex: Number(args.row) - 1, columnIndex: Number(args.column) - 1 }) },
    ...(args.text === undefined ? {} : { value: String(args.text) }) }, kind);
}
function toRevisionPatch(patch: DocumentPatch): DocumentRevisionPatch {
  const target = { sectionIndex: patch.target.sectionIndex!, sectionHeading: patch.target.sectionHeading! };
  return patch.operation === 'clear_section' ? { operation: 'clear_section', target }
    : patch.operation === 'update_cells' ? { operation: 'update_cells', target: { ...target, blockIndex: patch.target.blockIndex!, rowIndex: patch.target.rowIndex!, columnIndex: patch.target.columnIndex! }, value: patch.value! }
      : { operation: 'replace_text', target: { ...target, blockIndex: patch.target.blockIndex! }, value: patch.value! };
}
