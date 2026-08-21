import { randomUUID } from 'node:crypto';
import { ipcMain, shell } from 'electron';
import {
  ConversationStreamingService
} from '../../src/application';
import { toConversationId, toFileReferenceId, toMessageId } from '../../src/domain';
import {
  AttachmentImportError,
  AttachmentImportService,
  DocumentGenerationController,
  DocumentGenerationRunner,
  FileExtractionError,
  FileExtractionService,
  JsonProjectConversationRepository,
  NodeProjectStorage,
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

export function registerDocumentGenerationIpcHandlers(options: {
  readonly sessionRegistry: StorageProjectSessionRegistry;
}): { waitForOperations(): Promise<void> } {
  const now = () => new Date().toISOString();
  const ids = {
    nextConversationId: () => toConversationId(`conversation-${randomUUID()}`),
    nextMessageId: () => toMessageId(`message-${randomUUID()}`)
  };
  const controller = new DocumentGenerationController({
    getSession: () => options.sessionRegistry.get(),
    getStreaming: (session) => createStreaming(session, now, ids),
    getRunner: (session) =>
      new DocumentGenerationRunner({
        rootDirectory: session.rootDirectory,
        projectId: session.projectId,
        now,
        createId: () => randomUUID()
      }),
    openPath: async (absolutePath) => shell.openPath(absolutePath),
    now,
    createId: () => randomUUID()
  });

  ipcMain.handle(
    documentGenerationIpcChannels.generateFromConversation,
    (_event, request: unknown) => controller.generateFromConversation(request)
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

  return {
    waitForOperations: async () => {
      await controller.waitForOperations();
    }
  };
}

function createStreaming(
  session: StorageProjectSession,
  now: () => string,
  ids: {
    nextConversationId(): ReturnType<typeof toConversationId>;
    nextMessageId(): ReturnType<typeof toMessageId>;
  }
): ConversationStreamingService {
  const storage = new NodeProjectStorage(session.rootDirectory);
  const repository = new JsonProjectConversationRepository(
    storage,
    session.projectId,
    now
  );
  return new ConversationStreamingService(repository, ids, now);
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
