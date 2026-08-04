import {
  toDraftId,
  type FeatureCandidateSubjectV1,
  type ImageWorkspaceRepository,
  type SubmissionUserConfirmationV1
} from '../../domain';
import type {
  ImageFeatureCandidateDto,
  ImageFeatureIpcErrorCode,
  ImageFeatureIpcResult,
  ImageFeaturePreparationDto,
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

export interface ImageFeatureControllerRuntime {
  readonly drafts: ImageWorkspaceRepository;
  readonly candidates: ProviderFeatureCandidateService;
  submit?(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation: SubmissionUserConfirmationV1;
    readonly draftId: string;
    readonly expectedDraftUpdatedAt: string;
  }): Promise<ImageFeatureSubmissionDto>;
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

  prepareSubmission(
    request: unknown
  ): Promise<ImageFeatureIpcResult<ImageFeaturePreparationDto>> {
    return this.execute(async () => {
      const input = parsePrepareRequest(request);
      const resolved = await this.requireDraft(input);
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
      const resolved = await this.requireDraft(input);
      const confirmation = input.confirmed
        ? {
            schemaVersion: 1 as const,
            confirmationId: input.confirmationId,
            confirmed: true as const
          }
        : undefined;
      const validated = await resolved.runtime.candidates.validatePreparedSubmission({
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
          draftId: input.draftId,
          expectedDraftUpdatedAt: input.draftUpdatedAt,
          confirmation: confirmation ?? {
            schemaVersion: 1,
            confirmationId: validated.tokenRecord.confirmation.confirmationId,
            confirmed: true
          }
        })
      };
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
    return { runtime, subject };
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
