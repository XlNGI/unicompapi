import {
  ProjectContextApplicationError
} from '../../application';
import type { ProjectContextRegistryService } from '../../application';
import {
  toConversationId,
  toMessageId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId
} from '../../domain';
import {
  chatContextRequestParsers,
  type ChatContextIpcResult,
  type ContextSourceStatusDto,
  type ProjectContextCandidateDto,
  type ProjectContextDetailDto,
  type ProjectContextDraftPreviewDto
} from '../../shared/chat-context-ipc';
import { chatContextFailure, failure } from './chat-context-errors';
import type { StorageProjectSession } from './storage-ipc-controller';

export interface ProjectContextControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  getService(session: StorageProjectSession): ProjectContextRegistryService;
  onError?(error: unknown): void;
}

export class ProjectContextController {
  private mutations = Promise.resolve();

  constructor(private readonly dependencies: ProjectContextControllerDependencies) {}

  createDraft(
    request: unknown
  ): Promise<ChatContextIpcResult<ProjectContextDraftPreviewDto>> {
    return this.mutate(async (service, session) => {
      const input = chatContextRequestParsers.createContextDraft(request);
      return {
        ok: true,
        value: await service.createDraft({
          projectId: session.projectId,
          conversationId: toConversationId(input.conversationId)
        })
      };
    });
  }

  getDraftPreview(
    request: unknown
  ): Promise<ChatContextIpcResult<ProjectContextDraftPreviewDto>> {
    return this.read(async (service, session) => {
      const input = chatContextRequestParsers.draftId(request);
      return {
        ok: true,
        value: await service.getDraftPreview({
          projectId: session.projectId,
          draftId: toProjectContextDraftId(input.draftId)
        })
      };
    });
  }

  addMessageFragment(
    request: unknown
  ): Promise<ChatContextIpcResult<ProjectContextDraftPreviewDto>> {
    return this.mutate(async (service, session) => {
      const input = chatContextRequestParsers.addContextMessageFragment(request);
      await assertDraftRevision(
        service,
        session,
        input.draftId,
        input.expectedRevision
      );
      return {
        ok: true,
        value: await service.addMessageFragment({
          projectId: session.projectId,
          draftId: toProjectContextDraftId(input.draftId),
          expectedRevision: input.expectedRevision,
          messageId: toMessageId(input.messageId),
          startUtf16: input.startUtf16,
          endUtf16: input.endUtf16
        })
      };
    });
  }

  removeMessageFragment(
    request: unknown
  ): Promise<ChatContextIpcResult<ProjectContextDraftPreviewDto>> {
    return this.mutate(async (service, session) => {
      const input = chatContextRequestParsers.removeContextMessageFragment(request);
      await assertDraftRevision(
        service,
        session,
        input.draftId,
        input.expectedRevision
      );
      return {
        ok: true,
        value: await service.removeMessageFragment({
          projectId: session.projectId,
          draftId: toProjectContextDraftId(input.draftId),
          expectedRevision: input.expectedRevision,
          fragmentId: toProjectContextFragmentId(input.fragmentId)
        })
      };
    });
  }

  updateDraftLabels(
    request: unknown
  ): Promise<ChatContextIpcResult<ProjectContextDraftPreviewDto>> {
    return this.mutate(async (service, session) => {
      const input = chatContextRequestParsers.updateContextDraftLabels(request);
      await assertDraftRevision(
        service,
        session,
        input.draftId,
        input.expectedRevision
      );
      return {
        ok: true,
        value: await service.updateDraftLabels({
          projectId: session.projectId,
          draftId: toProjectContextDraftId(input.draftId),
          expectedRevision: input.expectedRevision,
          labels: input.labels
        })
      };
    });
  }

  registerDraft(
    request: unknown
  ): Promise<ChatContextIpcResult<ProjectContextDetailDto>> {
    return this.mutate(async (service, session) => {
      const input = chatContextRequestParsers.registerContextDraft(request);
      if (!input.confirmed) {
        return failure(
          'explicit_confirmation_required',
          'Project context registration requires explicit confirmation'
        );
      }
      await assertDraftRevision(
        service,
        session,
        input.draftId,
        input.expectedRevision
      );
      return {
        ok: true,
        value: await service.registerDraft({
          projectId: session.projectId,
          draftId: toProjectContextDraftId(input.draftId),
          expectedRevision: input.expectedRevision,
          confirmed: true
        })
      };
    });
  }

  updateContext(
    request: unknown
  ): Promise<ChatContextIpcResult<ProjectContextDetailDto>> {
    return this.mutate(async (service, session) => {
      const input = chatContextRequestParsers.updateProjectContext(request);
      await assertContextRevision(
        service,
        session,
        input.contextId,
        input.expectedRevision
      );
      return {
        ok: true,
        value: await service.updateContext({
          projectId: session.projectId,
          contextId: toProjectContextId(input.contextId),
          expectedRevision: input.expectedRevision,
          contentSnapshot: input.contentSnapshot,
          labels: input.labels
        })
      };
    });
  }

