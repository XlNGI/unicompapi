import {
  toDraftId,
  type DynamicParameterValue,
  type FeatureCandidateSubjectV1,
  type ImageWorkspaceDraft,
  type ImageWorkspaceRepository,
  type SubmissionUserConfirmationV1
} from '../../domain';
import type {
  ImageFeatureCandidateDto,
  ImageFeatureGenerateQuickDto,
  ImageFeatureIpcErrorCode,
  ImageFeatureIpcResult,
  ImageFeaturePreparationDto,
  ImageFeatureRecoveryDto,
  ImageFeatureSubmissionDto
} from '../../shared/image-feature-ipc';
import {
  FeatureSubmissionError,
  imageDraftRevision,
  SubmissionOrchestrationError,
  type ProviderFeatureCandidateService
} from '../providers';
import type { ImageWorkspaceMutationCoordinator } from './image-workspace-mutations';
import type { StorageProjectSession } from './storage-ipc-controller';

export interface ImageFeatureGenerateQuickInput {
  readonly prompt: string;
  readonly candidateId: string;
  readonly parameterValues: Readonly<Record<string, DynamicParameterValue>>;
}

export interface ImageFeatureControllerRuntime {
  readonly drafts: ImageWorkspaceRepository;
  readonly candidates: ProviderFeatureCandidateService;
  assertPromptEnhancementSatisfied?(draft: ImageWorkspaceDraft): Promise<void>;
  submit?(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation: SubmissionUserConfirmationV1;
  }): Promise<ImageFeatureSubmissionDto>;
  generateQuickImage?(
    input: ImageFeatureGenerateQuickInput
  ): Promise<ImageFeatureGenerateQuickDto>;
  listQuickCandidates?(): Promise<readonly ImageFeatureCandidateDto[]>;
  recoverResult?(taskId: string): Promise<ImageFeatureRecoveryDto>;
}

export interface ImageFeatureControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  getRuntime(session: StorageProjectSession): ImageFeatureControllerRuntime;
  readonly mutations: ImageWorkspaceMutationCoordinator;
  onError?(error: unknown): void;
}

export class ImageFeatureController {
  private readonly operations = new Set<Promise<unknown>>();

  constructor(private readonly dependencies: ImageFeatureControllerDependencies) {}

  listCandidates(
    request: unknown
  ): Promise<ImageFeatureIpcResult<readonly ImageFeatureCandidateDto[]>> {
    return this.execute(async () => {
      const input = parseDraftRequest(request);
      const resolved = await this.requireDraft(input);
      return {
        ok: true,
        value: await resolved.runtime.candidates.listFeatureCandidates(resolved.subject)
      };
    });
  }

  listQuickCandidates(
    request: unknown
  ): Promise<ImageFeatureIpcResult<readonly ImageFeatureCandidateDto[]>> {
    return this.execute(async () => {
      if (request !== undefined && request !== null) {
        throw new TypeError('Quick candidate listing accepts no arguments');
      }
      const session = this.dependencies.getSession();
      if (!session) {
        return failure('project_not_open', 'A project must be open');
      }
      const runtime = this.dependencies.getRuntime(session);
      if (!runtime.listQuickCandidates) {
        return failure('runtime_not_allowed', 'Quick candidate listing is unavailable');
      }
      return {
        ok: true,
        value: await runtime.listQuickCandidates()
      };
    });
  }

  prepareSubmission(
    request: unknown
  ): Promise<ImageFeatureIpcResult<ImageFeaturePreparationDto>> {
    return this.execute(async () => {
      const input = parsePrepareRequest(request);
      const resolved = await this.requireDraft(input);
      await resolved.runtime.assertPromptEnhancementSatisfied?.(resolved.draft);
      return {
        ok: true,
        value: await resolved.runtime.candidates.prepareSubmission({
          subject: resolved.subject,
          candidateId: input.candidateId
        })
      };
    });
  }

