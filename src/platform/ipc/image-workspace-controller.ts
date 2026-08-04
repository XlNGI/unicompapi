import { randomUUID } from 'node:crypto';
import {
  addImageUnderstandingRevision,
  createEmptyImageWorkspaceDraft,
  createImageAnalysisProjectContextDraft,
  createImageWorkspaceDraft,
  deriveImageWorkspaceDraft,
  applyImageWorkspaceChangeStaleness,
  imageWorkspaceModes,
  isImageWorkspaceDraft,
  registerProjectContextDraft,
  reviseImageToPrompt,
  updateProjectContextContent,
  toAssetId,
  toDraftId,
  toIsoTimestamp,
  toProjectContextDraftId,
  toProjectContextId,
  type ImageWorkspaceDraft,
  type ImageWorkspaceMode
} from '../../domain';
import type {
  ImageWorkspaceDraftDto,
  ImageWorkspaceIpcErrorCode,
  ImageWorkspaceIpcResult
} from '../../shared/image-workspace-ipc';
import {
  JsonAssetRepository,
  JsonImageWorkspaceRepository,
  JsonProjectContextRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import type { StorageProjectSession } from './storage-ipc-controller';
import { ImageWorkspaceMutationCoordinator } from './image-workspace-mutations';

export interface ImageWorkspaceControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  createDraftId?(): string;
  now?(): string;
  mutations?: ImageWorkspaceMutationCoordinator;
  onError?(error: unknown): void;
}

export class ImageWorkspaceController {
  private readonly mutations: ImageWorkspaceMutationCoordinator;

  constructor(
    private readonly dependencies: ImageWorkspaceControllerDependencies
  ) {
    this.mutations =
      dependencies.mutations ?? new ImageWorkspaceMutationCoordinator();
  }

  waitForMutations(): Promise<void> {
    return this.mutations.wait();
  }

