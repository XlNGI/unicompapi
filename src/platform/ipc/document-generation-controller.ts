import {
  ConversationApplicationError,
  DocumentDraftCompilationError,
  DocumentGenerationApplicationError,
  toDocumentGenerationApplicationInput,
  type DocumentGenerationApplicationService
} from '../../application';
import {
  InvalidStateTransitionError,
  toConversationId,
  toMessageId,
  toWorkId
} from '../../domain';
import type {
  DocumentGenerationCancelResultDto,
  DocumentGenerationFromConversationDto,
  DocumentGenerationIpcErrorCode,
  DocumentGenerationIpcResult,
  DocumentGenerationPrepareResultDto,
  DocumentGenerationReconcileResultDto,
  DocumentOpenResultDto
} from '../../shared/document-generation-ipc';
import { documentGenerationRequestParsers } from '../../shared/document-generation-ipc';
import { resolveFileReferencePathSafely } from '../files';
import {
  JsonFileReferenceRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import type { StorageProjectSession } from './storage-ipc-controller';

export interface DocumentGenerationControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  getApplication(
    session: StorageProjectSession
  ): DocumentGenerationApplicationService;
  openPath(absolutePath: string): Promise<string>;
  onError?(error: unknown): void;
}

export class DocumentGenerationController {
  private readonly operations = new Set<Promise<unknown>>();

  constructor(
    private readonly dependencies: DocumentGenerationControllerDependencies
  ) {}

  prepareGeneration(
    request: unknown
  ): Promise<DocumentGenerationIpcResult<DocumentGenerationPrepareResultDto>> {
    return this.execute(async () => {
      const input = documentGenerationRequestParsers.prepareGeneration(request);
      const session = this.requireSession();
      await this.dependencies.getApplication(session).prepare(
        toDocumentGenerationApplicationInput({
          ...input,
          images: []
        })
      );
      return { ok: true, value: { prepared: true } };
    });
  }

  reconcileGeneration(
    request: unknown
  ): Promise<DocumentGenerationIpcResult<DocumentGenerationReconcileResultDto>> {
    return this.execute(async () => {
      const input = documentGenerationRequestParsers.reconcileGeneration(request);
      const session = this.requireSession();
      const interrupted = await this.dependencies
        .getApplication(session)
        .reconcileInterrupted({
          conversationId: toConversationId(input.conversationId),
          expectedRevision: input.expectedRevision,
          messageId: toMessageId(input.messageId)
        });
      return { ok: true, value: { interrupted } };
    });
  }

  generateFromMessage(
    request: unknown
  ): Promise<DocumentGenerationIpcResult<DocumentGenerationFromConversationDto>> {
    return this.execute(async () => {
      const input = documentGenerationRequestParsers.generateFromMessage(request);
      const session = this.requireSession();
      const result = await this.dependencies
        .getApplication(session)
        .generateFromMessage(
          toDocumentGenerationApplicationInput({
            ...input,
            images: input.images ?? []
          })
        );
      return {
        ok: true,
        value: {
          conversationId: result.conversationId,
          messageId: result.messageId,
          taskId: result.taskId,
          executionId: result.executionId,
          workId: result.workId,
          fileName: result.fileName,
          sizeBytes: result.sizeBytes
        }
      };
    });
  }

  cancelGeneration(
    request: unknown
  ): Promise<DocumentGenerationIpcResult<DocumentGenerationCancelResultDto>> {
    return this.execute(async () => {
      const input = documentGenerationRequestParsers.cancelGeneration(request);
      const session = this.requireSession();
      const cancelled = await this.dependencies.getApplication(session).cancel({
        conversationId: toConversationId(input.conversationId),
        expectedRevision: input.expectedRevision,
        messageId: toMessageId(input.messageId)
      });
      return { ok: true, value: { cancelled } };
    });
  }

  openDocument(
    request: unknown
  ): Promise<DocumentGenerationIpcResult<DocumentOpenResultDto>> {
    return this.execute(async () => {
      const input = documentGenerationRequestParsers.openDocument(request);
      const session = this.requireSession();
      const storage = new NodeProjectStorage(session.rootDirectory);
      const works = new JsonWorkRepository(storage, session.projectId);
      const files = new JsonFileReferenceRepository(storage, session.projectId);
      const work = await works.get(toWorkId(input.workId));
      if (!work) {
        throw new DocumentGenerationApplicationError(
          'storage_error',
          'Document work does not exist'
        );
      }
      const file = await files.get(work.fileId);
      if (!file) {
        throw new DocumentGenerationApplicationError(
          'storage_error',
          'Document file does not exist'
        );
      }
      const absolutePath = await resolveFileReferencePathSafely(
        session.rootDirectory,
        file
      );
      await this.dependencies.openPath(absolutePath);
      return { ok: true, value: { opened: true } };
    });
  }

  async waitForOperations(): Promise<void> {
    await Promise.all([...this.operations]);
    const session = this.dependencies.getSession();
    if (session) {
      await this.dependencies.getApplication(session).waitForOperations();
    }
  }

  private requireSession(): StorageProjectSession {
    const session = this.dependencies.getSession();
    if (!session) {
      throw new DocumentGenerationApplicationError(
        'storage_error',
        'A project must be open'
      );
    }
    return session;
  }

  private execute<T>(
    operation: () => Promise<DocumentGenerationIpcResult<T>>
  ): Promise<DocumentGenerationIpcResult<T>> {
    let task!: Promise<DocumentGenerationIpcResult<T>>;
    task = operation()
      .catch((error: unknown): DocumentGenerationIpcResult<T> => {
        this.dependencies.onError?.(error);
        if (error instanceof DocumentDraftCompilationError) {
          return failure(
            error.code === 'resource_limit'
              ? 'document_layout_overflow'
              : 'invalid_outline',
            error.code === 'resource_limit'
              ? '文档内容超出当前生成限制。'
              : '模型返回的文档结构无法安全转换。'
          );
        }
        if (error instanceof DocumentGenerationApplicationError) {
          return mapApplicationError(error);
        }
        if (error instanceof ConversationApplicationError) {
          return failure(
            error.code === 'revision_conflict'
              ? 'revision_conflict'
              : 'conversation_not_found',
            error.message
          );
        }
        if (error instanceof InvalidStateTransitionError) {
          return failure('conversation_not_active', error.message);
        }
        if (error instanceof TypeError) {
          return failure('invalid_request', error.message);
        }
        return failure('storage_error', 'Local document storage failed');
      })
      .finally(() => {
        this.operations.delete(task);
      });
    this.operations.add(task);
    return task;
  }
}

function mapApplicationError<T>(
  error: DocumentGenerationApplicationError
): DocumentGenerationIpcResult<T> {
  switch (error.code) {
    case 'conversation_not_found':
      return failure('conversation_not_found', error.message);
    case 'message_not_found':
    case 'invalid_structure':
      return failure('invalid_outline', error.message);
    case 'resource_limit':
    case 'layout_overflow':
      return failure('document_layout_overflow', error.message);
    case 'cancelled':
      return failure('generation_cancelled', 'Document generation was cancelled');
    case 'response_failed':
      return failure('generation_failed', 'AI content generation did not complete');
    case 'generation_failed':
    case 'revision_scope_violation':
    case 'revision_patch_failed':
    case 'revision_conflict':
    case 'unvalidated_output':
      return failure('generation_failed', 'Document generation failed');
    case 'storage_error':
      return failure('storage_error', 'Local document storage failed');
  }
}

function failure(
  code: DocumentGenerationIpcErrorCode,
  message: string
): DocumentGenerationIpcResult<never> {
  return { ok: false, error: { code, message } };
}
