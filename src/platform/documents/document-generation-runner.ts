import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {
  addExecutionToTask,
  canTransitionExecution,
  createDocumentTask,
  createExecution,
  createFileReference,
  registerWork,
  toExecutionId,
  toFileReferenceId,
  toIsoTimestamp,
  toTaskId,
  toWorkId,
  transitionExecution,
  type DocumentWorkspaceKind,
  type Execution,
  type FileReference,
  type ProjectId,
  type Task,
  type Work,
  type WorkId
} from '../../domain';
import { resolveFileReferencePathSafely } from '../files';
import type { DocumentThemeId } from './document-theme';
import type { PresentationTemplateId } from './presentation-template';
import {
  FileVerificationError,
  FileVerificationPersistenceService,
  NodeFileStatusProbe,
  NodeSha256FileVerifier,
  type FileVerificationResult
} from '../files';
import {
  JsonExecutionRepository,
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage, toProjectRelativePath } from '../storage';
import {
  generateTemporaryDocumentFile,
  sanitizeFileName,
  type GenerateDocumentFileInput,
  type GeneratedTemporaryDocumentFile
} from './office-document-generator';
import type { DocumentOutline } from './document-outline-parser';
import type { DocumentRevisionPatch } from '../../application/document-revision-agent';
import {
  readOfficeDocumentStructureFromBuffer
} from './office-document-tool-executor';
import type { DocumentStructureSnapshot } from './structured-document-tools';
import type { DocumentRenderResult } from './temporary-document-workflow';
import { readPptxDocument, readPptxSlideOrder } from './pptx-page-reader';

export type DocumentGenerationErrorCode =
  | 'invalid_plan'
  | 'cancelled'
  | 'generation_failed'
  | 'verification_failed'
  | 'revision_scope_violation'
  | 'write_failed'
  | 'registration_failed'
  | 'result_sync_pending'
  | 'page_count_mismatch'
  | 'storage_error';

export class DocumentGenerationError extends Error {
  constructor(
    readonly code: DocumentGenerationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DocumentGenerationError';
  }
}

export interface DocumentGenerationPlanInput {
  readonly kind: DocumentWorkspaceKind;
  readonly title: string;
  readonly contentFingerprint: string;
  readonly draftRevision: number;
  readonly sourceDraftId: string;
  readonly outline: DocumentOutline;
  readonly parentWorkId?: WorkId;
  readonly sourceChecksumSha256?: string;
  readonly revisionTargetSectionHeading?: string;
  readonly revisionPatch?: DocumentRevisionPatch;
  readonly revisionPatches?: readonly DocumentRevisionPatch[];
  readonly requestedTotalPages?: number;
  readonly theme?: DocumentThemeId;
  readonly presentationTemplate?: PresentationTemplateId;
  readonly signal?: AbortSignal;
  readonly onCancellationClosed?: () => void | Promise<void>;
  readonly images?: readonly {
    readonly fileId?: string;
    readonly workId?: string;
    readonly caption?: string;
  }[];
}

export interface DocumentGenerationResult {
  readonly task: Task;
  readonly execution: Execution;
  readonly file: FileReference;
  readonly work: Work;
  readonly validatedOutline?: DocumentOutline;
}

interface RunnerContext {
  readonly storage: NodeProjectStorage;
  readonly tasks: JsonTaskRepository;
  readonly executions: JsonExecutionRepository;
  readonly files: JsonFileReferenceRepository;
  readonly works: JsonWorkRepository;
  readonly fileIndex: JsonFileIndexRepository;
}

const maximumGeneratedDocumentBytes = 64 * 1024 * 1024;

function isPptContinuationHeading(heading: string, sectionHeading: string): boolean {
  return heading === sectionHeading || heading.startsWith(`${sectionHeading}（续`);
}

export class DocumentGenerationRunner {
  constructor(
    private readonly options: {
      readonly rootDirectory: string;
      readonly projectId: ProjectId;
      readonly now?: () => string;
      readonly createId?: () => string;
      readonly generateTemporaryFile?: (
        input: GenerateDocumentFileInput
      ) => Promise<GeneratedTemporaryDocumentFile>;
      readonly renderPreview?: (
        temporaryPath: string,
        input: { readonly kind: DocumentWorkspaceKind; readonly signal: AbortSignal }
      ) => Promise<DocumentRenderResult>;
      publishFile?(
        temporaryPath: string,
        finalPath: string
      ): Promise<void>;
      afterFileRegistered?(): void | Promise<void>;
    }
  ) {}

