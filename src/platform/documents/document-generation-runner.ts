import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  addExecutionToTask,
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
import { FileVerificationPersistenceService, NodeFileStatusProbe } from '../files';
import {
  JsonExecutionRepository,
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage, toProjectRelativePath } from '../storage';
import { generateDocumentFile } from './office-document-generator';
import type { DocumentOutline } from './document-outline-parser';

export type DocumentGenerationErrorCode =
  | 'invalid_plan'
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

export class DocumentGenerationRunner {
  constructor(
    private readonly options: {
      readonly rootDirectory: string;
      readonly projectId: ProjectId;
      readonly now?: () => string;
      readonly createId?: () => string;
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
      const generated = await generateDocumentFile({
        kind: input.kind,
        outline: input.outline,
        outputDirectory,
        now: now()
      });
      execution = await this.move(context, execution, 'verifying_file');
      const file = await this.registerVerifiedOutput(
        context,
        execution,
        generated.fileName
      );
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
      if (execution) {
        const current = (await context.executions.get(execution.id)) ?? execution;
        if (!['completed', 'cancelled', 'failed'].includes(current.state)) {
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
      throw error;
    }
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
    fileName: string
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
    await context.files.save(file);
    const probe = new NodeFileStatusProbe(this.options.rootDirectory);
    const persistence = new FileVerificationPersistenceService(
      context.files,
      context.fileIndex,
      probe,
      () => toIsoTimestamp(now())
    );
    const result = await probe.inspect(file);
    file = await persistence.persistProbeResult(file, result);
    if (file.state !== 'available' || !file.checksumSha256 || file.sizeBytes === undefined) {
      throw new DocumentGenerationError(
        'verification_failed',
        'Generated document did not pass local verification'
      );
    }
    return file;
  }
}