  submitDraft(
    request: unknown
  ): Promise<ImageFeatureIpcResult<ImageFeatureSubmissionDto>> {
    return this.execute(async () => {
      const input = parseSubmitRequest(request);
      if (!input.confirmed) {
        return failure('confirmation_required', 'Explicit confirmation is required');
      }
      const resolved = await this.requireDraft(input);
      await resolved.runtime.assertPromptEnhancementSatisfied?.(resolved.draft);
      const confirmation = {
        schemaVersion: 1 as const,
        confirmationId: input.confirmationId,
        confirmed: true as const
      };
      await resolved.runtime.candidates.validatePreparedSubmission({
        subject: resolved.subject,
        routeSelectionToken: input.routeSelectionToken,
        confirmation
      });
      if (!resolved.runtime.submit) {
        return failure(
          'runtime_not_allowed',
          'Image provider runtime access is not approved'
        );
      }
      return {
        ok: true,
        value: await resolved.runtime.submit({
          subject: resolved.subject,
          routeSelectionToken: input.routeSelectionToken,
          confirmation
        })
      };
    });
  }

  generateQuickImage(
    request: unknown
  ): Promise<ImageFeatureIpcResult<ImageFeatureGenerateQuickDto>> {
    return this.execute(async () => {
      const input = parseGenerateQuickRequest(request);
      const session = this.dependencies.getSession();
      if (!session) throw controllerError('project_not_open', 'A project must be open');
      const runtime = this.dependencies.getRuntime(session);
      if (!runtime.generateQuickImage) {
        return failure(
          'runtime_not_allowed',
          'Image provider runtime access is not approved'
        );
      }
      return {
        ok: true,
        value: await runtime.generateQuickImage(input)
      };
    });
  }

  recoverResult(
    request: unknown
  ): Promise<ImageFeatureIpcResult<ImageFeatureRecoveryDto>> {
    return this.execute(async () => {
      const taskId = parseTaskRequest(request);
      await this.dependencies.mutations.wait();
      const session = this.dependencies.getSession();
      if (!session) return failure('project_not_open', 'A project must be open');
      const runtime = this.dependencies.getRuntime(session);
      if (!runtime.recoverResult) {
        return failure('runtime_not_allowed', 'Image result recovery is unavailable');
      }
      return { ok: true, value: await runtime.recoverResult(taskId) };
    });
  }

  async waitForOperations(): Promise<void> {
    await Promise.all([...this.operations]);
  }

  private async requireDraft(input: DraftRequest) {
    await this.dependencies.mutations.wait();
    const session = this.dependencies.getSession();
    if (!session) throw controllerError('project_not_open', 'A project must be open');
    const runtime = this.dependencies.getRuntime(session);
    const draft = await runtime.drafts.get(toDraftId(input.draftId));
    if (!draft || draft.projectId !== session.projectId) {
      throw controllerError('draft_not_found', 'The image draft does not exist');
    }
    if (draft.updatedAt !== input.draftUpdatedAt) {
      throw controllerError(
        'draft_revision_changed',
        'The image draft changed after candidate selection'
      );
    }
    const subject: FeatureCandidateSubjectV1 = {
      kind: 'draft',
      draftId: draft.id,
      draftRevision: imageDraftRevision(draft.updatedAt)
    };
    return { runtime, subject, draft };
  }

  private execute<T>(
    operation: () => Promise<ImageFeatureIpcResult<T>>
  ): Promise<ImageFeatureIpcResult<T>> {
    const current = (async () => {
      try {
        return await operation();
      } catch (error) {
        this.dependencies.onError?.(error);
        return { ok: false as const, error: mapError(error) };
      }
    })();
    this.operations.add(current);
    void current.finally(() => this.operations.delete(current));
    return current;
  }
}

interface DraftRequest {
  readonly draftId: string;
  readonly draftUpdatedAt: string;
}

function parseDraftRequest(request: unknown): DraftRequest {
  if (!exact(request, ['draftId', 'draftUpdatedAt'])) throw invalidRequest();
  return {
    draftId: nonBlank(request.draftId),
    draftUpdatedAt: nonBlank(request.draftUpdatedAt)
  };
}