  async run(
    input: DocumentGenerationPlanInput
  ): Promise<DocumentGenerationResult> {
    const now = this.options.now ?? (() => new Date().toISOString());
    const createId = this.options.createId ?? (() => randomUUID());
    const context = this.context();
    const existing = await this.findRegisteredResult(context, input);
    if (existing) return existing;
    let task: Task | undefined;
    let execution: Execution | undefined;
    let temporaryPath: string | undefined;
    let finalPath: string | undefined;
    let file: FileReference | undefined;
    let workRegistered = false;
    try {
      task = createDocumentTask({
        id: toTaskId(`task-document-${createId()}`),
        projectId: this.options.projectId,
        sourceDraftId: input.sourceDraftId,
        kind: input.kind,
        title: input.title,
        contentFingerprint: input.contentFingerprint,
        draftRevision: input.draftRevision,
        confirmedAt: toIsoTimestamp(now())
      });
      await context.tasks.save(task);
      execution = createExecution({
        id: toExecutionId(`execution-document-${createId()}`),
        taskId: task.id,
        createdAt: toIsoTimestamp(now())
      });
      const taskWithExecution = addExecutionToTask(task, execution);
      await context.executions.save(execution);
      await context.tasks.save(taskWithExecution);

      execution = await this.move(context, execution, 'queued');
      this.assertNotCancelled(input.signal);
      execution = await this.move(context, execution, 'validating_sources');
      execution = await this.move(context, execution, 'preparing_media');
      execution = await this.move(context, execution, 'encoding');
      execution = await this.move(context, execution, 'writing_file');
      const outputDirectory = path.join(
        this.options.rootDirectory,
        'files',
        'documents'
      );
      await context.storage.ensureDirectory(
        toProjectRelativePath('files/documents')
      );
      const generateTemporaryFile =
        this.options.generateTemporaryFile ?? generateTemporaryDocumentFile;
      const revisionSource = await this.resolveRevisionSource(context, input);
      const sourceStructure =
        revisionSource.revisionSourcePath && (input.revisionPatch || input.revisionPatches)
          ? await readOfficeDocumentStructureFromBuffer({
              buffer: revisionSource.revisionSourceBuffer!,
              kind: input.kind,
              displayName: path.basename(revisionSource.revisionSourcePath)
            })
          : undefined;
      const generated = await generateTemporaryFile({
        kind: input.kind,
        outline: input.outline,
        outputDirectory,
        now: now(),
        ...(input.theme !== undefined ? { theme: input.theme } : {}),
        ...(input.presentationTemplate !== undefined
          ? { presentationTemplate: input.presentationTemplate }
          : {}),
        ...revisionSource,
        ...(input.images !== undefined && input.images.length > 0
          ? { images: await this.resolveImages(context, input.images) }
          : {})
      });
      temporaryPath = generated.temporaryPath;
      finalPath = generated.finalPath;
      this.assertNotCancelled(input.signal);
      execution = await this.move(context, execution, 'verifying_file');
      await this.assertTemporaryOutput(
        generated,
        input.kind,
        input.outline,
        input.requestedTotalPages
      );
      if (this.options.renderPreview) {
        try {
          const renderResult = await this.options.renderPreview(generated.temporaryPath, {
            kind: input.kind,
            signal: input.signal ?? new AbortController().signal
          });
          if ((renderResult.diagnostics ?? []).some((diagnostic) => diagnostic.severity === 'error')) {
            throw new DocumentGenerationError('verification_failed', 'Rendered document failed visual diagnostics');
          }
        } catch (error) {
          throw new DocumentGenerationError(
            'verification_failed',
            error instanceof Error ? error.message : 'Document preview rendering failed'
          );
        }
      }
      if (sourceStructure && (input.revisionPatch || input.revisionPatches)) {
        await this.assertRevisionScope(
          sourceStructure,
          generated,
          input.kind,
          input.revisionPatches ?? [input.revisionPatch!]
        );
        if (input.kind === 'ppt') await this.assertUntouchedPptParts(
          revisionSource.revisionSourceBuffer!, generated, input.revisionPatches ?? [input.revisionPatch!], sourceStructure
        );
      }
      const temporaryVerification = await this.verifyTemporaryOutput(
        execution,
        generated,
        input.signal
      );
      this.assertNotCancelled(input.signal);
      const validatedOutline = input.kind === 'ppt' && (input.revisionPatch || input.revisionPatches)
        ? await this.readRevisedOutline(input, generated.temporaryPath) : undefined;
      await syncFile(generated.temporaryPath);
      await (this.options.publishFile ?? rename)(
        generated.temporaryPath,
        generated.finalPath
      );
      temporaryPath = undefined;
      file = await this.registerVerifiedOutput(
        context,
        execution,
        generated.fileName,
        temporaryVerification.checksumSha256,
        input.signal
      );
      await this.options.afterFileRegistered?.();
      this.assertNotCancelled(input.signal);
      await input.onCancellationClosed?.();
      this.assertNotCancelled(input.signal);
      const workId = toWorkId(`work-document-${createId()}`);
      execution = await this.move(context, execution, 'registering_work', {
        outputFileId: file.id,
        workId
      });
      const work = registerWork({
        id: workId,
        task: await this.requireTask(context, execution.taskId),
        execution,
        file,
        mediaKind: 'document',
        name: generated.fileName,
        parentWorkId: input.parentWorkId,
        createdAt: toIsoTimestamp(now())
      });
      await context.works.save(work);
      workRegistered = true;
      execution = transitionExecution(execution, 'completed', toIsoTimestamp(now()), {
        outputFileId: file.id,
        workId
      });
      await context.executions.save(execution);
      return {
        task: await this.requireTask(context, execution.taskId),
        execution,
        file,
        work,
        ...(validatedOutline ? { validatedOutline } : {})
      };
    } catch (error) {
      if (workRegistered) throw new DocumentGenerationError('result_sync_pending', 'The new document is registered; execution status synchronization must be retried');
      const errorCode = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      const classified = error instanceof DocumentGenerationError ? error
        : errorCode === 'target_not_found' ? new DocumentGenerationError('revision_scope_violation', 'The requested range could not be applied to the actual document')
        : execution?.state === 'registering_work' ? new DocumentGenerationError('registration_failed', 'The new document could not be registered')
        : ['ENOSPC', 'EACCES', 'EPERM', 'EBUSY', 'EROFS'].includes(String(errorCode)) ? new DocumentGenerationError('write_failed', 'The new document could not be written to local storage')
        : error;
      const cancelled =
        input.signal?.aborted === true ||
        (error instanceof DocumentGenerationError && error.code === 'cancelled') ||
        (error instanceof FileVerificationError && error.code === 'aborted');
      if (file && !workRegistered) {
        await this.removeRegisteredOutput(context, file);
      }
      // A registered Work is already published. Keep its final write recoverable
      // instead of turning it into a failed execution that a retry would duplicate.
      if (execution && !workRegistered) {
        const current = (await context.executions.get(execution.id)) ?? execution;
        if (!['completed', 'cancelled', 'failed'].includes(current.state)) {
          if (cancelled) {
            await this.persistCancelledExecution(context, current);
          } else {
            await context.executions.save(
              transitionExecution(current, 'failed', toIsoTimestamp(now()), {
                failure: {
                  stage: current.state,
                  message: classified instanceof DocumentGenerationError ? classified.code : 'document_execution_failed',
                  retryability:
                    classified instanceof DocumentGenerationError &&
                    ['generation_failed', 'write_failed', 'registration_failed', 'storage_error'].includes(classified.code)
                      ? 'retryable'
                      : 'not_retryable'
                }
              })
            );
          }
        }
      }
      if (cancelled) {
        throw new DocumentGenerationError(
          'cancelled',
          'Document generation was cancelled'
        );
      }
      throw classified;
    } finally {
      if (temporaryPath) await rm(temporaryPath, { force: true });
      if (finalPath && !workRegistered) {
        await rm(finalPath, { force: true });
      }
    }
  }

