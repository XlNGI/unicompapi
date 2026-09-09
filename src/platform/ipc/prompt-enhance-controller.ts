import type { ParameterValue } from '../../domain';
import type {
  PromptEnhanceCandidateDto,
  PromptEnhanceIpcErrorCode,
  PromptEnhanceIpcResult,
  PromptEnhancePreparationDto,
  PromptEnhanceSubmissionDto
} from '../../shared/prompt-enhance-ipc';
import {
  promptEnhanceRequestParsers
} from '../../shared/prompt-enhance-ipc';
import {
  PromptEnhanceError,
  type PromptEnhanceService
} from '../providers/prompt-enhance-submission';
import type { StorageProjectSession } from './storage-ipc-controller';

export interface PromptEnhanceControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  getService(session: StorageProjectSession): PromptEnhanceService | undefined;
  onError?(error: unknown): void;
}

export class PromptEnhanceController {
  private readonly operations = new Set<Promise<unknown>>();

  constructor(private readonly dependencies: PromptEnhanceControllerDependencies) {}

  listCandidates(
    request: unknown
  ): Promise<PromptEnhanceIpcResult<readonly PromptEnhanceCandidateDto[]>> {
    return this.execute(async () => {
      const input = promptEnhanceRequestParsers.listCandidates(request);
      const service = this.requireService();
      return { ok: true, value: await service.listCandidates(input.productFeature) };
    });
  }

  prepare(
    request: unknown
  ): Promise<PromptEnhanceIpcResult<PromptEnhancePreparationDto>> {
    return this.execute(async () => {
      const input = promptEnhanceRequestParsers.prepare(request);
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
  ): Promise<PromptEnhanceIpcResult<PromptEnhanceSubmissionDto>> {
    return this.execute(async () => {
      const input = promptEnhanceRequestParsers.submit(request);
      const service = this.requireService();
      return { ok: true, value: await service.submit(input) };
    });
  }

  async waitForOperations(): Promise<void> {
    await Promise.all([...this.operations]);
  }

  private requireService(): PromptEnhanceService {
    const session = this.dependencies.getSession();
    if (!session) {
      throw new PromptEnhanceError('project_not_open', 'A project must be open');
    }
    const service = this.dependencies.getService(session);
    if (!service) {
      throw new PromptEnhanceError(
        'runtime_not_allowed',
        'Prompt enhance runtime is unavailable'
      );
    }
    return service;
  }

  private execute<T>(
    operation: () => Promise<PromptEnhanceIpcResult<T>>
  ): Promise<PromptEnhanceIpcResult<T>> {
    let task!: Promise<PromptEnhanceIpcResult<T>>;
    task = operation()
      .catch((error: unknown): PromptEnhanceIpcResult<T> => {
        if (error instanceof PromptEnhanceError) {
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
  code: PromptEnhanceIpcErrorCode,
  message: string
): PromptEnhanceIpcResult<never> {
  return { ok: false, error: { code, message } };
}