function parsePrepareRequest(request: unknown): DraftRequest & { readonly candidateId: string } {
  if (!exact(request, ['draftId', 'draftUpdatedAt', 'candidateId'])) {
    throw invalidRequest();
  }
  return {
    draftId: nonBlank(request.draftId),
    draftUpdatedAt: nonBlank(request.draftUpdatedAt),
    candidateId: nonBlank(request.candidateId)
  };
}

function parseSubmitRequest(request: unknown): DraftRequest & {
  readonly routeSelectionToken: string;
  readonly confirmationId: string;
  readonly confirmed: boolean;
} {
  if (!exact(request, [
    'draftId',
    'draftUpdatedAt',
    'routeSelectionToken',
    'confirmationId',
    'confirmed'
  ]) || typeof request.confirmed !== 'boolean') {
    throw invalidRequest();
  }
  return {
    draftId: nonBlank(request.draftId),
    draftUpdatedAt: nonBlank(request.draftUpdatedAt),
    routeSelectionToken: nonBlank(request.routeSelectionToken),
    confirmationId: nonBlank(request.confirmationId),
    confirmed: request.confirmed
  };
}

function parseGenerateQuickRequest(request: unknown): ImageFeatureGenerateQuickInput {
  if (
    typeof request !== 'object' ||
    request === null ||
    Array.isArray(request)
  ) {
    throw invalidRequest();
  }
  const item = request as Record<string, unknown>;
  const keys = Object.keys(item);
  if (
    keys.length !== 3 ||
    !keys.includes('prompt') ||
    !keys.includes('candidateId') ||
    !keys.includes('parameterValues')
  ) {
    throw invalidRequest();
  }
  const prompt = nonBlank(item.prompt);
  if (prompt.length > 1000) throw invalidRequest();
  if (
    typeof item.parameterValues !== 'object' ||
    item.parameterValues === null ||
    Array.isArray(item.parameterValues)
  ) {
    throw invalidRequest();
  }
  return {
    prompt,
    candidateId: nonBlank(item.candidateId),
    parameterValues: item.parameterValues as ImageFeatureGenerateQuickInput['parameterValues']
  };
}

function parseTaskRequest(request: unknown): string {
  if (!exact(request, ['taskId'])) throw invalidRequest();
  return nonBlank(request.taskId);
}

class ImageFeatureControllerError extends Error {
  constructor(readonly code: ImageFeatureIpcErrorCode, message: string) {
    super(message);
    this.name = 'ImageFeatureControllerError';
  }
}

function invalidRequest(): ImageFeatureControllerError {
  return controllerError('invalid_request', 'The image feature request is invalid');
}

function controllerError(
  code: ImageFeatureIpcErrorCode,
  message: string
): ImageFeatureControllerError {
  return new ImageFeatureControllerError(code, message);
}

function mapError(error: unknown): {
  readonly code: ImageFeatureIpcErrorCode;
  readonly message: string;
} {
  if (error instanceof ImageFeatureControllerError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof FeatureSubmissionError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof SubmissionOrchestrationError) {
    return {
      code: error.code === 'subject_kind_mismatch' ? 'subject_invalid' : error.code,
      message: error.message
    };
  }
  if (
    error instanceof TypeError &&
    typeof error.message === 'string' &&
    (error.message.includes('capability evidence') ||
      error.message.includes('prompt enhancement') ||
      error.message.includes('Project context'))
  ) {
    return {
      code: 'subject_invalid',
      message: error.message
    };
  }
  return {
    code: 'storage_error',
    message: 'The local image feature operation failed'
  };
}

function failure<T>(
  code: ImageFeatureIpcErrorCode,
  message: string
): ImageFeatureIpcResult<T> {
  return { ok: false, error: { code, message } };
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

function nonBlank(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw invalidRequest();
  return value;
}
