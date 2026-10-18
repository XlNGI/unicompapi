import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { app, ipcMain, shell } from 'electron';
import {
  ConversationIntentOrchestrator,
  ConversationStreamingService,
  ConversationWorkflowService,
  DocumentGenerationApplicationService,
  DocumentTaskRuntimeService,
  type DocumentLlmRepairPlannerRequest
} from '../../src/application';
import { DocumentGenerationRuntimeBridge } from '../../src/application/document-generation-runtime-bridge';

import { toConversationId, toDocumentTaskRuntimeId, toFileReferenceId, toMessageId, toWorkId } from '../../src/domain';
import { AttachmentImportError, AttachmentImportService, DocumentGenerationController, DocumentGenerationRunner, FileExtractionError, FileExtractionService, JsonFileReferenceRepository, JsonWorkRepository, JsonProjectConversationRepository, JsonConversationWorkflowRepository, JsonDocumentTaskRuntimeRepository, NodeProjectStorage, PlatformDocumentDraftCompiler, PlatformDocumentGenerationExecutor, extractPptxThemeColors, RagRetrievalService, resolveFileReferencePathSafely, createConfiguredOfficeRenderAdapter, ConversationSemanticClassifier, featureCandidateId, type StorageProjectSession, type StorageProjectSessionRegistry, type ConversationTextSubmissionRuntimes, type JsonProviderRegistryStore, type ProviderCandidateRuntimeAuthorizationPort, type RuntimeAuthorizationOrchestrationPort, type ProviderPackageRegistry } from '../../src/platform';
import {
  documentAttachmentIpcChannels,
  documentAttachmentRequestParsers,
  type DocumentAttachmentIpcErrorCode,
  type DocumentAttachmentIpcResult
} from '../../src/shared/document-attachment-ipc';
import { documentGenerationIpcChannels } from '../../src/shared/document-generation-ipc';
import { toDocumentGenerationLogError } from './document-generation-logging';
import { createDocumentWorkflowSettlement } from '../../src/platform/documents/conversation-document-workflow';
import { createPresentationWorkflowScope } from '../../src/platform/documents/registered-presentation-reader';
import { ConversationDocumentInputStore } from '../../src/platform/documents/conversation-document-inputs';
import { JsonConversationResponseExecutionRepository } from '../../src/platform/repositories/json-conversation-response-execution-repository';
import { JsonProviderExecutionRouteSnapshotRepository } from '../../src/platform/repositories/json-provider-execution-route-snapshot-repository';
import { JsonProviderInvocationRepository } from '../../src/platform/repositories/json-provider-invocation-repository';
import { JsonProviderUsageObservationRepository } from '../../src/platform/repositories/json-provider-usage-repository';
import { emitProductionEvent } from '../../src/platform/conversation-production-trace';
import { HostExecutionBudget } from '../../src/application/execution-budget';
import type { ProjectConversationRepository } from '../../src/domain';
import { ThreadConversationRepository } from '../../src/platform/repositories/thread-conversation-repository';