  /**
   * Generation is retried after the assistant message or workflow settlement
   * can fail. Reuse only a fully registered, locally verified Work matching the
   * exact source draft, format and content fingerprint; never trust a stale
   * task or file name as an idempotency hit. A registration awaiting only its
   * final execution write can be settled after validating all persisted links.
   */
  private async findRegisteredResult(
    context: RunnerContext,
    input: DocumentGenerationPlanInput
  ): Promise<DocumentGenerationResult | undefined> {
    const tasks = await context.tasks.list(this.options.projectId);
    const candidates = tasks.filter((task) => {
      if (task.submission.kind !== 'document_generation') return false;
      const document = task.submission.document;
      return task.projectId === this.options.projectId &&
        task.sourceDraftId === input.sourceDraftId &&
        document.kind === input.kind &&
        document.contentFingerprint === input.contentFingerprint &&
        document.draftRevision === input.draftRevision;
    });
    for (const task of candidates) {
      const executions = await context.executions.list(task.id);
      const registered = [...executions]
        .filter((execution) => (execution.state === 'completed' || execution.state === 'registering_work') &&
          execution.taskId === task.id && task.executionIds.includes(execution.id) &&
          execution.workId !== undefined && execution.outputFileId !== undefined)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      for (const execution of registered) {
        const work = await context.works.get(execution.workId!);
        if (!work || work.projectId !== this.options.projectId || work.mediaKind !== 'document' ||
          work.sourceTaskId !== task.id || work.sourceExecutionId !== execution.id ||
          work.fileId !== execution.outputFileId || work.parentWorkId !== input.parentWorkId) continue;
        const file = await context.files.get(work.fileId);
        if (!file || file.projectId !== this.options.projectId || file.sourceExecutionId !== execution.id ||
          file.state !== 'available' || !file.checksumSha256 || file.locator.kind !== 'project') continue;
        try {
          const verification = await new NodeFileStatusProbe(this.options.rootDirectory).inspect(file, { expectedChecksum: file.checksumSha256 });
          if (verification.recommendedState !== 'available' || verification.verification?.matchesExpected !== true) continue;
        } catch {
          continue;
        }
        if (execution.state === 'registering_work') {
          const completed = transitionExecution(execution, 'completed', toIsoTimestamp(
            (this.options.now ?? (() => new Date().toISOString()))()
          ), { outputFileId: file.id, workId: work.id });
          await context.executions.save(completed);
          return { task, execution: completed, file, work,
            ...(input.kind === 'ppt' && (input.revisionPatch || input.revisionPatches)
              ? { validatedOutline: await this.readRevisedOutline(input, await resolveFileReferencePathSafely(this.options.rootDirectory, file)) } : {}) };
        }
        return { task, execution, file, work,
          ...(input.kind === 'ppt' && (input.revisionPatch || input.revisionPatches)
            ? { validatedOutline: await this.readRevisedOutline(input, await resolveFileReferencePathSafely(this.options.rootDirectory, file)) } : {}) };
      }
    }
    return undefined;
  }

