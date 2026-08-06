import type { ParameterValue } from '../../domain';
import type {
  ImagePromptEnhanceCandidateDto,
  ImagePromptEnhanceIpcErrorCode,
  ImagePromptEnhanceIpcResult,
  ImagePromptEnhancePreparationDto,
  ImagePromptEnhanceSubmissionDto
} from '../../shared/image-prompt-enhance-ipc';
import {
  imagePromptEnhanceRequestParsers
} from '../../shared/image-prompt-enhance-ipc';
import {
  ImagePromptEnhanceError,
  type ImagePromptEnhanceService
} from '../providers/image-prompt-enhance-submission';
import type { StorageProjectSession } from './storage-ipc-controller';

export interface ImagePromptEnhanceControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  getService(session: StorageProjectSession): ImagePromptEnhanceService | undefined;
  onError?(error: unknown): void;
}

export class ImagePromptEnhanceController {
  private readonly operations = new Set<Promise<unknown>>();

  constructor(private readonly dependencies: ImagePromptEnhanceControllerDependencies) {}

  listCandidates(
    request: unknown
  ): Promise<ImagePromptEnhanceIpcResult<readonly ImagePromptEnhanceCandidateDto[]>> {
    return this.execute(async () => {
      const input = imagePromptEnhanceRequestParsers.listCandidates(request);
      const service = this.requireService();
      return { ok: true, value: await service.listCandidates(input.productFeature) };
    });
  }

  prepare(
    request: unknown
  ): Promise<ImagePromptEnhanceIpcResult<ImagePromptEnhancePreparationDto>> {
    return this.execute(async () => {
      const input = imagePromptEnhanceRequestParsers.prepare(request);
      const service = this.requireService();
      return {
        ok: true,
        value: await service.prepare({
          ...input,
          parameterValues: input.parameterValues as Readonly<Record<string, ParameterValue>>
        })
      };
    });
  }

  submit(
    request: unknown
  ): Promise<ImagePromptEnhanceIpcResult<ImagePromptEnhanceSubmissionDto>> {
    return this.execute(async () => {
      const input = imagePromptEnhanceRequestParsers.submit(request);
      const service = this.requireService();
      return { ok: true, value: await service.submit(input) };
    });
  }

  async waitForOperations(): Promise<void> {
    await Promise.all([...this.operations]);
  }

  private requireService(): ImagePromptEnhanceService {
    const session = this.dependencies.getSession();
    if (!session) {
      throw new ImagePromptEnhanceError('project_not_open', 'A project must be open');
    }
    const service = this.dependencies.getService(session);
    if (!service) {
      throw new ImagePromptEnhanceError(
        'runtime_not_allowed',
        'Prompt enhance runtime is unavailable'
      );
    }
    return service;
  }

  private execute<T>(
    operation: () => Promise<ImagePromptEnhanceIpcResult<T>>
  ): Promise<ImagePromptEnhanceIpcResult<T>> {
    let task!: Promise<ImagePromptEnhanceIpcResult<T>>;
    task = operation()
      .catch((error: unknown): ImagePromptEnhanceIpcResult<T> => {
        if (error instanceof ImagePromptEnhanceError) {
          return failure(error.code, error.message);
        }
        if (error instanceof TypeError) {
          return failure('invalid_request', error.message);
        }
        this.dependencies.onError?.(error);
        return failure(
          'storage_error',
          error instanceof Error ? error.message : 'Prompt enhance failed'
        );
      })
      .finally(() => {
        this.operations.delete(task);
      });
    this.operations.add(task);
    return task;
  }
}

function failure(
  code: ImagePromptEnhanceIpcErrorCode,
  message: string
): ImagePromptEnhanceIpcResult<never> {
  return { ok: false, error: { code, message } };
}
