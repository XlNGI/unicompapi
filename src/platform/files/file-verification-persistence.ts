import {
  canTransitionFile,
  transitionFile,
  type FileLocator,
  type FileReference,
  type FileReferenceRepository,
  type FileState,
  type IsoTimestamp
} from '../../domain';
import {
  upsertFileIndexEntry,
  toProjectRelativePath,
  type FileIndexEntry
} from '../storage';
import type { JsonFileIndexRepository } from '../repositories';
import type {
  FileStatusProbe,
  FileStatusProbeResult
} from './file-status-probe';

export type FileRecoveryPersistenceErrorCode =
  | 'user_confirmation_required'
  | 'candidate_not_verified'
  | 'candidate_checksum_mismatch'
  | 'state_transition_rejected'
  | 'index_update_failed';

export class FileRecoveryPersistenceError extends Error {
  constructor(
    readonly code: FileRecoveryPersistenceErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'FileRecoveryPersistenceError';
  }
}

export interface RelinkFileRequest {
  readonly file: FileReference;
  readonly locator: FileLocator;
  readonly confirmedByUser: boolean;
}

export class FileVerificationPersistenceService {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly fileRepository: FileReferenceRepository,
    private readonly indexRepository: JsonFileIndexRepository,
    private readonly probe: FileStatusProbe,
    private readonly now: () => IsoTimestamp
  ) {}

  persistProbeResult(
    file: FileReference,
    result: FileStatusProbeResult
  ): Promise<FileReference> {
    return this.enqueue(() => this.persist(file, result));
  }

  relink(request: RelinkFileRequest): Promise<FileReference> {
    return this.enqueue(async () => {
      if (!request.confirmedByUser) {
        throw new FileRecoveryPersistenceError(
          'user_confirmation_required',
          'Relink requires explicit user confirmation'
        );
      }

      const candidate: FileReference = {
        ...request.file,
        locator: request.locator,
        state: 'pending',
        updatedAt: this.now(),
        lastVerification: undefined
      };
      const result = await this.probe.inspect(candidate, {
        expectedChecksum: request.file.checksumSha256
      });

      if (
        request.file.checksumSha256 &&
        result.verification?.matchesExpected === false
      ) {
        throw new FileRecoveryPersistenceError(
          'candidate_checksum_mismatch',
          'Relink candidate does not match the original verification evidence'
        );
      }

      if (!result.verification || result.recommendedState !== 'available') {
        throw new FileRecoveryPersistenceError(
          'candidate_not_verified',
          'Relink candidate is not locally available and verified'
        );
      }

      return this.persist(candidate, result);
    });
  }

  private async persist(
    file: FileReference,
    result: FileStatusProbeResult
  ): Promise<FileReference> {
    const updated = this.applyProbeResult(file, result);
    let indexEntry: FileIndexEntry | undefined;

    if (updated.locator.kind === 'project') {
      const relativePath = toProjectRelativePath(updated.locator.relativePath);
      const index = await this.indexRepository.load();
      const pathOwner = index.entries.find(
        (entry) =>
          entry.relativePath === relativePath && entry.fileId !== updated.id
      );
      // Alias material records may point at a path already owned by the
      // canonical work-result file. Keep verifying the alias bytes, but never
      // steal or conflict with the indexed owner.
      if (!pathOwner) {
        indexEntry = {
          fileId: updated.id,
          relativePath,
          state: updated.state,
          sizeBytes: updated.sizeBytes,
          checksumSha256: updated.checksumSha256,
          updatedAt: updated.updatedAt
        };
        upsertFileIndexEntry(index, indexEntry);
      }
    }

    await this.fileRepository.save(updated);

    if (indexEntry) {
      try {
        await this.indexRepository.upsert(indexEntry);
      } catch {
        throw new FileRecoveryPersistenceError(
          'index_update_failed',
          'File verification was saved but the derived index update failed'
        );
      }
    }

    return updated;
  }

  private applyProbeResult(
    file: FileReference,
    result: FileStatusProbeResult
  ): FileReference {
    const observedAt = result.verification?.verifiedAt ?? this.now();
    const updatedAt = observedAt < file.updatedAt ? file.updatedAt : observedAt;
    let updated = this.transitionToState(
      file,
      result.recommendedState,
      updatedAt,
      result
    );

    if (result.verification) {
      const canReplaceBaseline =
        file.checksumSha256 === undefined ||
        result.verification.matchesExpected === true;

      updated = {
        ...updated,
        sizeBytes: canReplaceBaseline
          ? result.verification.sizeBytes
          : file.sizeBytes,
        checksumSha256: canReplaceBaseline
          ? result.verification.checksumSha256
          : file.checksumSha256,
        lastVerification: {
          ...result.verification
        }
      };
    }

    return updated;
  }

  private transitionToState(
    file: FileReference,
    state: FileState,
    updatedAt: IsoTimestamp,
    result: FileStatusProbeResult
  ): FileReference {
    if (file.state === state) {
      return { ...file, updatedAt };
    }

    if (state === 'available' && result.verification) {
      let current = file;

      if (current.state === 'corrupted') {
        current = transitionFile(current, 'writing', updatedAt);
      }

      if (current.state !== 'verifying') {
        if (!canTransitionFile(current.state, 'verifying')) {
          throw new FileRecoveryPersistenceError(
            'state_transition_rejected',
            `Cannot verify file from ${current.state} state`
          );
        }

        current = transitionFile(current, 'verifying', updatedAt);
      }

      return transitionFile(current, 'available', updatedAt, {
        sizeBytes: result.verification.sizeBytes,
        checksumSha256: result.verification.checksumSha256
      });
    }

    if (
      file.state === 'corrupted' &&
      canTransitionFile('corrupted', 'writing') &&
      canTransitionFile('writing', state)
    ) {
      const writing = transitionFile(file, 'writing', updatedAt);
      return transitionFile(writing, state, updatedAt);
    }

    if (!canTransitionFile(file.state, state)) {
      if (
        (state === 'corrupted' || state === 'read_only') &&
        canTransitionFile(file.state, 'verifying') &&
        canTransitionFile('verifying', state)
      ) {
        const verifying = transitionFile(file, 'verifying', updatedAt);
        return transitionFile(verifying, state, updatedAt);
      }

      throw new FileRecoveryPersistenceError(
        'state_transition_rejected',
        `Cannot persist ${state} from ${file.state} state`
      );
    }

    return transitionFile(file, state, updatedAt);
  }

  private enqueue<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