  private async resolveRevisionSource(
    context: RunnerContext,
    input: DocumentGenerationPlanInput
  ): Promise<{
    readonly revisionSourcePath?: string;
    readonly revisionSourceBuffer?: Uint8Array;
    readonly revisionTargetSectionHeading?: string;
    readonly revisionPatch?: DocumentRevisionPatch;
    readonly revisionPatches?: readonly DocumentRevisionPatch[];
  }> {
    if (
      input.parentWorkId === undefined ||
      (input.revisionTargetSectionHeading === undefined &&
        input.revisionPatch === undefined &&
        input.revisionPatches === undefined)
    ) {
      return {};
    }
    try {
      const parent = await context.works.get(input.parentWorkId);
      if (!parent) {
        throw new DocumentGenerationError(
          'storage_error',
          'The parent Work for this scoped revision does not exist'
        );
      }
      const file = await context.files.get(parent.fileId);
      if (!file) {
        throw new DocumentGenerationError(
          'storage_error',
          'The parent document file reference does not exist'
        );
      }
      const sourcePath = await resolveFileReferencePathSafely(
        this.options.rootDirectory,
        file
      );
      if (file.state !== 'available' || file.sourceExecutionId !== parent.sourceExecutionId || !file.checksumSha256) {
        throw new DocumentGenerationError('revision_scope_violation', 'Parent file is not a verified revision source');
      }
      const revisionSourceBuffer = await readFile(sourcePath);
      if (revisionSourceBuffer.length > maximumGeneratedDocumentBytes || revisionSourceBuffer.length !== file.sizeBytes ||
        createHash('sha256').update(revisionSourceBuffer).digest('hex') !== file.checksumSha256 ||
        (input.sourceChecksumSha256 && input.sourceChecksumSha256 !== file.checksumSha256)) {
        throw new DocumentGenerationError('revision_scope_violation', 'Parent file changed after revision scope was prepared');
      }
      return {
        revisionSourcePath: sourcePath,
        revisionSourceBuffer,
        ...(input.revisionTargetSectionHeading !== undefined
          ? { revisionTargetSectionHeading: input.revisionTargetSectionHeading }
          : {}),
        ...(input.revisionPatch !== undefined
          ? { revisionPatch: input.revisionPatch }
          : {}),
        ...(input.revisionPatches !== undefined
          ? { revisionPatches: input.revisionPatches }
          : {})
      };
    } catch (error) {
      if (error instanceof DocumentGenerationError) throw error;
      throw new DocumentGenerationError(
        'storage_error',
        'The parent document file could not be resolved for scoped revision'
      );
    }
  }

