import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { app, ipcMain, shell } from 'electron';
import {
  ConversationIntentOrchestrator,
  ConversationStreamingService,
  ConversationWorkflowService,
  DocumentGenerationApplicationService,
  DocumentTaskRuntimeService
} from '../../src/application';
import { DocumentGenerationRuntimeBridge } from '../../src/application/document-generation-runtime-bridge';
import { runLocalDocumentRevisionAgent } from '../../src/application';
import { toConversationId, toDocumentTaskRuntimeId, toFileReferenceId, toMessageId, toWorkId } from '../../src/domain';
import {
  AttachmentImportError,
  AttachmentImportService,
  DocumentGenerationController,
  DocumentGenerationRunner,
  FileExtractionError,
  FileExtractionService,
  JsonFileReferenceRepository,
  JsonWorkRepository,
  JsonProjectConversationRepository,
  JsonConversationWorkflowRepository,
  JsonDocumentTaskRuntimeRepository,
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
import { createDocumentWorkflowSettlement } from '../../src/platform/documents/conversation-document-workflow';
import { createPresentationWorkflowScope, RegisteredPresentationReader } from '../../src/platform/documents/registered-presentation-reader';
import { ConversationDocumentInputStore } from '../../src/platform/documents/conversation-document-inputs';
import { JsonConversationResponseExecutionRepository } from '../../src/platform/repositories/json-conversation-response-execution-repository';
import { emitProductionEvent } from '../../src/platform/conversation-production-trace';

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
      const taskRuntimeRepository = new JsonDocumentTaskRuntimeRepository(storage, session.projectId, now);
      const runtimeFiles = new JsonFileReferenceRepository(storage, session.projectId);
      const runtimeWorks = new JsonWorkRepository(storage, session.projectId);
      const taskRuntimeService = new DocumentTaskRuntimeService(taskRuntimeRepository, {
        now,
        validateBindings: async (runtime) => {
          if (runtime.projectId !== session.projectId) return false;
          const conversation = await repository.get(runtime.conversationId);
          const message = conversation?.messages.find((item) => item.id === runtime.sourceMessageId);
          if (!conversation || conversation.projectId !== session.projectId ||
              message?.role !== 'assistant' || message.state !== 'completed') return false;
          if (runtime.workRef) {
            try {
              const work = await runtimeWorks.get(toWorkId(runtime.workRef.ref));
              if (!work || work.projectId !== session.projectId) return false;
            } catch { return false; }
          }
          for (const reference of runtime.attachmentRefs) {
            let found = false;
            try { found = Boolean(await runtimeFiles.get(toFileReferenceId(reference))); } catch { /* try Work below */ }
            if (!found) {
              try { found = Boolean(await runtimeWorks.get(toWorkId(reference))); } catch { /* invalid reference */ }
            }
            if (!found) return false;
          }
          return true;
        }
      });
      const streaming = new ConversationStreamingService(repository, ids, now);
      const presentationScope = createPresentationWorkflowScope({ rootDirectory: session.rootDirectory, projectId: session.projectId });
      const workflowService = new ConversationWorkflowService(
        new JsonConversationWorkflowRepository(
          storage,
          session.projectId,
          now
        ),
        new ConversationIntentOrchestrator(),
        now, undefined, undefined, presentationScope
      );
      const runner = new DocumentGenerationRunner({
        rootDirectory: session.rootDirectory,
        projectId: session.projectId,
        now,
        createId: () => randomUUID(),
        renderPreview: createConfiguredOfficeRenderAdapter()
      });
      const application = new DocumentGenerationApplicationService({
        onProgress: async (event) => { await emitProductionEvent(event); },
        runtime: {
          create: async (input) => {
            const executionId = `execution-document-${randomUUID()}`;
            const runtime = await taskRuntimeService.create({
              id: toDocumentTaskRuntimeId(`runtime-document-${randomUUID()}`),
              projectId: session.projectId,
              conversationId: input.conversationId,
              sourceMessageId: input.messageId,
              executionId,
              documentKind: input.kind,
              attachmentRefs: [...new Set(input.images.flatMap((image) => [image.fileId, image.workId].filter((value): value is string => value !== undefined)))],
              ...(input.parentWorkId !== undefined ? { workRef: { kind: 'candidate' as const, ref: input.parentWorkId } } : {}),
              budget: { maxSteps: 32, budgetUnits: 10_000, timeoutMs: 900_000 }
            });
            return new DocumentGenerationRuntimeBridge(taskRuntimeService, {
              id: runtime.id,
              projectId: runtime.projectId,
              conversationId: runtime.conversationId,
              executionId: runtime.executionId
            }, executionId);
          }
        },
        projectId: session.projectId,
        resolvePresentationMap: async (workId, outline) => {
          const source = await new RegisteredPresentationReader({ rootDirectory: session.rootDirectory, projectId: session.projectId }).read(workId, outline);
          return source.map!;
        },
        validatePresentationSelection: presentationScope.validatePresentationSelection,
        canRetryMessage: presentationScope.canRetryMessage,
        generationInputs: new ConversationDocumentInputStore(storage, session.projectId),
        conversations: {
          load: (conversationId) => repository.get(conversationId),
          createCompletedLocalAssistantMessage: (input) =>
            streaming.createCompletedLocalAssistantMessage(input),
          attachDocumentResult: async (input) => {
            await streaming.attachDocumentResult(input);
          },
          updateDocumentGenerationStatus: async (input) => {
            await streaming.updateDocumentGenerationStatus(input);
          }
        },
        workflows: {
          bindDocumentMessage: (executionId, messageId) => workflowService.bindDocumentMessage(executionId, messageId),
          load: (workflowId) => workflowService.get(workflowId),
          beginExecution: async (input) => {
            await workflowService.beginExecution(input);
          },
          finishExecution: async (executionId, status) => {
            await workflowService.finishExecution(executionId, status);
          },
          settleDocumentResult: createDocumentWorkflowSettlement({
            workflows: workflowService,
            conversations: repository,
            executions: new JsonConversationResponseExecutionRepository(storage, session.projectId)
          })
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
          createHash('sha256').update(content).digest('hex'),
        nextLocalExecutionId: () =>
          `local-document-revision-${randomUUID()}`
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
    documentGenerationIpcChannels.prepareDeterministicRevision,
    (_event, request: unknown) =>
      controller.prepareDeterministicRevision(request)
  );
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
        return { ok: true, value: 'image' in input ? await service.importImage(input.image) : await service.importAttachment(input) };
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
