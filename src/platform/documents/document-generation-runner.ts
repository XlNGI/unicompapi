import { randomUUID } from 'node:crypto';
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

export type DocumentGenerationErrorCode =
  | 'invalid_plan'
  | 'cancelled'
  | 'generation_failed'
  | 'verification_failed'
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
  readonly revisionTargetSectionHeading?: string;
  readonly revisionPatch?: DocumentRevisionPatch;
  readonly revisionPatches?: readonly DocumentRevisionPatch[];
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
              buffer: await readFile(revisionSource.revisionSourcePath),
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
      await this.assertTemporaryOutput(generated, input.kind, input.outline);
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
      }
      const temporaryVerification = await this.verifyTemporaryOutput(
        execution,
        generated,
        input.signal
      );
      this.assertNotCancelled(input.signal);
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
        work
      };
    } catch (error) {
      const cancelled =
        input.signal?.aborted === true ||
        (error instanceof DocumentGenerationError && error.code === 'cancelled') ||
        (error instanceof FileVerificationError && error.code === 'aborted');
      if (file && !workRegistered) {
        await this.removeRegisteredOutput(context, file);
      }
      if (execution) {
        const current = (await context.executions.get(execution.id)) ?? execution;
        if (!['completed', 'cancelled', 'failed'].includes(current.state)) {
          if (cancelled) {
            await this.persistCancelledExecution(context, current);
          } else {
            await context.executions.save(
              transitionExecution(current, 'failed', toIsoTimestamp(now()), {
                failure: {
                  stage: current.state,
                  message: error instanceof Error ? error.message : String(error),
                  retryability:
                    error instanceof DocumentGenerationError &&
                    error.code === 'generation_failed'
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
      throw error;
    } finally {
      if (temporaryPath) await rm(temporaryPath, { force: true });
      if (finalPath && !workRegistered) {
        await rm(finalPath, { force: true });
      }
    }
  }

  private async resolveRevisionSource(
    context: RunnerContext,
    input: DocumentGenerationPlanInput
  ): Promise<{
    readonly revisionSourcePath?: string;
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
      return {
        revisionSourcePath: sourcePath,
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
    outline: DocumentOutline
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
          throw new DocumentGenerationError('verification_failed', 'Scoped document revision page target was not found');
        }
        targetIndexes.add(pageIndex);
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