  private assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new DocumentGenerationError(
        'cancelled',
        'Document generation was cancelled'
      );
    }
  }

  private async assertTemporaryOutput(
    generated: GeneratedTemporaryDocumentFile,
    kind: DocumentWorkspaceKind,
    outline: DocumentOutline,
    requestedTotalPages?: number
  ): Promise<void> {
    const metadata = await lstat(generated.temporaryPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size <= 0 ||
      metadata.size !== generated.sizeBytes ||
      metadata.size > maximumGeneratedDocumentBytes
    ) {
      throw new DocumentGenerationError(
        'verification_failed',
        'Generated document has invalid file metadata'
      );
    }
    const expectedExtension = {
      word: '.docx',
      excel: '.xlsx',
      ppt: '.pptx'
    }[kind];
    if (path.extname(generated.fileName).toLowerCase() !== expectedExtension) {
      throw new DocumentGenerationError(
        'verification_failed',
        'Generated document has an unexpected file extension'
      );
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(await readFile(generated.temporaryPath));
      const requiredPart = {
        word: 'word/document.xml',
        excel: 'xl/workbook.xml',
        ppt: 'ppt/presentation.xml'
      }[kind];
      if (!zip.file(requiredPart)) {
        throw new Error('required OOXML part is missing');
      }
    } catch {
      throw new DocumentGenerationError(
        'verification_failed',
        'Generated document is not a valid Office package'
      );
    }
    if (kind === 'ppt' && requestedTotalPages !== undefined) {
      const actualPages = (await readPptxSlideOrder(zip)).length;
      if (actualPages !== requestedTotalPages) {
        throw new DocumentGenerationError(
          'page_count_mismatch',
          `生成的 PPT 共 ${actualPages} 页，与明确要求的 ${requestedTotalPages} 页不一致。`
        );
      }
    }
    await assertExpectedDocumentContent(zip, kind, outline, generated.fileName);
  }

  private async verifyTemporaryOutput(
    execution: Execution,
    generated: GeneratedTemporaryDocumentFile,
    signal: AbortSignal | undefined
  ): Promise<FileVerificationResult> {
    const now = this.options.now ?? (() => new Date().toISOString());
    const provisional = createFileReference({
      id: toFileReferenceId(`document-file-${randomUUID()}`),
      projectId: this.options.projectId,
      sourceExecutionId: execution.id,
      locator: { kind: 'external', absolutePath: generated.temporaryPath },
      createdAt: toIsoTimestamp(now())
    });
    return new NodeSha256FileVerifier(this.options.rootDirectory).verify({
      file: provisional,
      signal
    });
  }

  private async assertRevisionScope(
    source: DocumentStructureSnapshot,
    generated: GeneratedTemporaryDocumentFile,
    kind: DocumentWorkspaceKind,
    patches: readonly DocumentRevisionPatch[]
  ): Promise<void> {
    const candidate = await readOfficeDocumentStructureFromBuffer({
      buffer: await readFile(generated.temporaryPath),
      kind,
      displayName: generated.fileName
    });
    if (candidate.sections.length !== source.sections.length) {
      throw new DocumentGenerationError(
        'verification_failed',
        'Scoped document revision changed the document section count'
      );
    }
    const targetIndexes = new Set<number>();
    for (const patch of patches) {
      const index = patch.target.sectionIndex;
      if (!Number.isSafeInteger(index) || index < 0 || index >= source.sections.length) {
        throw new DocumentGenerationError('verification_failed', 'Scoped document revision target was not found in the source file');
      }
      if (
        kind === 'ppt' &&
        (patch.operation === 'clear_section' || patch.operation === 'replace_section') &&
        'pageNumber' in patch.target &&
        patch.target.pageNumber !== undefined
      ) {
        const pageIndex = patch.target.pageNumber - 1;
        const sectionHeading = patch.target.sectionHeading;
        if (
          pageIndex < 0 ||
          pageIndex >= source.sections.length ||
          sectionHeading === undefined ||
          !isPptContinuationHeading(source.sections[pageIndex].heading, sectionHeading)
        ) {
          throw new DocumentGenerationError('revision_scope_violation', 'Scoped document revision page target was not found');
        }
        targetIndexes.add(pageIndex);
        if (patch.target.targetUnit !== 'page') {
          for (
            let continuationIndex = pageIndex + 1;
            continuationIndex < source.sections.length &&
            isPptContinuationHeading(
              source.sections[continuationIndex].heading,
              sectionHeading
            );
            continuationIndex += 1
          ) {
            targetIndexes.add(continuationIndex);
          }
        }
      } else {
        targetIndexes.add(index);
      }
    }
    if (targetIndexes.size === 0) {
      throw new DocumentGenerationError(
        'verification_failed',
        'Scoped document revision target was not found in the source file'
      );
    }
    for (let index = 0; index < source.sections.length; index += 1) {
      if (targetIndexes.has(index)) continue;
      if (
        candidate.sections[index]?.heading !== source.sections[index].heading ||
        candidate.sections[index]?.contentHash !== source.sections[index].contentHash
      ) {
        throw new DocumentGenerationError(
          'verification_failed',
          'Scoped document revision changed content outside the target'
        );
      }
    }
    if (
      [...targetIndexes].every(
        (index) => candidate.sections[index]?.contentHash === source.sections[index].contentHash
      )
    ) {
      throw new DocumentGenerationError(
        'verification_failed',
        'Scoped document revision did not change the requested target'
      );
    }
    for (const patch of patches) {
      if (patch.operation === 'replace_text' || patch.operation === 'update_cells') {
        this.assertFineGrainedRevisionScope(source, candidate, patch);
      }
    }
  }

  private async readRevisedOutline(input: DocumentGenerationPlanInput, filePath: string): Promise<DocumentOutline> {
    const pages = await readPptxDocument(await readFile(filePath));
    const targets = new Set((input.revisionPatches ?? (input.revisionPatch ? [input.revisionPatch] : [])).map((patch) => patch.target.sectionIndex));
    return { ...input.outline, sections: input.outline.sections.map((section, index) => {
      if (!targets.has(index)) return section;
      const sectionPages = pages.filter((page) => page.pageNumber > 1 && isPptContinuationHeading(page.heading, section.heading));
      if (!sectionPages.length) throw new DocumentGenerationError('revision_scope_violation', 'Revised section was not found');
      const blocks = sectionPages.flatMap((page) => {
        const lines = page.contentText.split('\n').map((line) => line.trim()).filter(Boolean);
        if (lines[0] === page.heading) lines.shift();
        return lines.map((text) => ({ type: 'paragraph' as const, text }));
      });
      return { heading: section.heading, level: section.level, ...(section.pageKind ? { pageKind: section.pageKind } : {}), blocks };
    }) };
  }

  private async assertUntouchedPptParts(source: Uint8Array, generated: GeneratedTemporaryDocumentFile,
    patches: readonly DocumentRevisionPatch[], structure: DocumentStructureSnapshot): Promise<void> {
    const before = await JSZip.loadAsync(source);
    const after = await JSZip.loadAsync(await readFile(generated.temporaryPath));
    const names = await readPptxSlideOrder(before);
    const allowed = new Set<string>();
    for (const patch of patches) {
      if (!('pageNumber' in patch.target) || !patch.target.pageNumber) continue;
      let index = patch.target.pageNumber - 1;
      allowed.add(names[index]);
      if (patch.target.targetUnit !== 'page') {
        while (++index < names.length && isPptContinuationHeading(structure.sections[index].heading, patch.target.sectionHeading)) allowed.add(names[index]);
      }
    }
    if (!allowed.size) return;
    if (Object.keys(before.files).sort().join('\n') !== Object.keys(after.files).sort().join('\n')) {
      throw new DocumentGenerationError('revision_scope_violation', 'Revision changed package structure outside its scope');
    }
    for (const name of Object.keys(before.files)) {
      if (allowed.has(name) || before.files[name].dir) continue;
      const [original, candidate] = await Promise.all([before.file(name)!.async('nodebuffer'), after.file(name)!.async('nodebuffer')]);
      if (!original.equals(candidate)) throw new DocumentGenerationError('revision_scope_violation', 'Revision changed another page or shared resource');
    }
  }

  private assertFineGrainedRevisionScope(
    source: DocumentStructureSnapshot,
    candidate: DocumentStructureSnapshot,
    patch: Extract<DocumentRevisionPatch, { operation: 'replace_text' | 'update_cells' }>
  ): void {
    const sourceSection = source.sections[patch.target.sectionIndex];
    const candidateSection = candidate.sections[patch.target.sectionIndex];
    if (
      !sourceSection ||
      !candidateSection ||
      sourceSection.heading !== patch.target.sectionHeading ||
      sourceSection.blocks.length !== candidateSection.blocks.length
    ) {
      throw new DocumentGenerationError('verification_failed', 'Fine-grained revision changed the target structure');
    }
    const blockIndex = patch.target.blockIndex;
    for (let index = 0; index < sourceSection.blocks.length; index += 1) {
      if (index === blockIndex) continue;
      if (sourceSection.blocks[index].contentHash !== candidateSection.blocks[index]?.contentHash) {
        throw new DocumentGenerationError('verification_failed', 'Fine-grained revision changed another block');
      }
    }
    const sourceBlock = sourceSection.blocks[blockIndex];
    const candidateBlock = candidateSection.blocks[blockIndex];
    if (!sourceBlock || !candidateBlock || sourceBlock.type !== candidateBlock.type) {
      throw new DocumentGenerationError('verification_failed', 'Fine-grained revision target block is invalid');
    }
    if (patch.operation === 'replace_text') {
      if (
        sourceBlock.itemContentHashes.length !== 1 ||
        candidateBlock.itemContentHashes.length !== 1 ||
        sourceBlock.itemContentHashes[0] === candidateBlock.itemContentHashes[0]
      ) {
        throw new DocumentGenerationError('verification_failed', 'Fine-grained text target did not change exactly once');
      }
      return;
    }
    const columns = sourceBlock.columnCount;
    if (
      columns === undefined ||
      columns !== candidateBlock.columnCount ||
      sourceBlock.itemContentHashes.length !== candidateBlock.itemContentHashes.length
    ) {
      throw new DocumentGenerationError('verification_failed', 'Fine-grained cell target structure changed');
    }
    const targetItemIndex = columns + patch.target.rowIndex * columns + patch.target.columnIndex;
    for (let index = 0; index < sourceBlock.itemContentHashes.length; index += 1) {
      const changed = sourceBlock.itemContentHashes[index] !== candidateBlock.itemContentHashes[index];
      if (changed !== (index === targetItemIndex)) {
        throw new DocumentGenerationError('verification_failed', 'Fine-grained revision changed cells outside the target');
      }
    }
  }

  private async persistCancelledExecution(
    context: RunnerContext,
    execution: Execution
  ): Promise<void> {
    const now = this.options.now ?? (() => new Date().toISOString());
    let cancelled = execution;
    if (canTransitionExecution(cancelled.state, 'cancel_requested')) {
      cancelled = transitionExecution(
        cancelled,
        'cancel_requested',
        toIsoTimestamp(now())
      );
      await context.executions.save(cancelled);
    }
    if (!canTransitionExecution(cancelled.state, 'cancelled')) {
      throw new DocumentGenerationError(
        'storage_error',
        `Document execution cannot be cancelled from ${cancelled.state}`
      );
    }
    cancelled = transitionExecution(
      cancelled,
      'cancelled',
      toIsoTimestamp(now())
    );
    await context.executions.save(cancelled);
  }

  private context(): RunnerContext {
    const storage = new NodeProjectStorage(this.options.rootDirectory);
    return {
      storage,
      tasks: new JsonTaskRepository(storage, this.options.projectId),
      executions: new JsonExecutionRepository(storage),
      files: new JsonFileReferenceRepository(storage, this.options.projectId),
      works: new JsonWorkRepository(storage, this.options.projectId),
      fileIndex: new JsonFileIndexRepository(storage, this.options.projectId)
    };
  }

  private async move(
    context: RunnerContext,
    execution: Execution,
    nextState: Execution['state'],
    extra: Parameters<typeof transitionExecution>[3] = {}
  ): Promise<Execution> {
    const now = this.options.now ?? (() => new Date().toISOString());
    const next = transitionExecution(
      execution,
      nextState,
      toIsoTimestamp(now()),
      extra
    );
    await context.executions.save(next);
    return next;
  }

  private async requireTask(
    context: RunnerContext,
    taskId: Task['id']
  ): Promise<Task> {
    const task = await context.tasks.get(taskId);
    if (!task) {
      throw new DocumentGenerationError(
        'storage_error',
        'Document task disappeared during generation'
      );
    }
    return task;
  }

  private async registerVerifiedOutput(
    context: RunnerContext,
    execution: Execution,
    fileName: string,
    expectedChecksum: string,
    signal: AbortSignal | undefined
  ): Promise<FileReference> {
    const now = this.options.now ?? (() => new Date().toISOString());
    let file = createFileReference({
      id: toFileReferenceId(`document-file-${randomUUID()}`),
      projectId: this.options.projectId,
      sourceExecutionId: execution.id,
      locator: {
        kind: 'project',
        relativePath: toProjectRelativePath(`files/documents/${fileName}`)
      },
      createdAt: toIsoTimestamp(now())
    });
    const probe = new NodeFileStatusProbe(this.options.rootDirectory);
    const persistence = new FileVerificationPersistenceService(
      context.files,
      context.fileIndex,
      probe,
      () => toIsoTimestamp(now())
    );
    const result = await probe.inspect(file, { expectedChecksum, signal });
    if (
      result.recommendedState !== 'available' ||
      result.verification?.matchesExpected !== true
    ) {
      throw new DocumentGenerationError(
        'verification_failed',
        'Generated document did not pass local verification'
      );
    }
    file = await persistence.persistProbeResult(file, result);
    if (
      file.state !== 'available' ||
      !file.checksumSha256 ||
      file.sizeBytes === undefined
    ) {
      throw new DocumentGenerationError(
        'verification_failed',
        'Generated document verification could not be persisted'
      );
    }
    return file;
  }

  private async removeRegisteredOutput(
    context: RunnerContext,
    file: FileReference
  ): Promise<void> {
    await context.fileIndex.remove(file.id);
    await context.files.remove(file.id);
  }

  private async resolveImages(
    context: RunnerContext,
    images: readonly {
      readonly fileId?: string;
      readonly workId?: string;
      readonly caption?: string;
    }[]
  ): Promise<
    readonly { readonly absolutePath: string; readonly caption?: string }[]
  > {
    const resolved: {
      readonly absolutePath: string;
      readonly caption?: string;
    }[] = [];
    for (const image of images) {
      let file: FileReference | undefined;
      if (image.workId !== undefined) {
        const work = await context.works.get(toWorkId(image.workId));
        if (!work) {
          throw new DocumentGenerationError(
            'storage_error',
            'AI image work does not exist'
          );
        }
        file = await context.files.get(work.fileId);
      } else if (image.fileId !== undefined) {
        file = await context.files.get(toFileReferenceId(image.fileId));
      } else {
        file = undefined;
      }
      if (!file) {
        throw new DocumentGenerationError(
          'storage_error',
          'Image source does not exist'
        );
      }
      resolved.push({
        absolutePath: await resolveFileReferencePathSafely(
          this.options.rootDirectory,
          file
        ),
        ...(image.caption !== undefined ? { caption: image.caption } : {})
      });
    }
    return resolved;
  }
}

