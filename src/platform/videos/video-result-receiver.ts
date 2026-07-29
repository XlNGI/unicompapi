import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
  VideoSubmissionErrorCode,
  VideoSubmissionResult,
  VideoWorkRegisteredDto
} from '../../shared/video-submission-ipc';
import {
  NodeSha256FileVerifier,
  NodeVideoInspector,
  VideoInspectionError,
  type VideoInspection,
  type VideoInspector
} from '../files';
import type { VideoWorkspaceMutationCoordinator } from '../ipc/video-workspace-mutations';
import type { StorageProjectSession } from '../ipc/storage-ipc-controller';
import {
  JsonExecutionRepository,
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  JsonTaskRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage, toProjectRelativePath } from '../storage';
import {
  VideoResultPortError,
  type VideoRemoteResultDescriptor,
  type VideoResultPort
} from './video-result-port';

export interface LocalVideoResultReceiverDependencies {
  getSession(): StorageProjectSession | undefined;
  port: VideoResultPort;
  mutations: VideoWorkspaceMutationCoordinator;
  videoInspector?: VideoInspector;
  createFileId?(): string;
  createWorkId?(): string;
  now?(): string;
  maximumResultBytes?: number;
  onError?(error: unknown): void;
}

interface ResultCandidate {
  readonly descriptor: VideoRemoteResultDescriptor;
  readonly fileId: ReturnType<typeof toFileReferenceId>;
  readonly workId: ReturnType<typeof toWorkId>;
  readonly createdAt: IsoTimestamp;
  readonly inspection: VideoInspection;
  readonly checksumSha256: string;
  temporaryPath?: string;
  finalPath?: string;
  relativePath?: ReturnType<typeof toProjectRelativePath>;
  availableFile?: FileReference;
  fileRecorded: boolean;
}

export class LocalVideoResultReceiver {
  private readonly videoInspector: VideoInspector;
  private readonly maximumResultBytes: number;

