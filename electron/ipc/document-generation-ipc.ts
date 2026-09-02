import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { app, ipcMain, shell } from 'electron';
import {
  ConversationStreamingService,
  DocumentGenerationApplicationService
} from '../../src/application';
import { runLocalDocumentRevisionAgent } from '../../src/application';
import { toConversationId, toFileReferenceId, toMessageId } from '../../src/domain';
import {
  AttachmentImportError,
  AttachmentImportService,
  DocumentGenerationController,
  DocumentGenerationRunner,
  FileExtractionError,
  FileExtractionService,
  JsonFileReferenceRepository,
  JsonProjectConversationRepository,
  NodeProjectStorage,
  PlatformDocumentDraftCompiler,
  PlatformDocumentGenerationExecutor,
  applyStructuredDocumentPatch,
  readStructuredDocument,
  extractPptxThemeColors,
  RagRetrievalService,
  resolveFileReferencePathSafely,
  createConfiguredOfficeRenderAdapter,
  type StorageProjectSession,
  type StorageProjectSessionRegistry
} from '../../src/platform';
import {
  documentAttachmentIpcChannels,
  documentAttachmentRequestParsers,
  type DocumentAttachmentIpcErrorCode,
  type DocumentAttachmentIpcResult
} from '../../src/shared/document-attachment-ipc';
import { documentGenerationIpcChannels } from '../../src/shared/document-generation-ipc';
import { toDocumentGenerationLogError } from './document-generation-logging';