  create(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const mode = parseModeRequest(request);
        const context = this.createContext();
        const createdAt = this.now();
        const draft = createEmptyImageWorkspaceDraft({
          id: this.createDraftId(),
          projectId: context.session.projectId,
          mode,
          createdAt
        });

        await context.repository.save(draft);
        return toImageWorkspaceDto(draft);
      })
    );
  }

  get(
    request: unknown
  ): Promise<
    ImageWorkspaceIpcResult<ImageWorkspaceDraftDto | undefined>
  > {
    return this.execute(async () => {
      await this.mutations.wait();
      const draftId = parseDraftIdRequest(request);
      const context = this.createContext();
      const draft = await context.repository.get(draftId);
      return draft ? toImageWorkspaceDto(draft) : undefined;
    });
  }

  list(): Promise<
    ImageWorkspaceIpcResult<readonly ImageWorkspaceDraftDto[]>
  > {
    return this.execute(async () => {
      await this.mutations.wait();
      const context = this.createContext();
      const drafts = await context.repository.list(context.session.projectId);
      return drafts.map(toImageWorkspaceDto);
    });
  }

  update(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const requested = parseUpdateRequest(request);
        const context = this.createContext();
        const stored = await context.repository.get(requested.id);

        if (!stored) {
          throw new ImageWorkspaceControllerError(
            'draft_not_found',
            'The requested image workspace draft does not exist'
          );
        }

        if (requested.updatedAt !== stored.updatedAt) {
          throw new ImageWorkspaceControllerError(
            'draft_conflict',
            'The image workspace draft changed before this update was saved'
          );
        }

        if (
          requested.projectId !== context.session.projectId ||
          requested.mode !== stored.mode ||
          requested.createdAt !== stored.createdAt ||
          JSON.stringify(requested.origin) !== JSON.stringify(stored.origin)
        ) {
          throw new ImageWorkspaceControllerError(
            'invalid_request',
            'Immutable image workspace fields cannot be changed'
          );
        }
        if (hasProtectedImageResultChanges(stored, requested)) {
          throw new ImageWorkspaceControllerError(
            'invalid_request',
            'Structured results and revision history require their dedicated operation'
          );
        }
        if (
          stored.mode === 'image_to_prompt' &&
          requested.mode === 'image_to_prompt' &&
          stored.prompt.finalPrompt !== requested.prompt.finalPrompt &&
          stored.imageToPrompt.resultRevision < 1
        ) {
          throw resultNotAvailable();
        }

        const updatedAt = this.now();
        const normalizedRequest =
          stored.mode === 'image_to_prompt' &&
          requested.mode === 'image_to_prompt' &&
          stored.prompt.finalPrompt !== requested.prompt.finalPrompt
            ? {
                ...requested,
                imageToPrompt: {
                  ...requested.imageToPrompt,
                  promptRevision: stored.imageToPrompt.promptRevision + 1
                }
              }
            : requested;
        const candidate = createImageWorkspaceDraft({
          ...normalizedRequest,
          id: stored.id,
          projectId: stored.projectId,
          mode: stored.mode,
          origin: stored.origin,
          createdAt: stored.createdAt,
          updatedAt
        } as ImageWorkspaceDraft);
        const updated = applyImageWorkspaceChangeStaleness(
          stored,
          candidate,
          updatedAt
        );

        await context.repository.save(updated);
        return toImageWorkspaceDto(updated);
      })
    );
  }

  derive(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const parsed = parseDeriveRequest(request);
        const context = this.createContext();
        const source = await context.repository.get(parsed.sourceDraftId);

        if (!source) {
          throw new ImageWorkspaceControllerError(
            'draft_not_found',
            'The source image workspace draft does not exist'
          );
        }

        const derived = deriveImageWorkspaceDraft({
          id: this.createDraftId(),
          source,
          targetMode: parsed.targetMode,
          createdAt: this.now()
        });

        await context.repository.save(derived);
        return toImageWorkspaceDto(derived);
      })
    );
  }

  deriveFromResult(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const parsed = parseDeriveFromResultRequest(request);
        const context = this.createContext();
        const source = await context.repository.get(parsed.sourceDraftId);
        if (!source) throw draftNotFound();
        requireExpectedDraft(source, parsed.expectedDraftUpdatedAt);
        if (resultRevisionOf(source) !== parsed.expectedResultRevision) {
          throw new ImageWorkspaceControllerError(
            'result_revision_changed',
            'The saved image result changed before the downstream draft was created'
          );
        }
        const derived = deriveImageWorkspaceDraft({
          id: this.createDraftId(),
          source,
          targetMode: parsed.targetMode,
          createdAt: this.now()
        });
        await context.repository.save(derived);
        return toImageWorkspaceDto(derived);
      })
    );
  }

  addUnderstandingRevision(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const input = parseUnderstandingRevisionRequest(request);
        const context = this.createContext();
        const draft = await context.repository.get(input.draftId);
        if (!draft) throw draftNotFound();
        requireExpectedDraft(draft, input.expectedDraftUpdatedAt);
        if (
          draft.mode !== 'image_understanding' ||
          draft.understanding.resultRevision < 1
        ) {
          throw resultNotAvailable();
        }
        const updated = addImageUnderstandingRevision(draft, {
          id: `image-revision-${randomUUID()}`,
          targetObservationId: input.targetObservationId,
          content: input.content,
          createdAt: this.now()
        });
        await context.repository.save(updated);
        return toImageWorkspaceDto(updated);
      })
    );
  }

  revisePrompt(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const input = parsePromptRevisionRequest(request);
        const context = this.createContext();
        const draft = await context.repository.get(input.draftId);
        if (!draft) throw draftNotFound();
        requireExpectedDraft(draft, input.expectedDraftUpdatedAt);
        if (
          draft.mode !== 'image_to_prompt' ||
          draft.imageToPrompt.promptRevision !== input.expectedPromptRevision
        ) {
          throw new ImageWorkspaceControllerError(
            'result_revision_changed',
            'The image prompt revision changed before the edit was saved'
          );
        }
        const updated = reviseImageToPrompt(
          draft,
          input.finalPrompt,
          this.now()
        );
        await context.repository.save(updated);
        return toImageWorkspaceDto(updated);
      })
    );
  }

  registerResultContext(request: unknown): Promise<
    ImageWorkspaceIpcResult<{ readonly contextId: string; readonly revision: number }>
  > {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const input = parseRegisterResultContextRequest(request);
        const context = this.createContext();
        const draft = await context.repository.get(input.draftId);
        if (!draft) throw draftNotFound();
        requireExpectedDraft(draft, input.expectedDraftUpdatedAt);
        if (resultRevisionOf(draft) !== input.expectedResultRevision) {
          throw resultNotAvailable();
        }

        const contentSnapshot = imageResultContextSnapshot(draft);
        const registeredAt = this.now();
        const existing = (await context.contexts.list(false)).find((item) => {
          const version = item.versions[item.currentRevision - 1];
          return version?.sourceKind === 'image_analysis' &&
            version.sourceImageDraftId === draft.id &&
            version.sourceImageResultRevision === input.expectedResultRevision;
        });
        if (existing) {
          const current = existing.versions[existing.currentRevision - 1];
          if (
            current?.contentSnapshot === contentSnapshot &&
            JSON.stringify(current.labels) === JSON.stringify(input.labels)
          ) {
            return { contextId: existing.id, revision: existing.currentRevision };
          }
          const updated = updateProjectContextContent(
            existing,
            contentSnapshot,
            input.labels,
            registeredAt
          );
          await context.contexts.save(updated, existing.currentRevision);
          return { contextId: updated.id, revision: updated.currentRevision };
        }

        const contextDraft = createImageAnalysisProjectContextDraft({
          id: toProjectContextDraftId(`image-context-draft-${randomUUID()}`),
          projectId: draft.projectId,
          sourceImageDraftId: draft.id,
          sourceImageResultRevision: input.expectedResultRevision,
          contentSnapshot,
          labels: input.labels,
          createdAt: registeredAt
        });
        const registered = registerProjectContextDraft(
          contextDraft,
          toProjectContextId(`image-context-${randomUUID()}`),
          registeredAt
        );
        await context.contexts.createDraft(contextDraft);
        await context.contexts.registerDraft(
          contextDraft.id,
          contextDraft.revision,
          registered
        );
        if (draft.mode === 'image_understanding') {
          await context.repository.save({
            ...draft,
            updatedAt: registeredAt,
            understanding: {
              ...draft.understanding,
              saveScope: 'project_context'
            }
          });
        }
        return {
          contextId: registered.id,
          revision: registered.currentRevision
        };
      })
    );
  }

  setEditingMask(
    request: unknown
  ): Promise<ImageWorkspaceIpcResult<ImageWorkspaceDraftDto>> {
    return this.enqueueMutation(() =>
      this.execute(async () => {
        const input = parseSetEditingMaskRequest(request);
        const context = this.createContext();
        const draft = await context.repository.get(input.draftId);
        if (!draft) throw draftNotFound();
        requireExpectedDraft(draft, input.expectedDraftUpdatedAt);
        if (draft.mode !== 'image_editing') {
          throw invalidRequest('Only image editing drafts accept a mask');
        }
        if (input.maskAssetId) {
          const asset = await context.assets.get(input.maskAssetId);
          if (!asset || asset.projectId !== draft.projectId || asset.mediaKind !== 'image') {
            throw invalidRequest('The selected image mask is unavailable');
          }
        }
        const updated = createImageWorkspaceDraft({
          ...draft,
          updatedAt: this.now(),
          editing: {
            ...draft.editing,
            maskAssetId: input.maskAssetId,
            maskAssetRevision: input.maskAssetId ? 1 : undefined
          }
        });
        await context.repository.save(updated);
        return toImageWorkspaceDto(updated);
      })
    );
  }

  private createContext() {
    const session = this.dependencies.getSession();

    if (!session) {
      throw new ImageWorkspaceControllerError(
        'project_not_open',
        'No project is currently open'
      );
    }

    const storage = new NodeProjectStorage(session.rootDirectory);
    return {
      session,
      repository: new JsonImageWorkspaceRepository(storage, session.projectId),
      contexts: new JsonProjectContextRepository(storage, session.projectId),
      assets: new JsonAssetRepository(storage, session.projectId)
    };
  }

  private createDraftId() {
    return toDraftId(
      this.dependencies.createDraftId?.() ?? `image-draft-${randomUUID()}`
    );
  }

  private now() {
    return toIsoTimestamp(
      this.dependencies.now?.() ?? new Date().toISOString()
    );
  }

  private async execute<T>(
    operation: () => Promise<T>
  ): Promise<ImageWorkspaceIpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.dependencies.onError?.(error);
      return { ok: false, error: mapImageWorkspaceError(error) };
    }
  }

  private enqueueMutation<T>(
    operation: () => Promise<ImageWorkspaceIpcResult<T>>
  ): Promise<ImageWorkspaceIpcResult<T>> {
    return this.mutations.enqueue(operation);
  }
}

