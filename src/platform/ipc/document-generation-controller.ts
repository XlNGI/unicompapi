import { createHash } from 'node:crypto';
import {
  InvalidStateTransitionError,
  toConversationId,
  toMessageId,
  toWorkId,
  type Conversation
} from '../../domain';
import {
  ConversationApplicationError,
  type ConversationStreamingService
} from '../../application';
import type {
  DocumentGenerationFromConversationDto,
  DocumentGenerationIpcErrorCode,
  DocumentGenerationIpcResult,
  DocumentOpenResultDto
} from '../../shared/document-generation-ipc';
import { documentGenerationRequestParsers } from '../../shared/document-generation-ipc';
import {
  DocumentGenerationError,
  DocumentOutlineError,
  parseDocumentOutline,
  parseMarkdownToOutline,
  type DocumentGenerationRunner,
  type DocumentOutline
} from '../documents';
import {
  JsonFileReferenceRepository,
  JsonWorkRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import { resolveFileReferencePathSafely } from '../files';
import type { StorageProjectSession } from './storage-ipc-controller';

export interface DocumentGenerationControllerDependencies {
  getSession(): StorageProjectSession | undefined;
  getStreaming(session: StorageProjectSession): ConversationStreamingService;
  loadConversation(
    session: StorageProjectSession,
    conversationId: ReturnType<typeof toConversationId>
  ): Promise<Conversation | undefined>;
  getRunner(session: StorageProjectSession): DocumentGenerationRunner;
  openPath(absolutePath: string): Promise<string>;
  now?(): string;
  createId?(): string;
  onError?(error: unknown): void;
}

export class DocumentGenerationController {
  private readonly operations = new Set<Promise<unknown>>();

  constructor(
    private readonly dependencies: DocumentGenerationControllerDependencies
  ) {}

  generateFromConversation(
    request: unknown
  ): Promise<DocumentGenerationIpcResult<DocumentGenerationFromConversationDto>> {
    return this.execute(async () => {
      const input = documentGenerationRequestParsers.generateFromConversation(request);
      const outline = this.parseOutline(input.outlineJson);
      const session = this.requireSession();
      const streaming = this.dependencies.getStreaming(session);
      const runner = this.dependencies.getRunner(session);
      let currentRevision = input.expectedRevision;
      let messageId: ReturnType<typeof toMessageId> | undefined;
      try {
        const started = await streaming.start({
          conversationId: toConversationId(input.conversationId),
          expectedRevision: input.expectedRevision
        });
        messageId = started.messageId;
        currentRevision = started.conversation.revision;
        const result = await runner.run({
          kind: input.kind,
          title: input.title,
          contentFingerprint: input.contentFingerprint,
          draftRevision: input.draftRevision,
          sourceDraftId: input.sourceDraftId,
          outline
        });
        const content = formatOutlineForMessage(outline);
        const appended = await streaming.append({
          conversationId: toConversationId(input.conversationId),
          messageId,
          expectedRevision: currentRevision,
          chunk: content
        });
        await streaming.complete({
          conversationId: toConversationId(input.conversationId),
          messageId,
          expectedRevision: appended.revision,
          documentResult: {
            workId: result.work.id,
            fileName: result.file.locator.kind === 'project'
              ? result.file.locator.relativePath.split('/').pop() ?? result.work.name
              : result.work.name,
            kind: input.kind,
            sizeBytes: result.file.sizeBytes ?? 0
          }
        });
        return {
          ok: true,
          value: {
            conversationId: input.conversationId,
            messageId,
            taskId: result.task.id,
            executionId: result.execution.id,
            workId: result.work.id,
            fileName:
              result.file.locator.kind === 'project'
                ? result.file.locator.relativePath.split('/').pop() ?? result.work.name
                : result.work.name,
            sizeBytes: result.file.sizeBytes ?? 0
          }
        };
      } catch (error) {
        if (messageId) {
          await this.tryFailMessage(
            streaming,
            toConversationId(input.conversationId),
            messageId,
            currentRevision
          );
        }
        throw error;
      }
    });
  }

  generateFromMessage(
    request: unknown
  ): Promise<DocumentGenerationIpcResult<DocumentGenerationFromConversationDto>> {
    return this.execute(async () => {
      const input = documentGenerationRequestParsers.generateFromMessage(request);
      const session = this.requireSession();
      const streaming = this.dependencies.getStreaming(session);
      const runner = this.dependencies.getRunner(session);
      const conversation = await this.dependencies.loadConversation(
        session,
        toConversationId(input.conversationId)
      );
      if (!conversation) {
        throw new DocumentGenerationError(
          'storage_error',
          'Conversation does not exist'
        );
      }
      const message = conversation.messages.find(
        (item) => item.id === toMessageId(input.messageId)
      );
      if (!message || message.role !== 'assistant' || message.state !== 'completed') {
        throw new DocumentGenerationError(
          'storage_error',
          'Message is not a completed assistant message'
        );
      }
      const outline = parseMarkdownToOutline(message.content, input.kind);
      const contentFingerprint = createHash('sha256')
        .update(message.content)
        .digest('hex');
      const result = await runner.run({
        kind: input.kind,
        title: outline.title,
        contentFingerprint,
        draftRevision: 1,
        sourceDraftId: `message-${input.messageId}`,
        outline,
        ...(input.theme !== undefined ? { theme: input.theme } : {})
      });
      const fileName =
        result.file.locator.kind === 'project'
          ? result.file.locator.relativePath.split('/').pop() ?? result.work.name
          : result.work.name;
      let attached = false;
      for (let attempt = 0; attempt < 3 && !attached; attempt += 1) {
        const current = await this.dependencies.loadConversation(
          session,
          toConversationId(input.conversationId)
        );
        if (!current) {
          throw new DocumentGenerationError(
            'storage_error',
            'Conversation disappeared during document generation'
          );
        }
        try {
          await streaming.attachDocumentResult({
            conversationId: toConversationId(input.conversationId),
            messageId: toMessageId(input.messageId),
            expectedRevision: current.revision,
            documentResult: {
              workId: result.work.id,
              fileName,
              kind: input.kind,
              sizeBytes: result.file.sizeBytes ?? 0
            }
          });
          attached = true;
        } catch (error) {
          if (
            !(error instanceof ConversationApplicationError) ||
            error.code !== 'revision_conflict' ||
            attempt === 2
          ) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      return {
        ok: true,
        value: {
          conversationId: input.conversationId,
          messageId: input.messageId,
          taskId: result.task.id,
          executionId: result.execution.id,
          workId: result.work.id,
          fileName,
          sizeBytes: result.file.sizeBytes ?? 0
        }
      };
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
        throw new DocumentGenerationError(
          'storage_error',
          'Document work does not exist'
        );
      }
      const file = await files.get(work.fileId);
      if (!file) {
        throw new DocumentGenerationError(
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
  }

  private parseOutline(outlineJson: string): DocumentOutline {
    return parseDocumentOutline(outlineJson);
  }

  private requireSession(): StorageProjectSession {
    const session = this.dependencies.getSession();
    if (!session) {
      throw new DocumentGenerationError(
        'storage_error',
        'A project must be open'
      );
    }
    return session;
  }

  private async tryFailMessage(
    streaming: ConversationStreamingService,
    conversationId: ReturnType<typeof toConversationId>,
    messageId: ReturnType<typeof toMessageId>,
    expectedRevision: number
  ): Promise<void> {
    try {
      await streaming.fail({
        conversationId,
        messageId,
        expectedRevision,
        reason: 'unknown'
      });
    } catch {
      // Best effort: the conversation may already have moved past this message.
    }
  }

  private execute<T>(
    operation: () => Promise<DocumentGenerationIpcResult<T>>
  ): Promise<DocumentGenerationIpcResult<T>> {
    let task!: Promise<DocumentGenerationIpcResult<T>>;
    task = operation()
      .catch((error: unknown): DocumentGenerationIpcResult<T> => {
        this.dependencies.onError?.(error);
        if (error instanceof DocumentGenerationError) {
          return failure(
            error.code === 'generation_failed' ? 'generation_failed' : 'storage_error',
            error.message
          );
        }
        if (error instanceof DocumentOutlineError) {
          return failure('invalid_outline', error.message);
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
        return failure(
          'storage_error',
          error instanceof Error ? error.message : 'Document generation failed'
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
  code: DocumentGenerationIpcErrorCode,
  message: string
): DocumentGenerationIpcResult<never> {
  return { ok: false, error: { code, message } };
}

export function formatOutlineForMessage(outline: DocumentOutline): string {
  const blocks: string[] = [outline.title];
  for (const section of outline.sections) {
    blocks.push(section.heading);
    for (const block of section.blocks) {
      if (block.type === 'paragraph' || block.type === 'quote') {
        blocks.push(block.text);
      } else if (block.type === 'bullets' || block.type === 'numbered') {
        block.items.forEach((item) => blocks.push(`- ${item}`));
      } else {
        blocks.push(block.header.join(' | '));
        block.rows.forEach((row) => blocks.push(row.join(' | ')));
      }
    }
  }
  return blocks.join('\n');
}