  constructor(
    private readonly dependencies: LocalVideoResultReceiverDependencies
  ) {
    this.videoInspector = dependencies.videoInspector ?? new NodeVideoInspector();
    this.maximumResultBytes = dependencies.maximumResultBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumResultBytes) || this.maximumResultBytes < 1) {
      throw new TypeError('maximum video result bytes must be a positive integer');
    }
  }

  receive(
    executionId: string
  ): Promise<VideoSubmissionResult<VideoWorkRegisteredDto>> {
    return this.dependencies.mutations.enqueue(async () => {
      let context: ReturnType<LocalVideoResultReceiver['createContext']>;
      let execution: Execution | undefined;
      const candidates: ResultCandidate[] = [];

      try {
        context = this.createContext();
        execution = await context.executionRepository.get(
          toExecutionId(executionId)
        );
        if (!execution) {
          throw receiverError('execution_not_found', 'Execution not found');
        }
        if (
          (execution.state !== 'queued' && execution.state !== 'processing') ||
          !execution.remoteOperationId
        ) {
          throw receiverError(
            'invalid_execution_state',
            'Execution does not have a receivable remote video result'
          );
        }

        const task = await context.taskRepository.get(execution.taskId);
        if (!task?.submission.video) {
          throw receiverError('task_not_found', 'Video task not found');
        }
        const remoteOperationId = execution.remoteOperationId;
        const completion = await this.getCompletion(remoteOperationId);
        if (!completion || completion.state !== 'completed') {
          throw receiverError(
            'invalid_execution_state',
            'Remote video generation is not complete'
          );
        }
        const descriptors = await this.listResults(remoteOperationId);
        validateDescriptors(descriptors);

        if (execution.state === 'queued') {
          const processing = transitionExecution(
            execution,
            'processing',
            this.now()
          );
          await context.executionRepository.save(processing);
          execution = processing;
        }
        const remoteCompleted = transitionExecution(
          execution,
          'remote_completed',
          this.now()
        );
        await context.executionRepository.save(remoteCompleted);
        execution = remoteCompleted;
        const downloading = transitionExecution(
          execution,
          'downloading',
          this.now()
        );
        await context.executionRepository.save(downloading);
        execution = downloading;

        for (const descriptor of descriptors) {
          candidates.push(
            await this.downloadAndInspect(
              descriptor,
              remoteOperationId,
              execution.id,
              context.session
            )
          );
        }
        assertUniqueLocalIds(candidates);
        for (const candidate of candidates) {
          if (
            (await context.fileRepository.get(candidate.fileId)) ||
            (await context.workRepository.get(candidate.workId))
          ) {
            throw receiverError(
              'result_registration_failed',
              'Video result identifiers already exist'
            );
          }
        }

        const writing = transitionExecution(execution, 'writing', this.now());
        await context.executionRepository.save(writing);
        execution = writing;
        for (const candidate of candidates) {
          await this.persistCandidate(candidate, context.session.rootDirectory);
        }

        const verifying = transitionExecution(execution, 'verifying', this.now());
        await context.executionRepository.save(verifying);
        execution = verifying;
        for (const candidate of candidates) {
          const availableFile = await this.verifyPersistedCandidate(
            candidate,
            context.session,
            execution.id
          );
          await context.fileRepository.save(availableFile);
          candidate.fileRecorded = true;
          await context.indexRepository.upsert({
            fileId: availableFile.id,
            relativePath: candidate.relativePath!,
            state: availableFile.state,
            sizeBytes: availableFile.sizeBytes,
            checksumSha256: availableFile.checksumSha256,
            updatedAt: availableFile.updatedAt
          });
          candidate.availableFile = availableFile;
        }

        const completed = transitionExecution(execution, 'completed', this.now());
        await context.executionRepository.save(completed);
        execution = completed;

        const works = candidates.map((candidate) => {
          if (!candidate.availableFile) {
            throw receiverError(
              'result_registration_failed',
              'A verified video file record is missing'
            );
          }
          try {
            return registerWork({
              id: candidate.workId,
              task,
              execution: completed,
              file: candidate.availableFile,
              mediaKind: 'video',
              name: safeDisplayName(candidate.descriptor.name),
              createdAt: this.now()
            });
          } catch {
            throw receiverError(
              'result_registration_failed',
              'The verified video result could not be registered'
            );
          }
        });
        for (const work of works) {
          try {
            await context.workRepository.save(work);
          } catch {
            throw receiverError(
              'result_registration_failed',
              'The verified video work could not be saved'
            );
          }
        }

        return {
          ok: true,
          value: {
            executionId: completed.id,
            works: works.map((work) => ({ workId: work.id, name: work.name }))
          }
        };
      } catch (error) {
        this.dependencies.onError?.(error);
        if (execution && canFailExecution(execution)) {
          try {
            const failure = transitionExecution(execution, 'failed', this.now(), {
              failure: {
                stage: execution.state,
                message: 'The video result could not be saved and verified',
                retryability: retryabilityForError(error)
              }
            });
            const failureContext = this.createContext();
            await failureContext.executionRepository.save(failure);
          } catch {
            // Preserve the original failure response if failure persistence fails.
          }
        }
        return { ok: false, error: mapReceiverError(error) };
      } finally {
        await Promise.allSettled(
          candidates.flatMap((candidate) => {
            const removals: Promise<void>[] = [];
            if (candidate.temporaryPath) {
              removals.push(rm(candidate.temporaryPath, { force: true }));
            }
            if (candidate.finalPath && !candidate.fileRecorded) {
              removals.push(rm(candidate.finalPath, { force: true }));
            }
            return removals;
          })
        );
      }
    });
  }

  private async getCompletion(remoteOperationId: string) {
    try {
      return await this.dependencies.port.getCompletion(remoteOperationId);
    } catch (error) {
      throw receiverError(
        'result_discovery_failed',
        'The remote completion fact could not be read',
        portRetryability(error)
      );
    }
  }

  private async listResults(remoteOperationId: string) {
    try {
      return await this.dependencies.port.listResults(remoteOperationId);
    } catch (error) {
      throw receiverError(
        'result_discovery_failed',
        'The remote video results could not be discovered',
        portRetryability(error)
      );
    }
  }

  private async downloadAndInspect(
    descriptor: VideoRemoteResultDescriptor,
    remoteOperationId: string,
    executionId: ReturnType<typeof toExecutionId>,
    session: StorageProjectSession
  ): Promise<ResultCandidate> {
    const temporaryPath = path.join(
      session.rootDirectory,
      'tmp',
      `video-result-${randomUUID()}.download`
    );
    await mkdir(path.dirname(temporaryPath), { recursive: true });
    try {
      const source = await this.dependencies.port.openDownload(
        remoteOperationId,
        descriptor.remoteResultId
      );
      await pipeline(
        source,
        expectedByteLimit(
          descriptor.expectedSizeBytes ?? this.maximumResultBytes
        ),
        createWriteStream(temporaryPath, { flags: 'wx' })
      );
    } catch (error) {
      await rm(temporaryPath, { force: true });
      if (error instanceof VideoResultReceiverError) throw error;
      throw receiverError(
        'download_failed',
        'The remote video result could not be downloaded',
        portRetryability(error)
      );
    }

    try {
      await syncFile(temporaryPath);
      const metadata = await lstat(temporaryPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw receiverError(
          'result_verification_failed',
          'Downloaded video result is not a regular file'
        );
      }

      let inspection: VideoInspection;
      try {
        inspection = await this.videoInspector.inspect(temporaryPath);
      } catch (error) {
        if (error instanceof VideoInspectionError) {
          throw receiverError(
            'result_verification_failed',
            'Downloaded video result failed trusted media inspection'
          );
        }
        throw error;
      }
      const createdAt = this.now();
      const provisional = createFileReference({
        id: this.createFileId(),
        projectId: session.projectId,
        sourceExecutionId: executionId,
        locator: { kind: 'external', absolutePath: temporaryPath },
        createdAt
      });
      const verification = await new NodeSha256FileVerifier(
        session.rootDirectory
      ).verify({ file: provisional });
      assertExpectedResult(descriptor, inspection, verification);

      return {
        descriptor,
        fileId: provisional.id,
        workId: this.createWorkId(),
        createdAt,
        inspection,
        checksumSha256: verification.checksumSha256,
        temporaryPath,
        fileRecorded: false
      };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async persistCandidate(
    candidate: ResultCandidate,
    rootDirectory: string
  ): Promise<void> {
    if (!candidate.temporaryPath) {
      throw receiverError(
        'submission_storage_error',
        'Temporary video result is missing'
      );
    }
    const relativePath = toProjectRelativePath(
      `files/results/${candidate.workId}.${extensionForInspection(candidate.inspection)}`
    );
    const finalPath = path.join(rootDirectory, relativePath);
    await mkdir(path.dirname(finalPath), { recursive: true });
    await link(candidate.temporaryPath, finalPath);
    candidate.finalPath = finalPath;
    candidate.relativePath = relativePath;
    await rm(candidate.temporaryPath, { force: true });
    candidate.temporaryPath = undefined;
  }

  private async verifyPersistedCandidate(
    candidate: ResultCandidate,
    session: StorageProjectSession,
    executionId: ReturnType<typeof toExecutionId>
  ): Promise<FileReference> {
    if (!candidate.relativePath) {
      throw receiverError(
        'submission_storage_error',
        'Persisted video result path is missing'
      );
    }
    const projectFile = createFileReference({
      id: candidate.fileId,
      projectId: session.projectId,
      sourceExecutionId: executionId,
      locator: { kind: 'project', relativePath: candidate.relativePath },
      createdAt: candidate.createdAt
    });
    const writingFile = transitionFile(projectFile, 'writing', this.now());
    const verifyingFile = transitionFile(writingFile, 'verifying', this.now());
    let finalInspection: VideoInspection;
    try {
      finalInspection = await this.videoInspector.inspect(
        candidate.finalPath ??
          path.join(session.rootDirectory, candidate.relativePath)
      );
    } catch (error) {
      if (error instanceof VideoInspectionError) {
        throw receiverError(
          'result_verification_failed',
          'Persisted video result failed trusted media inspection'
        );
      }
      throw error;
    }
    const finalVerification = await new NodeSha256FileVerifier(
      session.rootDirectory
    ).verify({
      file: verifyingFile,
      expectedChecksum: candidate.checksumSha256
    });
    assertExpectedResult(
      candidate.descriptor,
      finalInspection,
      finalVerification
    );
    if (!finalVerification.matchesExpected) {
      throw receiverError(
        'result_verification_failed',
        'Persisted video result does not match downloaded bytes'
      );
    }
    return {
      ...transitionFile(verifyingFile, 'available', this.now(), {
        sizeBytes: finalVerification.sizeBytes,
        checksumSha256: finalVerification.checksumSha256
      }),
      lastVerification: { ...finalVerification }
    };
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

  private createFileId() {
    return toFileReferenceId(
      this.dependencies.createFileId?.() ?? `file-video-result-${randomUUID()}`
    );
  }

  private createWorkId() {
    return toWorkId(
      this.dependencies.createWorkId?.() ?? `work-video-result-${randomUUID()}`
    );
  }

  private now(): IsoTimestamp {
    return toIsoTimestamp(
      this.dependencies.now?.() ?? new Date().toISOString()
    );
  }
}

class VideoResultReceiverError extends Error {
  constructor(
    readonly code: VideoSubmissionErrorCode,
    message: string,
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown' =
      'not_retryable'
  ) {
    super(message);
    this.name = 'VideoResultReceiverError';
  }
}

function validateDescriptors(
  descriptors: readonly VideoRemoteResultDescriptor[]
): void {
  if (descriptors.length === 0) {
    throw receiverError(
      'result_verification_failed',
      'Remote completion did not declare any video results'
    );
  }
  const ids = new Set<string>();
  for (const descriptor of descriptors) {
    const name = safeDisplayName(descriptor.name);
    if (
      descriptor.remoteResultId.trim().length === 0 ||
      ids.has(descriptor.remoteResultId) ||
      name.length === 0 ||
      name === '.' ||
      name === '..' ||
      (descriptor.declaredMimeType !== undefined &&
        !['video/mp4', 'video/quicktime'].includes(descriptor.declaredMimeType)) ||
      (descriptor.declaredContainer !== undefined &&
        !['mp4', 'quicktime'].includes(descriptor.declaredContainer)) ||
      (descriptor.expectedSizeBytes !== undefined &&
        !isPositiveSafeInteger(descriptor.expectedSizeBytes)) ||
      (descriptor.expectedChecksumSha256 !== undefined &&
        !/^[a-f0-9]{64}$/.test(descriptor.expectedChecksumSha256)) ||
      (descriptor.expectedDurationMs !== undefined &&
        !isPositiveSafeInteger(descriptor.expectedDurationMs)) ||
      (descriptor.expectedWidth !== undefined &&
        !isPositiveSafeInteger(descriptor.expectedWidth)) ||
      (descriptor.expectedHeight !== undefined &&
        !isPositiveSafeInteger(descriptor.expectedHeight))
    ) {
      throw receiverError(
        'result_verification_failed',
        'Remote video result declaration is invalid or incomplete'
      );
    }
    ids.add(descriptor.remoteResultId);
  }
}

function safeDisplayName(value: string): string {
  return path.posix.basename(value.trim().replace(/\\/g, '/'));
}

function expectedByteLimit(expectedSizeBytes: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > expectedSizeBytes) {
        callback(
          receiverError(
            'result_verification_failed',
            'Downloaded video exceeds its declared byte size'
          )
        );
        return;
      }
      callback(null, chunk);
    }
  });
}