class ImageWorkspaceControllerError extends Error {
  constructor(
    readonly code: ImageWorkspaceIpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ImageWorkspaceControllerError';
  }
}

function parseModeRequest(request: unknown): ImageWorkspaceMode {
  if (
    !isRecord(request) ||
    typeof request.mode !== 'string' ||
    !imageWorkspaceModes.includes(request.mode as ImageWorkspaceMode)
  ) {
    throw invalidRequest('A supported image workspace mode is required');
  }

  return request.mode as ImageWorkspaceMode;
}

function parseDraftIdRequest(request: unknown) {
  if (!isRecord(request) || typeof request.draftId !== 'string') {
    throw invalidRequest('A valid image workspace draft ID is required');
  }

  try {
    return toDraftId(request.draftId);
  } catch {
    throw invalidRequest('A valid image workspace draft ID is required');
  }
}

function parseUpdateRequest(request: unknown): ImageWorkspaceDraft {
  if (!isRecord(request) || !isRecord(request.draft)) {
    throw invalidRequest('A valid image workspace draft is required');
  }

  const { draftId, ...rest } = request.draft;
  const value = { ...rest, id: draftId };

  if (!isImageWorkspaceDraft(value)) {
    throw invalidRequest('The image workspace draft is invalid');
  }

  return createImageWorkspaceDraft(value);
}