export function registerDocumentGenerationIpcHandlers(options: {
  readonly sessionRegistry: StorageProjectSessionRegistry;
}): { waitForOperations(): Promise<void> } {
  const now = () => new Date().toISOString();
  const ids = {
    nextConversationId: () => toConversationId(`conversation-${randomUUID()}`),
    nextMessageId: () => toMessageId(`message-${randomUUID()}`)
  };
  const applications = new Map<string, DocumentGenerationApplicationService>();
  const controller = new DocumentGenerationController({
    getSession: () => options.sessionRegistry.get(),
    getApplication: (session) => {
      const key = `${session.projectId}:${session.rootDirectory}`;
      const existing = applications.get(key);
      if (existing) return existing;
      const storage = new NodeProjectStorage(session.rootDirectory);
      const repository = new JsonProjectConversationRepository(
        storage,
        session.projectId,
        now
      );
      const streaming = new ConversationStreamingService(repository, ids, now);
      const runner = new DocumentGenerationRunner({
        rootDirectory: session.rootDirectory,
        projectId: session.projectId,
        now,
        createId: () => randomUUID(),
        renderPreview: createConfiguredOfficeRenderAdapter()
      });
      const application = new DocumentGenerationApplicationService({
        projectId: session.projectId,
        conversations: {
          load: (conversationId) => repository.get(conversationId),
          attachDocumentResult: async (input) => {
            await streaming.attachDocumentResult(input);
          },
          updateDocumentGenerationStatus: async (input) => {
            await streaming.updateDocumentGenerationStatus(input);
          }
        },
        compiler: new PlatformDocumentDraftCompiler(),
        generator: new PlatformDocumentGenerationExecutor(runner),
        revisionAgent: (input) =>
          runLocalDocumentRevisionAgent(input, {
            readStructure: (outline) => readStructuredDocument(outline),
            applyPatch: (outline, patch) => {
              const result = applyStructuredDocumentPatch(outline, patch);
              return {
                document: result.document,
                changed: result.change.changed,
                affectedSections: result.change.affectedSections
              };
            }
          }),
        fingerprint: (content) =>
          createHash('sha256').update(content).digest('hex')
      });
      applications.set(key, application);
      return application;
    },
    openPath: async (absolutePath) => shell.openPath(absolutePath),
    onError: (error) => {
      const line = `${JSON.stringify({
        at: new Date().toISOString(),
        error: toDocumentGenerationLogError(error)
      })}\n`;
      const logsDirectory = path.join(app.getPath('userData'), 'logs');
      void mkdir(logsDirectory, { recursive: true })
        .then(() =>
          appendFile(
            path.join(logsDirectory, 'document-generation.log'),
            line,
            'utf8'
          )
        )
        .catch(() => undefined);
    }
  });

  ipcMain.handle(
    documentGenerationIpcChannels.prepareGeneration,
    (_event, request: unknown) => controller.prepareGeneration(request)
  );
  ipcMain.handle(
    documentGenerationIpcChannels.reconcileGeneration,
    (_event, request: unknown) => controller.reconcileGeneration(request)
  );
  ipcMain.handle(
    documentGenerationIpcChannels.generateFromMessage,
    (_event, request: unknown) => controller.generateFromMessage(request)
  );
  ipcMain.handle(
    documentGenerationIpcChannels.cancelGeneration,
    (_event, request: unknown) => controller.cancelGeneration(request)
  );
  ipcMain.handle(
    documentGenerationIpcChannels.openDocument,
    (_event, request: unknown) => controller.openDocument(request)
  );
  ipcMain.handle(
    documentAttachmentIpcChannels.importAttachment,
    (_event, request: unknown) =>
      withAttachmentErrors(async () => {
        const input = documentAttachmentRequestParsers.importAttachment(request);
        const session = requireSession(options.sessionRegistry);
        const service = new AttachmentImportService({
          rootDirectory: session.rootDirectory,
          projectId: session.projectId,
          now
        });
        return { ok: true, value: await service.importAttachment(input) };
      })
  );
  ipcMain.handle(
    documentAttachmentIpcChannels.extractFile,
    (_event, request: unknown) =>
      withAttachmentErrors(async () => {
        const input = documentAttachmentRequestParsers.extractFile(request);
        const session = requireSession(options.sessionRegistry);
        const service = new FileExtractionService({
          rootDirectory: session.rootDirectory,
          projectId: session.projectId
        });
        return {
          ok: true,
          value: await service.extract(toFileReferenceId(input.fileId))
        };
      })
  );
  ipcMain.handle(
    documentAttachmentIpcChannels.extractTheme,
    (_event, request: unknown) =>
      withAttachmentErrors(async () => {
        const input = documentAttachmentRequestParsers.extractTheme(request);
        const session = requireSession(options.sessionRegistry);
        const storage = new NodeProjectStorage(session.rootDirectory);
        const files = new JsonFileReferenceRepository(storage, session.projectId);
        const file = await files.get(toFileReferenceId(input.fileId));
        if (!file) {
          throw new AttachmentImportError(
            'storage_error',
            'Attachment file does not exist'
          );
        }
        const absolutePath = await resolveFileReferencePathSafely(
          session.rootDirectory,
          file
        );
        const colors = await extractPptxThemeColors(absolutePath);
        if (!colors) {
          throw new AttachmentImportError(
            'storage_error',
            'PPTX 主题不可用'
          );
        }
        return { ok: true, value: colors };
      })
  );
  ipcMain.handle(
    documentAttachmentIpcChannels.retrieveContext,
    (_event, request: unknown) =>
      withAttachmentErrors(async () => {
        const input = documentAttachmentRequestParsers.retrieveContext(request);
        const session = requireSession(options.sessionRegistry);
        const service = new RagRetrievalService({
          rootDirectory: session.rootDirectory,
          projectId: session.projectId
        });
        return {
          ok: true,
          value: await service.retrieve(input)
        };
      })
  );

  return {
    waitForOperations: async () => {
      await controller.waitForOperations();
    }
  };
}

function requireSession(
  sessionRegistry: StorageProjectSessionRegistry
): StorageProjectSession {
  const session = sessionRegistry.get();
  if (!session) {
    throw new AttachmentImportError(
      'storage_error',
      'A project must be open'
    );
  }
  return session;
}

async function withAttachmentErrors<T>(
  operation: () => Promise<DocumentAttachmentIpcResult<T>>
): Promise<DocumentAttachmentIpcResult<T>> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AttachmentImportError) {
      return attachmentFailure(error.code, error.message);
    }
    if (error instanceof FileExtractionError) {
      return attachmentFailure(error.code, error.message);
    }
    if (error instanceof TypeError) {
      return attachmentFailure('invalid_request', error.message);
    }
    return attachmentFailure(
      'storage_error',
      error instanceof Error ? error.message : 'Attachment operation failed'
    );
  }
}

function attachmentFailure(
  code: DocumentAttachmentIpcErrorCode,
  message: string
): DocumentAttachmentIpcResult<never> {
  return { ok: false, error: { code, message } };
}
