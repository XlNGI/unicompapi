import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  createFileReference,
  registerWork,
  toExecutionId,
  toFileReferenceId,
  toIsoTimestamp,
  toWorkId,
  transitionExecution,
  transitionFile,
  type Execution,
  type FileReference,
  type IsoTimestamp
} from '../../domain';
import type {
  ImageSubmissionErrorCode,
  ImageSubmissionResult,
  ImageWorkRegisteredDto
} from '../../shared/image-submission-ipc';
import { NodeImageInspector, NodeSha256FileVerifier } from '../files';
import {
  JsonExecutionRepository,
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonWorkRepository
} from '../repositories';
import {
  NodeProjectStorage,
  toProjectRelativePath
} from '../storage';
import type { ImageWorkspaceMutationCoordinator } from '../ipc/image-workspace-mutations';
import type { StorageProjectSession } from '../ipc/storage-ipc-controller';
import type {
  ImageRemoteResultDescriptor,
  ImageResultOperationReference,
  ImageResultPort
} from './image-result-port';
import { ImageResultPortError } from './image-result-port';
import type {
  ImageResultReceiptEvent,
  ImageResultReceiptStage
} from './image-result-receipt-events';

export interface LocalImageResultReceiverDependencies {
  getSession(): StorageProjectSession | undefined;
  port: ImageResultPort;
  mutations: ImageWorkspaceMutationCoordinator;
  createFileId?(): string;
  createWorkId?(): string;
  publishFile?(temporaryPath: string, finalPath: string): Promise<void>;
  now?(): string;
  onError?(error: unknown): void;
  onEvent?(event: ImageResultReceiptEvent): void;
  downloadRetry?: {
    readonly maxAttempts?: number;
    readonly backoffMs?: readonly number[];
    readonly sleep?: (delayMs: number) => Promise<void>;
  };
}

const defaultDownloadRetry = Object.freeze({
  maxAttempts: 3,
  backoffMs: [250, 750] as const
});

export class LocalImageResultReceiver {
  constructor(
    private readonly dependencies: LocalImageResultReceiverDependencies
  ) {}