export function registerDocumentGenerationIpcHandlers(options: {
  getConversationRepository?(session: StorageProjectSession): Promise<ProjectConversationRepository>;
  readonly sessionRegistry: StorageProjectSessionRegistry;
  readonly providerRegistry?: JsonProviderRegistryStore;
  readonly providerPackages?: ProviderPackageRegistry;
  readonly runtimeAuthorization?: ProviderCandidateRuntimeAuthorizationPort & RuntimeAuthorizationOrchestrationPort;
  readonly textSubmission?: Omit<ConversationTextSubmissionRuntimes, 'providerRegistry' | 'providerPackages' | 'usage'>;
}): { waitForOperations(): Promise<void> } {
  const now = () => new Date().toISOString();
  const ids = {
    nextConversationId: () => toConversationId(`conversation-${randomUUID()}`),
    nextMessageId: () => toMessageId(`message-${randomUUID()}`)
  };
  const applications = new Map<string, DocumentGenerationApplicationService>();
  const getConversationRepository = (session: StorageProjectSession): Promise<ProjectConversationRepository> => {
    if (options.getConversationRepository) return options.getConversationRepository(session);
    if (process.env.UNICOMP_THREAD_FIRST !== '0') return Promise.reject(new Error('thread_conversation_repository_unavailable'));
    return Promise.resolve(new JsonProjectConversationRepository(new NodeProjectStorage(session.rootDirectory), session.projectId, now));
  };
  const controller = new DocumentGenerationController({
    getConversation: async (session, id) => (await getConversationRepository(session)).get(id),
    getSession: () => options.sessionRegistry.get(),
    getApplication: (session) => {
      const key = `${session.projectId}:${session.rootDirectory}`;
      const existing = applications.get(key);
      if (existing) return existing;
      const storage = new NodeProjectStorage(session.rootDirectory);
      const repository: ProjectConversationRepository = { projectId: session.projectId,
        get: async id => (await getConversationRepository(session)).get(id),
        list: async input => (await getConversationRepository(session)).list(input),
        create: async input => (await getConversationRepository(session)).create(input),
        save: async (input, expectedRevision) => (await getConversationRepository(session)).save(input, expectedRevision) };
      const taskRuntimeRepository = new JsonDocumentTaskRuntimeRepository(storage, session.projectId, now);
      const runtimeFiles = new JsonFileReferenceRepository(storage, session.projectId);
      const runtimeWorks = new JsonWorkRepository(storage, session.projectId);
      const invocationRoutes = new JsonProviderExecutionRouteSnapshotRepository(storage, session.projectId);
      const invocations = new JsonProviderInvocationRepository(storage, session.projectId);
      const usage = new JsonProviderUsageObservationRepository(storage);
      const repairClassifier = options.providerRegistry && options.providerPackages &&
        options.runtimeAuthorization && options.textSubmission
        ? new ConversationSemanticClassifier({
            projectId: session.projectId,
            runtimes: {
              ...options.textSubmission,
              providerRegistry: options.providerRegistry,
              providerPackages: options.providerPackages,
              usage
            },
            authorization: options.runtimeAuthorization,
            audit: { routes: invocationRoutes, invocations, usage },
            now
          })
        : undefined;
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
      const presentationScope = createPresentationWorkflowScope({ rootDirectory: session.rootDirectory, projectId: session.projectId, conversations: repository });
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
        renderPreview: createConfiguredOfficeRenderAdapter(),
        requireRenderForPpt: true
      });
      const application = new DocumentGenerationApplicationService({
        onProgress: async (event) => { await emitProductionEvent(event); },
        runtime: {
          create: async (input, signal) => {
            const executionId = `execution-document-${randomUUID()}`;
            const runtime = await taskRuntimeService.create({
              id: toDocumentTaskRuntimeId(`runtime-document-${randomUUID()}`),
              projectId: session.projectId,
              conversationId: input.conversationId,
              sourceMessageId: input.messageId,
              executionId,
              documentKind: input.kind,
              operation: input.operation ?? (input.parentWorkId !== undefined ? 'edit' : 'create'),
              attachmentRefs: [...new Set(input.images.flatMap((image) => [image.fileId, image.workId].filter((value): value is string => value !== undefined)))],
              ...(input.parentWorkId !== undefined ? { workRef: { kind: 'candidate' as const, ref: input.parentWorkId } } : {}),
              budget: { maxSteps: 32, budgetUnits: 10_000, timeoutMs: 900_000 }
            });
            return new DocumentGenerationRuntimeBridge(taskRuntimeService, {
              id: runtime.id,
              projectId: runtime.projectId,
              conversationId: runtime.conversationId,
              executionId: runtime.executionId
            }, executionId, runtime.operation, new HostExecutionBudget({ startedAt: Date.parse(runtime.createdAt),
              deadlineAt: Date.parse(runtime.createdAt) + runtime.budget.timeoutMs,
              maxToolCalls: runtime.budget.maxSteps, budgetUnits: runtime.budget.budgetUnits }, { signal,
              onDiagnostic: diagnostic => emitProductionEvent({ code: 'model_response', operationId: 'execution_budget',
                status: diagnostic.stopReason === 'cancelled' ? 'cancelled' : 'failed', facts: diagnostic }) }));
          }
        },
        projectId: session.projectId,
        canRetryMessage: presentationScope.canRetryMessage,
        generationInputs: new ConversationDocumentInputStore(storage, session.projectId),
        conversations: {
          load: (conversationId) => repository.get(conversationId),
          createCompletedLocalAssistantMessage: (input) =>
            streaming.createCompletedLocalAssistantMessage(input),
          attachDocumentResult: async (input) => {
            const owner = await getConversationRepository(session);
            const work = await runtimeWorks.get(input.documentResult.workId);
            const file = work ? await runtimeFiles.get(work.fileId) : undefined;
            if (!work || work.projectId !== session.projectId || work.mediaKind !== 'document' || !file || file.projectId !== session.projectId ||
                file.state !== 'available' || file.sourceExecutionId !== work.sourceExecutionId || file.sizeBytes !== input.documentResult.sizeBytes ||
                !file.checksumSha256 || file.locator.kind !== 'project' || path.basename(file.locator.relativePath) !== input.documentResult.fileName) throw new Error('document_receipt_file_unavailable');
            const bytes = await readFile(await resolveFileReferencePathSafely(session.rootDirectory, file));
            if (bytes.length !== file.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== file.checksumSha256) throw new Error('document_receipt_file_changed');
            await streaming.attachDocumentResult(input);
            if (owner instanceof ThreadConversationRepository) {
              const conversation = await owner.get(input.conversationId);
              const index = conversation?.messages.findIndex(message => message.id === input.messageId) ?? -1;
              const message = index < 0 ? undefined : conversation!.messages[index];
              const source = conversation?.messages.slice(0, index).reverse().find(message => message.role === 'user');
              if (message && source) await owner.projectDocumentArtifact({ threadId: input.conversationId, sourceMessageId: source.id,
                workId: work.id, status: 'completed', content: `${input.documentResult.fileName} (${input.documentResult.kind})`,
                createdAt: message.createdAt, updatedAt: message.updatedAt, legacyMessageSnapshot: { documentResult: input.documentResult } });
            }
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
        ...(repairClassifier ? { artDirectionPlanner: async (request) => {
          const active = options.sessionRegistry.get();
          if (request.signal.aborted || active?.projectId !== session.projectId || active.rootDirectory !== session.rootDirectory) {
            throw new Error('art_direction_session_unavailable');
          }
          const execution = (await new JsonConversationResponseExecutionRepository(storage, session.projectId)
            .list(request.conversationId)).find(item => item.snapshot.assistantMessageId === request.messageId);
          const route = execution ? await invocationRoutes.get(execution.snapshot.routeSnapshotId) : undefined;
          if (!route || (route.productFeature !== 'text_chat' && route.productFeature !== 'text_reasoning')) {
            throw new Error('art_direction_route_unavailable');
          }
          return repairClassifier.planArtDirection({
            candidateId: featureCandidateId(route.modelId, route.profileId, route.productFeature),
            productFeature: route.productFeature, input: request.input, signal: request.signal, timeoutMs: request.timeoutMs
          });
        } } : {}),
        ...(repairClassifier ? { llmRepairPlanner: async (request: DocumentLlmRepairPlannerRequest) => {
          const execution = (await new JsonConversationResponseExecutionRepository(storage, session.projectId)
            .list(request.conversationId))
            .find((item) => item.snapshot.assistantMessageId === request.messageId);
          if (!execution) throw new Error('llm_repair_route_unavailable');
          const route = await invocationRoutes.get(execution.snapshot.routeSnapshotId);
          if (!route || (route.productFeature !== 'text_chat' && route.productFeature !== 'text_reasoning')) {
            throw new Error('llm_repair_route_unavailable');
          }
          return repairClassifier.planDocumentRepair({
            candidateId: featureCandidateId(route.modelId, route.profileId, route.productFeature),
            productFeature: route.productFeature,
            outline: request.outline,
            diagnostics: request.diagnostics,
            expectedRevision: request.expectedRevision,
            attempt: request.attempt,
            signal: request.signal
          });
        } } : {}),
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