  deleteContext(
    request: unknown
  ): Promise<ChatContextIpcResult<ProjectContextDetailDto>> {
    return this.mutate(async (service, session) => {
      const input = chatContextRequestParsers.contextRevision(request);
      await assertContextRevision(
        service,
        session,
        input.contextId,
        input.expectedRevision
      );
      return {
        ok: true,
        value: await service.deleteContext({
          projectId: session.projectId,
          contextId: toProjectContextId(input.contextId),
          expectedRevision: input.expectedRevision
        })
      };
    });
  }

  refreshSourceStatus(
    request: unknown
  ): Promise<ChatContextIpcResult<ProjectContextDetailDto>> {
    return this.mutate(async (service, session) => {
      const input = chatContextRequestParsers.contextRevision(request);
      return {
        ok: true,
        value: await service.refreshSourceStatus({
          projectId: session.projectId,
          contextId: toProjectContextId(input.contextId),
          expectedRevision: input.expectedRevision
        })
      };
    });
  }

  listCandidates(): Promise<
    ChatContextIpcResult<readonly ProjectContextCandidateDto[]>
  > {
    return this.read(async (service, session) => ({
      ok: true,
      value: await service.listCandidates({ projectId: session.projectId })
    }));
  }

  getContext(
    request: unknown
  ): Promise<ChatContextIpcResult<ProjectContextDetailDto>> {
    return this.read(async (service, session) => {
      const input = chatContextRequestParsers.contextId(request);
      return {
        ok: true,
        value: await service.getContext({
          projectId: session.projectId,
          contextId: toProjectContextId(input.contextId)
        })
      };
    });
  }

  getContextRevision(
    request: unknown
  ): Promise<ChatContextIpcResult<ProjectContextDetailDto>> {
    return this.read(async (service, session) => {
      const input = chatContextRequestParsers.getProjectContextRevision(request);
      return {
        ok: true,
        value: await service.getContextRevision({
          projectId: session.projectId,
          contextId: toProjectContextId(input.contextId),
          revision: input.revision
        })
      };
    });
  }

  getSourceStatus(
    request: unknown
  ): Promise<ChatContextIpcResult<ContextSourceStatusDto>> {
    return this.read(async (service, session) => {
      const input = chatContextRequestParsers.contextId(request);
      return {
        ok: true,
        value: await service.getSourceStatus({
          projectId: session.projectId,
          contextId: toProjectContextId(input.contextId)
        })
      };
    });
  }

  waitForMutations(): Promise<void> {
    return this.mutations;
  }

  private read<T>(
    operation: (
      service: ProjectContextRegistryService,
      session: StorageProjectSession
    ) => Promise<ChatContextIpcResult<T>>
  ): Promise<ChatContextIpcResult<T>> {
    return this.execute(async () => {
      await this.mutations;
      const session = this.dependencies.getSession();
      if (!session) {
        return failure('project_not_open', 'A project must be open');
      }
      return operation(this.dependencies.getService(session), session);
    });
  }

  private mutate<T>(
    operation: (
      service: ProjectContextRegistryService,
      session: StorageProjectSession
    ) => Promise<ChatContextIpcResult<T>>
  ): Promise<ChatContextIpcResult<T>> {
    const current = this.mutations.then(async () => {
      const session = this.dependencies.getSession();
      if (!session) {
        return failure<T>('project_not_open', 'A project must be open');
      }
      return operation(this.dependencies.getService(session), session);
    });
    this.mutations = current.then(() => undefined, () => undefined);
    return this.execute(() => current);
  }

  private async execute<T>(
    operation: () => Promise<ChatContextIpcResult<T>>
  ): Promise<ChatContextIpcResult<T>> {
    try {
      return await operation();
    } catch (error) {
      return chatContextFailure(error, this.dependencies.onError);
    }
  }
}

async function assertDraftRevision(
  service: ProjectContextRegistryService,
  session: StorageProjectSession,
  draftId: string,
  expectedRevision: number
): Promise<void> {
  const draft = await service.getDraftPreview({
    projectId: session.projectId,
    draftId: toProjectContextDraftId(draftId)
  });
  if (draft.revision !== expectedRevision) {
    throw new ProjectContextApplicationError(
      'revision_conflict',
      'Project context draft revision has changed'
    );
  }
}

async function assertContextRevision(
  service: ProjectContextRegistryService,
  session: StorageProjectSession,
  contextId: string,
  expectedRevision: number
): Promise<void> {
  const context = await service.getContext({
    projectId: session.projectId,
    contextId: toProjectContextId(contextId)
  });
  if (context.revision !== expectedRevision) {
    throw new ProjectContextApplicationError(
      'revision_conflict',
      'Project context revision has changed'
    );
  }
}