function parseDeriveRequest(request: unknown): {
  readonly sourceDraftId: ReturnType<typeof toDraftId>;
  readonly targetMode: ImageWorkspaceMode;
} {
  if (!isRecord(request)) {
    throw invalidRequest('A source draft and target mode are required');
  }

  const sourceDraftId = parseDraftIdRequest({
    draftId: request.sourceDraftId
  });
  const targetMode = parseModeRequest({ mode: request.targetMode });
  return { sourceDraftId, targetMode };
}

function parseDeriveFromResultRequest(request: unknown) {
  if (!exactRequest(request, [
    'sourceDraftId',
    'expectedDraftUpdatedAt',
    'expectedResultRevision',
    'targetMode'
  ])) throw invalidRequest('A versioned image result is required');
  return {
    sourceDraftId: parseDraftIdRequest({ draftId: request.sourceDraftId }),
    expectedDraftUpdatedAt: requiredString(request.expectedDraftUpdatedAt),
    expectedResultRevision: positiveInteger(request.expectedResultRevision),
    targetMode: parseModeRequest({ mode: request.targetMode })
  };
}

function parseUnderstandingRevisionRequest(request: unknown) {
  if (!exactRequest(
    request,
    ['draftId', 'expectedDraftUpdatedAt', 'content'],
    ['targetObservationId']
  )) throw invalidRequest('A valid image understanding revision is required');
  return {
    draftId: parseDraftIdRequest(request),
    expectedDraftUpdatedAt: requiredString(request.expectedDraftUpdatedAt),
    content: requiredString(request.content),
    ...(request.targetObservationId === undefined
      ? {}
      : { targetObservationId: requiredString(request.targetObservationId) })
  };
}

function parsePromptRevisionRequest(request: unknown) {
  if (!exactRequest(request, [
    'draftId',
    'expectedDraftUpdatedAt',
    'expectedPromptRevision',
    'finalPrompt'
  ])) throw invalidRequest('A valid image prompt revision is required');
  return {
    draftId: parseDraftIdRequest(request),
    expectedDraftUpdatedAt: requiredString(request.expectedDraftUpdatedAt),
    expectedPromptRevision: positiveInteger(request.expectedPromptRevision),
    finalPrompt: requiredString(request.finalPrompt)
  };
}

function parseRegisterResultContextRequest(request: unknown) {
  if (!exactRequest(request, [
    'draftId',
    'expectedDraftUpdatedAt',
    'expectedResultRevision',
    'labels'
  ]) || !Array.isArray(request.labels)) {
    throw invalidRequest('A valid saved image result is required');
  }
  return {
    draftId: parseDraftIdRequest(request),
    expectedDraftUpdatedAt: requiredString(request.expectedDraftUpdatedAt),
    expectedResultRevision: positiveInteger(request.expectedResultRevision),
    labels: request.labels.map(requiredString)
  };
}

function parseSetEditingMaskRequest(request: unknown) {
  if (!exactRequest(
    request,
    ['draftId', 'expectedDraftUpdatedAt'],
    ['maskAssetId']
  )) throw invalidRequest('A valid image editing mask request is required');
  return {
    draftId: parseDraftIdRequest(request),
    expectedDraftUpdatedAt: requiredString(request.expectedDraftUpdatedAt),
    ...(request.maskAssetId === undefined
      ? {}
      : { maskAssetId: toAssetId(requiredString(request.maskAssetId)) })
  };
}

function exactRequest(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  if (!isRecord(value) || required.some((key) => !(key in value))) return false;
  const allowed = [...required, ...optional];
  return Object.keys(value).every((key) => allowed.includes(key));
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidRequest('A non-empty string is required');
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw invalidRequest('A positive revision is required');
  }
  return Number(value);
}

function requireExpectedDraft(
  draft: ImageWorkspaceDraft,
  expectedDraftUpdatedAt: string
): void {
  if (draft.updatedAt !== expectedDraftUpdatedAt) {
    throw new ImageWorkspaceControllerError(
      'draft_conflict',
      'The image workspace draft changed before the operation completed'
    );
  }
}