  receive(
    executionId: string
  ): Promise<ImageSubmissionResult<ImageWorkRegisteredDto>> {
    return this.dependencies.mutations.enqueue(async () => {
      let context: ReturnType<LocalImageResultReceiver['createContext']>;
      let execution: Execution | undefined;
      let temporaryPath: string | undefined;
      let finalPath: string | undefined;
      let finalFileRecorded = false;
      let receiptStage: ImageResultReceiptStage = 'loading_execution';

      try {
        context = this.createContext();
        execution = await context.executionRepository.get(
          toExecutionId(executionId)
        );
        if (!execution) {
          throw receiverError('execution_not_found', 'Execution not found');
        }
        receiptStage = 'loading_descriptor';
        this.emit({
          event: 'receipt_started',
          taskId: execution.taskId,
          executionId: execution.id,
          stage: receiptStage
        });
        const existingWork = (
          await context.workRepository.list(context.session.projectId)
        ).find((work) => work.sourceExecutionId === execution?.id);
        if (existingWork) {
          const existingFile = await context.fileRepository.get(existingWork.fileId);
          if (!existingFile || existingFile.state !== 'available') {
            throw receiverError(
              'result_verification_failed',
              'Registered image work does not have an available file'
            );
          }
          if (execution.state === 'verifying') {
            execution = transitionExecution(execution, 'completed', this.now(), {
              outputFileId: existingFile.id,
              workId: existingWork.id
            });
            await context.executionRepository.save(execution);
          } else if (execution.state !== 'completed') {
            throw receiverError(
              'invalid_execution_state',
              'Registered image work has an incompatible execution state'
            );
          }
          receiptStage = 'registering_work';
          this.emit({
            event: 'work_registered',
            taskId: execution.taskId,
            executionId: execution.id,
            stage: receiptStage
          });
          return {
            ok: true,
            value: {
              workId: existingWork.id,
              executionId: execution.id,
              name: existingWork.name
            }
          };
        }
        const operation = resultOperationForExecution(execution);
        if (!operation) {
          throw receiverError(
            'invalid_execution_state',
            'Execution does not have a completed remote result'
          );
        }
        const task = await context.taskRepository.get(execution.taskId);
        if (!task?.submission.image) {
          throw receiverError('task_not_found', 'Image task not found');
        }
        const descriptor = await this.dependencies.port.getCompletedResult(
          operation
        );
        if (!descriptor) {
          throw receiverError(
            'invalid_execution_state',
            'Remote image result is not complete'
          );
        }
        validateDescriptor(descriptor);
        this.emit({
          event: 'descriptor_loaded',
          taskId: execution.taskId,
          executionId: execution.id,
          stage: receiptStage
        });

        if (execution.state === 'verifying') {
          receiptStage = 'verifying';
          const availableFile = (
            await context.fileRepository.list(context.session.projectId)
          ).find(
            (file) =>
              file.sourceExecutionId === execution?.id &&
              file.state === 'available'
          );
          if (!availableFile || availableFile.locator.kind !== 'project') {
            throw receiverError(
              'result_verification_failed',
              'Verified image result could not be recovered'
            );
          }
          await context.indexRepository.load();
          await context.indexRepository.upsert({
            fileId: availableFile.id,
            relativePath: toProjectRelativePath(
              availableFile.locator.relativePath
            ),
            state: availableFile.state,
            sizeBytes: availableFile.sizeBytes,
            checksumSha256: availableFile.checksumSha256,
            updatedAt: availableFile.updatedAt
          });
          this.emit({
            event: 'verification_completed',
            taskId: execution.taskId,
            executionId: execution.id,
            stage: receiptStage
          });
          receiptStage = 'registering_work';
          const workId = this.createWorkId();
          const completed = transitionExecution(
            execution,
            'completed',
            this.now(),
            { outputFileId: availableFile.id, workId }
          );
          const work = registerWork({
            id: workId,
            task,
            execution: completed,
            file: availableFile,
            mediaKind: 'image',
            name: path.basename(descriptor.name),
            parentWorkId: task.submission.image.parentWorkId,
            createdAt: this.now()
          });
          await context.workRepository.save(work);
          await context.executionRepository.save(completed);
          this.emit({
            event: 'work_registered',
            taskId: execution.taskId,
            executionId: execution.id,
            stage: receiptStage
          });
          return {
            ok: true,
            value: { workId: work.id, executionId: completed.id, name: work.name }
          };
        }

        if (execution.state === 'queued') {
          execution = transitionExecution(execution, 'processing', this.now());
        }
        if (execution.state === 'processing') {
          execution = transitionExecution(
            execution,
            'remote_completed',
            this.now()
          );
          await context.executionRepository.save(execution);
        }
        if (execution.state === 'remote_completed') {
          execution = transitionExecution(execution, 'downloading', this.now());
          await context.executionRepository.save(execution);
        }

        const temporaryName = `${execution.id}-${randomUUID()}.download`;
        temporaryPath = path.join(
          context.session.rootDirectory,
          'tmp',
          temporaryName
        );
        await mkdir(path.dirname(temporaryPath), { recursive: true });
        receiptStage = 'downloading';
        this.emit({
          event: 'download_started',
          taskId: execution.taskId,
          executionId: execution.id,
          stage: receiptStage
        });
        await this.downloadWithRetry(operation, temporaryPath);
        this.emit({
          event: 'download_completed',
          taskId: execution.taskId,
          executionId: execution.id,
          stage: receiptStage
        });

        receiptStage = 'verifying';
        const downloadedMetadata = await lstat(temporaryPath);
        if (!downloadedMetadata.isFile() || downloadedMetadata.isSymbolicLink()) {
          throw receiverError(
            'result_verification_failed',
            'Downloaded result is not a regular file'
          );
        }
        if (downloadedMetadata.size > 20 * 1024 * 1024) {
          throw receiverError(
            'result_verification_failed',
            'Downloaded result exceeds the allowed size'
          );
        }

        const inspection = await new NodeImageInspector().inspect(temporaryPath);
        const provisional = createFileReference({
          id: this.createFileId(),
          projectId: context.session.projectId,
          sourceExecutionId: execution.id,
          locator: { kind: 'external', absolutePath: temporaryPath },
          createdAt: this.now()
        });
        const verification = await new NodeSha256FileVerifier(
          context.session.rootDirectory
        ).verify({ file: provisional });
        assertExpectedResult(descriptor, inspection, verification);

        if (execution.state === 'downloading') {
          execution = transitionExecution(execution, 'writing', this.now());
          await context.executionRepository.save(execution);
        }
        receiptStage = 'writing';
        const workId = this.createWorkId();
        const extension = extensionForMime(inspection.mimeType);
        const relativePath = toProjectRelativePath(
          `files/results/${workId}.${extension}`
        );
        finalPath = path.join(context.session.rootDirectory, relativePath);
        await mkdir(path.dirname(finalPath), { recursive: true });
        await syncFile(temporaryPath);
        await (this.dependencies.publishFile ?? rename)(
          temporaryPath,
          finalPath
        );
        temporaryPath = undefined;

        const projectFile = createFileReference({
          id: provisional.id,
          projectId: context.session.projectId,
          sourceExecutionId: execution.id,
          locator: { kind: 'project', relativePath },
          createdAt: provisional.createdAt
        });
        const writingFile = transitionFile(projectFile, 'writing', this.now());
        const verifyingFile = transitionFile(writingFile, 'verifying', this.now());
        const finalVerification = await new NodeSha256FileVerifier(
          context.session.rootDirectory
        ).verify({
          file: verifyingFile,
          expectedChecksum: verification.checksumSha256
        });
        if (!finalVerification.matchesExpected) {
          throw receiverError(
            'result_verification_failed',
            'Saved image result does not match downloaded bytes'
          );
        }
        receiptStage = 'verifying';
        const availableFile: FileReference = {
          ...transitionFile(verifyingFile, 'available', this.now(), {
            sizeBytes: finalVerification.sizeBytes,
            checksumSha256: finalVerification.checksumSha256
          }),
          lastVerification: { ...finalVerification }
        };
        this.emit({
          event: 'verification_completed',
          taskId: execution.taskId,
          executionId: execution.id,
          stage: receiptStage
        });

        receiptStage = 'registering_work';
        execution = transitionExecution(execution, 'verifying', this.now());
        await context.executionRepository.save(execution);
        await context.indexRepository.load();
        await context.fileRepository.save(availableFile);
        finalFileRecorded = true;
        await context.indexRepository.upsert({
          fileId: availableFile.id,
          relativePath,
          state: availableFile.state,
          sizeBytes: availableFile.sizeBytes,
          checksumSha256: availableFile.checksumSha256,
          updatedAt: availableFile.updatedAt
        });
        const workIdForCompletion = workId;
        const completed = transitionExecution(execution, 'completed', this.now(), {
          outputFileId: availableFile.id,
          workId: workIdForCompletion
        });
        const work = registerWork({
          id: workIdForCompletion,
          task,
          execution: completed,
          file: availableFile,
          mediaKind: 'image',
          name: path.basename(descriptor.name),
          parentWorkId: task.submission.image.parentWorkId,
          createdAt: this.now()
        });
        await context.workRepository.save(work);
        await context.executionRepository.save(completed);
        execution = completed;
        this.emit({
          event: 'work_registered',
          taskId: execution.taskId,
          executionId: execution.id,
          stage: receiptStage
        });
        finalPath = undefined;
        return {
          ok: true,
          value: {
            workId: work.id,
            executionId: execution.id,
            name: work.name
          }
        };
      } catch (error) {
        try {
          this.dependencies.onError?.(error);
        } catch {
          // Diagnostics must not replace the receipt failure.
        }
        if (execution && canFailExecution(execution, finalFileRecorded)) {
          try {
            const failure = transitionExecution(execution, 'failed', this.now(), {
              failure: {
                stage: execution.state,
                message: 'The image result could not be saved and verified',
                retryability: retryabilityForError(error)
              }
            });
            const failureContext = this.createContext();
            await failureContext.executionRepository.save(failure);
          } catch {
            // Preserve the original failure response if failure persistence also fails.
          }
        }
        const mapped = mapReceiverError(error);
        this.emit({
          event: 'receipt_failed',
          taskId: execution?.taskId,
          executionId,
          stage: receiptStage,
          safeCode: mapped.code,
          retryability: retryabilityForError(error)
        });
        return { ok: false, error: mapped };
      } finally {
        if (temporaryPath) await rm(temporaryPath, { force: true });
        if (finalPath && !finalFileRecorded) {
          await rm(finalPath, { force: true });
        }
      }
    });
  }