function assertExpectedResult(
  descriptor: VideoRemoteResultDescriptor,
  inspection: VideoInspection,
  verification: { readonly checksumSha256: string; readonly sizeBytes: number }
): void {
  if (
    (descriptor.declaredMimeType !== undefined &&
      descriptor.declaredMimeType !== inspection.mimeType) ||
    (descriptor.declaredContainer !== undefined &&
      descriptor.declaredContainer !== inspection.container) ||
    (descriptor.expectedSizeBytes !== undefined &&
      (descriptor.expectedSizeBytes !== inspection.sizeBytes ||
        descriptor.expectedSizeBytes !== verification.sizeBytes)) ||
    (descriptor.expectedChecksumSha256 !== undefined &&
      descriptor.expectedChecksumSha256 !== verification.checksumSha256) ||
    (descriptor.expectedDurationMs !== undefined &&
      descriptor.expectedDurationMs !== inspection.durationMs) ||
    (descriptor.expectedWidth !== undefined &&
      descriptor.expectedWidth !== inspection.width) ||
    (descriptor.expectedHeight !== undefined &&
      descriptor.expectedHeight !== inspection.height)
  ) {
    throw receiverError(
      'result_verification_failed',
      'Downloaded video does not match the remote result declaration'
    );
  }
}

function assertUniqueLocalIds(candidates: readonly ResultCandidate[]): void {
  if (
    new Set(candidates.map((candidate) => candidate.fileId)).size !==
      candidates.length ||
    new Set(candidates.map((candidate) => candidate.workId)).size !==
      candidates.length
  ) {
    throw receiverError(
      'result_registration_failed',
      'Video result identifiers are not unique'
    );
  }
}

function extensionForInspection(inspection: VideoInspection): string {
  return inspection.container === 'quicktime' ? 'mov' : 'mp4';
}

async function syncFile(target: string): Promise<void> {
  const handle = await open(target, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function canFailExecution(execution: Execution): boolean {
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

function portRetryability(
  error: unknown
): 'retryable' | 'not_retryable' | 'unknown' {
  return error instanceof VideoResultPortError
    ? error.retryability
    : 'unknown';
}

function retryabilityForError(
  error: unknown
): 'retryable' | 'not_retryable' | 'unknown' {
  return error instanceof VideoResultReceiverError
    ? error.retryability
    : 'unknown';
}

function receiverError(
  code: VideoSubmissionErrorCode,
  message: string,
  retryability?: 'retryable' | 'not_retryable' | 'unknown'
): VideoResultReceiverError {
  return new VideoResultReceiverError(code, message, retryability);
}

function mapReceiverError(error: unknown): {
  readonly code: VideoSubmissionErrorCode;
  readonly message: string;
} {
  if (error instanceof VideoResultReceiverError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'submission_storage_error',
    message: 'The local video result operation failed'
  };
}