function resultRevisionOf(draft: ImageWorkspaceDraft): number {
  if (draft.mode === 'image_understanding') {
    return draft.understanding.resultRevision;
  }
  if (draft.mode === 'image_to_prompt') {
    return draft.imageToPrompt.resultRevision;
  }
  return 0;
}

function imageResultContextSnapshot(draft: ImageWorkspaceDraft): string {
  const result = draft.mode === 'image_understanding'
    ? draft.understanding
    : draft.mode === 'image_to_prompt'
      ? draft.imageToPrompt
      : undefined;
  if (!result || result.resultRevision < 1) throw resultNotAvailable();
  const sections = [
    observationSection('Visible facts', result.observations.visibleFacts),
    observationSection('Model inferences', result.observations.modelInferences),
    observationSection('Uncertainties', result.observations.uncertainties),
    observationSection('Unrecognized', result.observations.unrecognized)
  ];
  if (draft.mode === 'image_understanding' && draft.understanding.userRevisions.length) {
    sections.push([
      'User revisions',
      ...draft.understanding.userRevisions.map((item) =>
        `- r${item.revision}: ${item.content}`
      )
    ].join('\n'));
  }
  if (draft.mode === 'image_to_prompt') {
    sections.push(`Final prompt r${draft.imageToPrompt.promptRevision}\n${draft.prompt.finalPrompt}`);
  }
  return sections.filter(Boolean).join('\n\n');
}

function observationSection(
  title: string,
  observations: readonly { readonly content: string }[]
): string {
  return observations.length
    ? [title, ...observations.map((item) => `- ${item.content}`)].join('\n')
    : '';
}

function hasProtectedImageResultChanges(
  stored: ImageWorkspaceDraft,
  requested: ImageWorkspaceDraft
): boolean {
  if (stored.mode !== requested.mode) return true;
  if (stored.mode === 'image_understanding' && requested.mode === stored.mode) {
    return JSON.stringify(stored.understanding) !==
      JSON.stringify(requested.understanding);
  }
  if (stored.mode === 'image_to_prompt' && requested.mode === stored.mode) {
    const storedResult = {
      resultRevision: stored.imageToPrompt.resultRevision,
      promptRevision: stored.imageToPrompt.promptRevision,
      observations: stored.imageToPrompt.observations,
      analysisState: stored.imageToPrompt.analysisState,
      staleReasons: stored.imageToPrompt.staleReasons,
      analyzedAt: stored.imageToPrompt.analyzedAt,
      systemSupplements: stored.prompt.systemSupplements
    };
    const requestedResult = {
      resultRevision: requested.imageToPrompt.resultRevision,
      promptRevision: requested.imageToPrompt.promptRevision,
      observations: requested.imageToPrompt.observations,
      analysisState: requested.imageToPrompt.analysisState,
      staleReasons: requested.imageToPrompt.staleReasons,
      analyzedAt: requested.imageToPrompt.analyzedAt,
      systemSupplements: requested.prompt.systemSupplements
    };
    return JSON.stringify(storedResult) !== JSON.stringify(requestedResult);
  }
  if (stored.mode === 'image_editing' && requested.mode === stored.mode) {
    return JSON.stringify({
      lineage: stored.editing.lineage,
      maskAssetId: stored.editing.maskAssetId,
      maskAssetRevision: stored.editing.maskAssetRevision
    }) !== JSON.stringify({
      lineage: requested.editing.lineage,
      maskAssetId: requested.editing.maskAssetId,
      maskAssetRevision: requested.editing.maskAssetRevision
    });
  }
  return false;
}

function draftNotFound(): ImageWorkspaceControllerError {
  return new ImageWorkspaceControllerError(
    'draft_not_found',
    'The image workspace draft does not exist'
  );
}

function resultNotAvailable(): ImageWorkspaceControllerError {
  return new ImageWorkspaceControllerError(
    'result_not_available',
    'A saved structured image result is required'
  );
}

export function toImageWorkspaceDto(
  draft: ImageWorkspaceDraft
): ImageWorkspaceDraftDto {
  const { id, ...rest } = structuredClone(draft);
  return { ...rest, draftId: id } as ImageWorkspaceDraftDto;
}

function invalidRequest(message: string): ImageWorkspaceControllerError {
  return new ImageWorkspaceControllerError('invalid_request', message);
}

function mapImageWorkspaceError(error: unknown): {
  readonly code: ImageWorkspaceIpcErrorCode;
  readonly message: string;
} {
  if (error instanceof ImageWorkspaceControllerError) {
    return { code: error.code, message: error.message };
  }

  return {
    code: 'workspace_storage_error',
    message: 'The local image workspace operation failed'
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