  private createContext() {
    const session = this.dependencies.getSession();
    if (!session) {
      throw receiverError('project_not_open', 'No project is currently open');
    }
    const storage = new NodeProjectStorage(session.rootDirectory);
    return {
      session,
      taskRepository: new JsonTaskRepository(storage, session.projectId),
      executionRepository: new JsonExecutionRepository(storage),
      fileRepository: new JsonFileReferenceRepository(storage, session.projectId),
      indexRepository: new JsonFileIndexRepository(storage, session.projectId),
      workRepository: new JsonWorkRepository(storage, session.projectId)
    };
  }

  private async downloadWithRetry(
    operation: ImageResultOperationReference,
    destinationPath: string
  ): Promise<void> {
    const configured = this.dependencies.downloadRetry;
    const maxAttempts = Math.max(
      1,
      Math.min(5, configured?.maxAttempts ?? defaultDownloadRetry.maxAttempts)
    );
    const backoffMs = configured?.backoffMs ?? defaultDownloadRetry.backoffMs;
    const sleep = configured?.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    }));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await rm(destinationPath, { force: true });
      try {
        await this.dependencies.port.download(operation, destinationPath);
        return;
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableDownloadError(error)) {
          throw error;
        }
        const delayMs = Math.max(0, backoffMs[attempt - 1] ?? backoffMs.at(-1) ?? 0);
        if (delayMs > 0) await sleep(delayMs);
      }
    }
  }

  private createFileId() {
    return toFileReferenceId(
      this.dependencies.createFileId?.() ?? `file-result-${randomUUID()}`
    );
  }

  private emit(
    event: Omit<ImageResultReceiptEvent, 'occurredAt'>
  ): void {
    try {
      this.dependencies.onEvent?.(Object.freeze({
        ...event,
        occurredAt: this.now()
      }));
    } catch {
      // Receipt diagnostics are best effort and never affect the main flow.
    }
  }

  private createWorkId() {
    return toWorkId(
      this.dependencies.createWorkId?.() ?? `work-result-${randomUUID()}`
    );
  }

  private now(): IsoTimestamp {
    return toIsoTimestamp(
      this.dependencies.now?.() ?? new Date().toISOString()
    );
  }
}