async function assertExpectedDocumentContent(
  zip: JSZip,
  kind: DocumentWorkspaceKind,
  outline: DocumentOutline,
  fileName: string
): Promise<void> {
  const relevantPart = {
    word: /^word\/document\.xml$/,
    excel: /^xl\/(?:workbook|sharedStrings|worksheets\/sheet\d+)\.xml$/,
    ppt: /^ppt\/slides\/slide\d+\.xml$/
  }[kind];
  const parts = Object.keys(zip.files).filter((name) => relevantPart.test(name));
  const xml = (await Promise.all(parts.map((name) => zip.file(name)!.async('string'))))
    .join('\n');
  const searchable = normalizeOfficeText(
    `${xml}\n${xml.replace(/<[^>]+>/g, ' ')}`
  );
  const presentationSections = kind === 'ppt'
    ? outline.sections.filter((section, index, all) => {
        const heading = section.heading.trim().toLocaleLowerCase();
        if (
          section.pageKind === 'cover' &&
          index === 0 &&
          /^(?:封面|cover|title)$/iu.test(heading)
        ) return false;
        if (
          section.pageKind === 'closing' &&
          index === all.length - 1 &&
          /^(?:谢谢|谢谢观看|感谢观看|thank\s*you)$/iu.test(heading)
        ) return false;
        return true;
      })
    : outline.sections;
  const requiredText = [
    ...(kind === 'excel' ? [] : [outline.title]),
    ...presentationSections.map((section) => section.heading),
    ...(kind === 'excel'
      ? outline.sections.flatMap((section) =>
          section.blocks.flatMap((block) =>
            block.type === 'table' ? block.header : []
          )
        )
      : [])
  ].filter((value) => value.trim().length > 0);
  const excelTitleIsInFileName =
    kind !== 'excel' ||
    path.basename(fileName, path.extname(fileName)).startsWith(
      `${sanitizeFileName(outline.title)}-`
    );
  if (
    !excelTitleIsInFileName ||
    requiredText.length === 0 ||
    requiredText.some(
      (value) => !searchable.includes(normalizeOfficeText(value))
    )
  ) {
    throw new DocumentGenerationError(
      'verification_failed',
      'Generated document is missing required document content'
    );
  }
}

function normalizeOfficeText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, '')
    .toLocaleLowerCase();
}

async function syncFile(target: string): Promise<void> {
  const handle = await open(target, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