function resultOperationForExecution(
  execution: Execution
): ImageResultOperationReference | undefined {
  if (
    ['remote_completed', 'downloading', 'writing', 'verifying'].includes(
      execution.state
    ) &&
    execution.submissionOutcome === 'completed_sync' &&
    execution.providerOperationRecordId
  ) {
    return {
      kind: 'provider_operation_record',
      id: execution.providerOperationRecordId
    };
  }
  if (
    (execution.state === 'queued' || execution.state === 'processing') &&
    execution.remoteOperationId
  ) {
    return { kind: 'remote_operation', id: execution.remoteOperationId };
  }
  return undefined;
}

class ImageResultReceiverError extends Error {
  constructor(
    readonly code: ImageSubmissionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ImageResultReceiverError';
  }
}

function validateDescriptor(descriptor: ImageRemoteResultDescriptor): void {
  const displayName = path.basename(descriptor.name.trim());
  if (
    displayName.length === 0 ||
    displayName === '.' ||
    displayName === '..'
  ) {
    throw receiverError('result_verification_failed', 'Result name is invalid');
  }
  if (
    descriptor.expectedSizeBytes !== undefined &&
    (!Number.isSafeInteger(descriptor.expectedSizeBytes) ||
      descriptor.expectedSizeBytes < 0)
  ) {
    throw receiverError('result_verification_failed', 'Result size is invalid');
  }
  if (
    descriptor.expectedChecksumSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(descriptor.expectedChecksumSha256)
  ) {
    throw receiverError('result_verification_failed', 'Result checksum is invalid');
  }
}

function assertExpectedResult(
  descriptor: ImageRemoteResultDescriptor,
  inspection: { readonly mimeType: string; readonly sizeBytes: number },
  verification: { readonly checksumSha256: string; readonly sizeBytes: number }
): void {
  if (
    descriptor.declaredMimeType !== undefined &&
    descriptor.declaredMimeType !== inspection.mimeType
  ) {
    throw receiverError('result_verification_failed', 'Result type does not match');
  }
  if (
    descriptor.expectedSizeBytes !== undefined &&
    descriptor.expectedSizeBytes !== verification.sizeBytes
  ) {
    throw receiverError('result_verification_failed', 'Result size does not match');
  }
  if (
    descriptor.expectedChecksumSha256 !== undefined &&
    descriptor.expectedChecksumSha256 !== verification.checksumSha256
  ) {
    throw receiverError(
      'result_verification_failed',
      'Result checksum does not match'
    );
  }
}

function extensionForMime(mimeType: string): string {
  const extensions: Readonly<Record<string, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp'
  };
  const extension = extensions[mimeType];
  if (!extension) {
    throw receiverError(
      'result_verification_failed',
      'Result image type cannot be stored safely'
    );
  }
  return extension;
}

async function syncFile(target: string): Promise<void> {
  const handle = await open(target, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function canFailExecution(
  execution: Execution,
  verifiedFileRecorded: boolean
): boolean {
  if (verifiedFileRecorded && execution.state === 'verifying') return false;
  return [
    'submitting',
    'queued',
    'processing',
    'remote_completed',
    'downloading',
    'writing',
    'verifying'
  ].includes(execution.state);
}

function retryabilityForError(
  error: unknown
): 'retryable' | 'not_retryable' | 'unknown' {
  if (error instanceof ImageResultReceiverError) {
    return error.code === 'download_failed' ? 'retryable' : 'not_retryable';
  }
  if (error instanceof ImageResultPortError) return error.retryability;
  return 'unknown';
}

function isRetryableDownloadError(error: unknown): boolean {
  return error instanceof ImageResultPortError && error.retryability === 'retryable';
}

function receiverError(
  code: ImageSubmissionErrorCode,
  message: string
): ImageResultReceiverError {
  return new ImageResultReceiverError(code, message);
}

function mapReceiverError(error: unknown): {
  readonly code: ImageSubmissionErrorCode;
  readonly message: string;
} {
  if (error instanceof ImageResultReceiverError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'download_failed',
    message: 'The image result could not be downloaded and verified'
  };
}
