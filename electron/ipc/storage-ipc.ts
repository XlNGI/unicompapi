import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import {
  StorageIpcController,
  JsonProjectCatalogStore,
  GlobalReadModelController,
  ProviderInvocationReadModelController,
  ControlledLocalMediaController,
  ImageLocalMediaController,
  ImageFeatureController,
  VideoFeatureController,
  PromptEnhanceController,
  ImageSubmissionController,
  ImageWorkspaceController,
  ImageWorkspaceMutationCoordinator,
  ProjectSessionController,
  ProjectCatalogService,
  JsonProviderRegistryStore,
  JsonImageWorkspaceRepository,
  JsonProjectContextRepository,
  JsonProviderExecutionRouteSnapshotRepository,
  JsonProviderInvocationRepository,
  JsonProviderUsageObservationRepository,
  LocalMediaHandleRegistry,
  NodeProjectStorage,
  StorageProjectSessionRegistry,
  VideoReferenceMediaController,
  VideoEditorController,
  VideoEditorMediaController,
  VideoExportController,
  type ExportLifecycleInterruptionReason,
  createFfmpegMediaEngineAdapterFromEnvironment,
  VideoWorkspaceController,
  VideoWorkspaceMutationCoordinator,
  createDevelopmentVideoEditorPreviewAdapter,
  type ProviderUsageSchemaResolverPort,
  type StorageProjectSession,
  ProviderPackageRegistry,
  createImageFeatureControllerRuntime,
  createVideoFeatureControllerRuntime,
  type ImageFeatureControllerRuntime,
  type VideoFeatureControllerRuntime,
  type ProviderCandidateRuntimeAuthorizationPort,
  type RuntimeAuthorizationOrchestrationPort,
  PromptEnhanceService,
  ImagePromptEnhanceSubjectAdapter,
  type DeepSeekSharedRuntime,
  type NewApiSharedRuntime,
  type NewApiImageDownloadPort,
  type SecureCredentialVault,
  deepSeekProviderPackageDescriptor,
  klingProviderPackageDescriptor,
  newApiProviderPackageDescriptor,
  viduProviderPackageDescriptor,
  volcengineProviderPackageDescriptor
} from '../../src/platform';
import { storageIpcChannels } from '../../src/shared/storage-ipc';
import { imageWorkspaceIpcChannels } from '../../src/shared/image-workspace-ipc';
import { imageSubmissionIpcChannels } from '../../src/shared/image-submission-ipc';
import { imageFeatureIpcChannels } from '../../src/shared/image-feature-ipc';
import { promptEnhanceIpcChannels } from '../../src/shared/prompt-enhance-ipc';
import { videoWorkspaceIpcChannels } from '../../src/shared/video-workspace-ipc';
import { videoFeatureIpcChannels } from '../../src/shared/video-feature-ipc';
import { videoEditorIpcChannels } from '../../src/shared/video-editor-ipc';
import type { ElectronViduComposition } from './vidu-composition';

export interface StorageIpcLifecycle {
  resolveEntry(token: string): ReturnType<LocalMediaHandleRegistry['resolveEntry']>;
  readonly activeExportCount: number;
  interruptActiveExports(reason: ExportLifecycleInterruptionReason): Promise<number>;
  dispose(): Promise<void>;
}

export function registerStorageIpcHandlers(options: {
  readonly onActiveExportCountChanged?: (count: number) => void;
  readonly sessionRegistry?: StorageProjectSessionRegistry;
  readonly additionalSessionChangeGuards?: readonly (() => Promise<void>)[];
  readonly vidu?: ElectronViduComposition;
  readonly providerUsageSchemas?: ProviderUsageSchemaResolverPort;
  readonly providerPackages?: ProviderPackageRegistry;
  readonly runtimeAuthorization?: ProviderCandidateRuntimeAuthorizationPort &
    Partial<RuntimeAuthorizationOrchestrationPort>;
  readonly textSubmission?: {
    readonly credentialVault: SecureCredentialVault;
    readonly deepSeekRuntime: DeepSeekSharedRuntime;
    readonly newApiRuntime: NewApiSharedRuntime;
    readonly newApiImageDownloads?: NewApiImageDownloadPort;
  };
} = {}): StorageIpcLifecycle {
  const sessionRegistry = options.sessionRegistry ?? new StorageProjectSessionRegistry();
  const choosePath = async (
    properties: Electron.OpenDialogOptions['properties'],
    filters?: Electron.FileFilter[]
  ) => {
    const window = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = { properties, filters };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);

    return result.canceled ? undefined : result.filePaths[0];
  };
  const controller = new StorageIpcController({
    getSession: () => sessionRegistry.get(),
    chooseRelinkFile: () => choosePath(['openFile']),
    chooseBackupFile: () => choosePath(['openFile'])
  });
  const mediaHandles = new LocalMediaHandleRegistry();
  const imageMutations = new ImageWorkspaceMutationCoordinator();
  const videoMutations = new VideoWorkspaceMutationCoordinator();
  const providerRegistry = options.vidu?.registry ?? new JsonProviderRegistryStore(
    path.join(app.getPath('userData'), 'provider-registry.json')
  );
  const providerPackages = options.providerPackages ?? new ProviderPackageRegistry([
    deepSeekProviderPackageDescriptor,
    volcengineProviderPackageDescriptor,
    klingProviderPackageDescriptor,
    newApiProviderPackageDescriptor,
    viduProviderPackageDescriptor
  ]);
  const providerOperations = options.vidu?.createOperationPorts({
    getSession: () => sessionRegistry.get(),
    imageMutations,
    videoMutations,
    newApiRuntime: options.textSubmission?.newApiRuntime
  });
  const imageWorkspaces = new ImageWorkspaceController({
    getSession: () => sessionRegistry.get(),
    mutations: imageMutations
  });
  let imageFeatureRuntime: {
    readonly projectId: string;
    readonly rootDirectory: string;
    readonly value: ImageFeatureControllerRuntime;
  } | undefined;
  const getImageFeatureRuntime = (session: StorageProjectSession) => {
    if (
      imageFeatureRuntime?.projectId === session.projectId &&
      imageFeatureRuntime.rootDirectory === session.rootDirectory
    ) {
      return imageFeatureRuntime.value;
    }
    const authorization = options.runtimeAuthorization ?? denyRuntimeAuthorization;
    const value = createImageFeatureControllerRuntime({
      session,
      providerRegistry,
      providerPackages,
      runtimeAuthorization: authorization,
      submissionAuthorization: hasSubmissionAuthorization(authorization)
        ? authorization
        : undefined,
      ...(options.vidu
        ? {
            imageSubmission: {
              viduPackage: options.vidu.providerPackage,
              credentialVault: options.vidu.credentialVault,
              ...(options.textSubmission?.newApiRuntime &&
              options.textSubmission.newApiImageDownloads
                ? {
                    newApiRuntime: options.textSubmission.newApiRuntime,
                    newApiDownloads: options.textSubmission.newApiImageDownloads
                  }
                : {})
            },
            resultReceiver: providerOperations?.imageResultReceiver
          }
        : {}),
      mutations: imageMutations
    });
    imageFeatureRuntime = {
      projectId: session.projectId,
      rootDirectory: session.rootDirectory,
      value
    };
    return value;
  };
  const imageFeatures = new ImageFeatureController({
    getSession: () => sessionRegistry.get(),
    getRuntime: getImageFeatureRuntime,
    mutations: imageMutations
  });
  let promptEnhanceRuntime: {
    readonly projectId: string;
    readonly rootDirectory: string;
    readonly value: PromptEnhanceService;
  } | undefined;
  const getPromptEnhanceService = (session: StorageProjectSession) => {
    if (!options.textSubmission) return undefined;
    if (
      promptEnhanceRuntime?.projectId === session.projectId &&
      promptEnhanceRuntime.rootDirectory === session.rootDirectory
    ) {
      return promptEnhanceRuntime.value;
    }
    const authorization = options.runtimeAuthorization ?? denyRuntimeAuthorization;
    const storage = new NodeProjectStorage(session.rootDirectory);
    const drafts = new JsonImageWorkspaceRepository(storage, session.projectId);
    const contexts = new JsonProjectContextRepository(storage, session.projectId);
    const audit = {
      routes: new JsonProviderExecutionRouteSnapshotRepository(storage, session.projectId),
      invocations: new JsonProviderInvocationRepository(storage, session.projectId),
      usage: new JsonProviderUsageObservationRepository(storage)
    };
    const value = new PromptEnhanceService({
      projectId: session.projectId,
      subjects: new ImagePromptEnhanceSubjectAdapter({
        projectId: session.projectId,
        drafts,
        contexts
      }),
      runtimes: {
        deepSeekRuntime: options.textSubmission.deepSeekRuntime,
        newApiRuntime: options.textSubmission.newApiRuntime,
        credentialVault: options.textSubmission.credentialVault,
        providerRegistry,
        providerPackages
      },
      runtimeAuthorization: authorization,
      submissionAuthorization: hasSubmissionAuthorization(authorization)
        ? authorization
        : undefined,
      audit
    });
    promptEnhanceRuntime = {
      projectId: session.projectId,
      rootDirectory: session.rootDirectory,
      value
    };
    return value;
  };
  const promptEnhance = new PromptEnhanceController({
    getSession: () => sessionRegistry.get(),
    getService: getPromptEnhanceService
  });
  const imageLocalMedia = new ImageLocalMediaController({
    getSession: () => sessionRegistry.get(),
    chooseImageFile: () => choosePath(['openFile']),
    handles: mediaHandles,
    mutations: imageMutations
  });
  const imageSubmissions = new ImageSubmissionController({
    getSession: () => sessionRegistry.get(),
    providerRegistry,
    mutations: imageMutations,
    operationPorts: providerOperations?.image,
    resultReceiver: providerOperations?.imageResultReceiver
  });
  const videoWorkspaces = new VideoWorkspaceController({
    getSession: () => sessionRegistry.get(),
    mutations: videoMutations
  });
  let videoFeatureRuntime: {
    readonly projectId: string;
    readonly rootDirectory: string;
    readonly value: VideoFeatureControllerRuntime;
  } | undefined;
  const getVideoFeatureRuntime = (session: StorageProjectSession) => {
    if (
      videoFeatureRuntime?.projectId === session.projectId &&
      videoFeatureRuntime.rootDirectory === session.rootDirectory
    ) {
      return videoFeatureRuntime.value;
    }
    const authorization = options.runtimeAuthorization ?? denyRuntimeAuthorization;
    const value = createVideoFeatureControllerRuntime({
      session,
      providerRegistry,
      providerPackages,
      runtimeAuthorization: authorization,
      submissionAuthorization: hasSubmissionAuthorization(authorization)
        ? authorization
        : undefined,
      ...(options.vidu
        ? {
            videoSubmission: {
              viduPackage: options.vidu.providerPackage,
              credentialVault: options.vidu.credentialVault,
              ...(options.textSubmission?.newApiRuntime
                ? {
                    newApiRuntime: options.textSubmission.newApiRuntime,
                    ...(providerOperations?.newApiVideoAdapter
                      ? { newApiVideoAdapter: providerOperations.newApiVideoAdapter }
                      : {})
                  }
                : {})
            },
            asyncOperationPort: providerOperations?.videoAsync,
            rememberVideoOperation: providerOperations?.rememberVideoOperation,
            attachNewApiVideoOperation: providerOperations?.attachNewApiVideoOperation,
            resultReceiver: providerOperations?.videoResultReceiver
          }
        : {}),
      mutations: videoMutations
    });
    videoFeatureRuntime = {
      projectId: session.projectId,
      rootDirectory: session.rootDirectory,
      value
    };
    return value;
  };
  const videoFeatures = new VideoFeatureController({
    getSession: () => sessionRegistry.get(),
    getRuntime: getVideoFeatureRuntime,
    mutations: videoMutations
  });
  const videoEditors = new VideoEditorController({
    getSession: () => sessionRegistry.get(),
    mutations: videoMutations
  });
  const mediaEngine = createFfmpegMediaEngineAdapterFromEnvironment();
  const previewAdapter = mediaEngine ?? createDevelopmentVideoEditorPreviewAdapter();
  const videoEditorMedia = new VideoEditorMediaController({
    getSession: () => sessionRegistry.get(),
    chooseAudioFile: () =>
      choosePath(
        ['openFile'],
        [
          { name: 'WAV audio', extensions: ['wav'] },
          { name: 'All files', extensions: ['*'] }
        ]
      ),
    chooseImageFile: () =>
      choosePath(
        ['openFile'],
        [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
          { name: 'All files', extensions: ['*'] }
        ]
      ),
    chooseVideoFile: () =>
      choosePath(
        ['openFile'],
        [
          { name: 'Videos', extensions: ['mp4', 'm4v', 'mov'] },
          { name: 'All files', extensions: ['*'] }
        ]
    ),
    handles: mediaHandles,
    editor: videoEditors,
    previewAdapter
  });
  const videoExports = new VideoExportController({
    getSession: () => sessionRegistry.get(),
    getAdapter: () => mediaEngine,
    onActiveCountChanged: options.onActiveExportCountChanged
  });
  const videoReferenceMedia = new VideoReferenceMediaController({
    getSession: () => sessionRegistry.get(),
    chooseMediaFile: (mediaKind) =>
      choosePath(
        ['openFile'],
        mediaKind === 'image'
          ? [
              { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
              { name: 'All files', extensions: ['*'] }
            ]
          : [
              { name: 'Videos', extensions: ['mp4', 'm4v', 'mov'] },
              { name: 'All files', extensions: ['*'] }
            ]
      ),
    handles: mediaHandles,
    mutations: videoMutations
  });
  const catalog = new ProjectCatalogService(
    new JsonProjectCatalogStore(path.join(app.getPath('userData'), 'project-catalog.json'))
  );
  const readModels = new GlobalReadModelController(catalog, () => sessionRegistry.get());
  const projectStorageMonitor = new ProjectStorageChangeMonitor(
    catalog,
    () => readModels.invalidateLocalStorageSummary(),
    () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) {
          window.webContents.send(storageIpcChannels.localStorageChanged);
        }
      }
    }
  );
  projectStorageMonitor.start();
  const callReadModels = new ProviderInvocationReadModelController(
    catalog,
    options.providerUsageSchemas
  );
  const localMedia = new ControlledLocalMediaController({
    catalog,
    handles: mediaHandles,
    revealFile: (target) => shell.showItemInFolder(target)
  });
  const projectController = new ProjectSessionController({
    registry: sessionRegistry,
    chooseProjectDirectory: () => choosePath(['openDirectory']),
    beforeSessionChange: async () => {
      await Promise.all([
        controller.waitForMutations(),
        imageWorkspaces.waitForMutations(),
        imageFeatures.waitForOperations(),
        promptEnhance.waitForOperations(),
        videoWorkspaces.waitForMutations(),
        videoFeatures.waitForOperations(),
        videoEditors.waitForMutations(),
        ...(options.additionalSessionChangeGuards ?? []).map((guard) => guard())
      ]);
    },
    afterSessionChange: async () => {
      imageFeatureRuntime = undefined;
      promptEnhanceRuntime = undefined;
      videoFeatureRuntime = undefined;
      await videoExports.recoverExports();
      await projectStorageMonitor.sync();
      projectStorageMonitor.publishNow();
    },
    catalog
  });

  ipcMain.handle(storageIpcChannels.probeFile, (_event, request: unknown) =>
    controller.probeFile(request)
  );
  ipcMain.handle(storageIpcChannels.verifyFile, (_event, request: unknown) =>
    controller.verifyFile(request)
  );
  ipcMain.handle(storageIpcChannels.relinkFile, (_event, request: unknown) =>
    controller.relinkFile(request)
  );
  ipcMain.handle(storageIpcChannels.restoreBackup, (_event, request: unknown) =>
    controller.restoreBackup(request)
  );
  ipcMain.handle(storageIpcChannels.rebuildIndex, () =>
    controller.rebuildIndex()
  );
  ipcMain.handle(storageIpcChannels.openProject, () =>
    projectController.openProject()
  );
  ipcMain.handle(storageIpcChannels.openRecentProject, (_event, request: unknown) =>
    projectController.openRecentProject(request)
  );
  ipcMain.handle(storageIpcChannels.createProject, (_event, request: unknown) =>
    projectController.createProject(request)
  );
  ipcMain.handle(storageIpcChannels.listProjects, () =>
    projectController.listProjects()
  );
  ipcMain.handle(storageIpcChannels.getLocalStorageSummary, () =>
    readModels.getLocalStorageSummary()
  );
  ipcMain.handle(storageIpcChannels.listTasks, () => readModels.listTasks());
  ipcMain.handle(storageIpcChannels.getTaskDetails, (_event, request: unknown) =>
    readModels.getTaskDetails(request)
  );
  ipcMain.handle(storageIpcChannels.listCallRecords, (_event, request: unknown) =>
    callReadModels.listCallRecords(request)
  );
  ipcMain.handle(storageIpcChannels.getCallDetails, (_event, request: unknown) =>
    callReadModels.getCallDetails(request)
  );
  ipcMain.handle(storageIpcChannels.listWorks, () => readModels.listWorks());
  ipcMain.handle(storageIpcChannels.getWorkDetails, (_event, request: unknown) =>
    readModels.getWorkDetails(request)
  );
  ipcMain.handle(
    storageIpcChannels.createWorkMediaHandle,
    (_event, request: unknown) => localMedia.createHandle(request)
  );
  ipcMain.handle(storageIpcChannels.revealWorkFile, (_event, request: unknown) =>
    localMedia.revealWorkFile(request)
  );
  ipcMain.handle(storageIpcChannels.closeProject, () =>
    projectController.closeProject()
  );
  ipcMain.handle(storageIpcChannels.getProjectSession, () =>
    projectController.getProjectSession()
  );
  ipcMain.handle(imageWorkspaceIpcChannels.create, (_event, request: unknown) =>
    imageWorkspaces.create(request)
  );
  ipcMain.handle(imageWorkspaceIpcChannels.get, (_event, request: unknown) =>
    imageWorkspaces.get(request)
  );
  ipcMain.handle(imageWorkspaceIpcChannels.update, (_event, request: unknown) =>
    imageWorkspaces.update(request)
  );
  ipcMain.handle(imageWorkspaceIpcChannels.list, () => imageWorkspaces.list());
  ipcMain.handle(imageWorkspaceIpcChannels.derive, (_event, request: unknown) =>
    imageWorkspaces.derive(request)
  );
  ipcMain.handle(
    imageWorkspaceIpcChannels.selectInput,
    (_event, request: unknown) => imageLocalMedia.selectInput(request)
  );
  ipcMain.handle(
    imageWorkspaceIpcChannels.clearInput,
    (_event, request: unknown) => imageLocalMedia.clearInput(request)
  );
  ipcMain.handle(
    imageWorkspaceIpcChannels.getInput,
    (_event, request: unknown) => imageLocalMedia.getInput(request)
  );
  ipcMain.handle(
    imageWorkspaceIpcChannels.createInputPreview,
    (_event, request: unknown) => imageLocalMedia.createInputPreview(request)
  );
  ipcMain.handle(
    imageSubmissionIpcChannels.preflight,
    (_event, request: unknown) => imageSubmissions.preflight(request)
  );
  ipcMain.handle(
    imageSubmissionIpcChannels.createTask,
    (_event, request: unknown) => imageSubmissions.createTask(request)
  );
  ipcMain.handle(
    imageSubmissionIpcChannels.createExecution,
    (_event, request: unknown) => imageSubmissions.createExecution(request)
  );
  ipcMain.handle(
    imageSubmissionIpcChannels.invokeExecution,
    (_event, request: unknown) => imageSubmissions.invokeExecution(request)
  );
  ipcMain.handle(
    imageSubmissionIpcChannels.receiveResult,
    (_event, request: unknown) => imageSubmissions.receiveResult(request)
  );
  ipcMain.handle(
    imageFeatureIpcChannels.listCandidates,
    (_event, request: unknown) => imageFeatures.listCandidates(request)
  );
  ipcMain.handle(
    imageFeatureIpcChannels.prepareSubmission,
    (_event, request: unknown) => imageFeatures.prepareSubmission(request)
  );
  ipcMain.handle(
    imageFeatureIpcChannels.submitDraft,
    (_event, request: unknown) => imageFeatures.submitDraft(request)
  );
  ipcMain.handle(
    imageFeatureIpcChannels.generateQuickImage,
    (_event, request: unknown) => imageFeatures.generateQuickImage(request)
  );
  ipcMain.handle(
    imageFeatureIpcChannels.recoverResult,
    (_event, request: unknown) => imageFeatures.recoverResult(request)
  );
  ipcMain.handle(
    promptEnhanceIpcChannels.listCandidates,
    (_event, request: unknown) => promptEnhance.listCandidates(request)
  );
  ipcMain.handle(
    promptEnhanceIpcChannels.prepare,
    (_event, request: unknown) => promptEnhance.prepare(request)
  );
  ipcMain.handle(
    promptEnhanceIpcChannels.submit,
    (_event, request: unknown) => promptEnhance.submit(request)
  );
  ipcMain.handle(videoWorkspaceIpcChannels.create, (_event, request: unknown) =>
    videoWorkspaces.create(request)
  );
  ipcMain.handle(videoWorkspaceIpcChannels.get, (_event, request: unknown) =>
    videoWorkspaces.get(request)
  );
  ipcMain.handle(videoWorkspaceIpcChannels.update, (_event, request: unknown) =>
    videoWorkspaces.update(request)
  );
  ipcMain.handle(videoWorkspaceIpcChannels.list, () => videoWorkspaces.list());
  ipcMain.handle(videoWorkspaceIpcChannels.derive, (_event, request: unknown) =>
    videoWorkspaces.derive(request)
  );
  ipcMain.handle(
    videoFeatureIpcChannels.listCandidates,
    (_event, request: unknown) => videoFeatures.listCandidates(request)
  );
  ipcMain.handle(
    videoFeatureIpcChannels.prepareSubmission,
    (_event, request: unknown) => videoFeatures.prepareSubmission(request)
  );
  ipcMain.handle(
    videoFeatureIpcChannels.submitDraft,
    (_event, request: unknown) => videoFeatures.submitDraft(request)
  );
  ipcMain.handle(
    videoFeatureIpcChannels.recoverResult,
    (_event, request: unknown) => videoFeatures.recoverResult(request)
  );
  ipcMain.handle(
    videoWorkspaceIpcChannels.createFromImageWork,
    (_event, request: unknown) => videoWorkspaces.createFromImageWork(request)
  );
  ipcMain.handle(videoEditorIpcChannels.create, (_event, request: unknown) =>
    videoEditors.create(request)
  );
  ipcMain.handle(videoEditorIpcChannels.get, (_event, request: unknown) =>
    videoEditors.get(request)
  );
  ipcMain.handle(videoEditorIpcChannels.list, () => videoEditors.list());
  ipcMain.handle(videoEditorIpcChannels.update, (_event, request: unknown) =>
    videoEditors.update(request)
  );
  ipcMain.handle(videoEditorIpcChannels.undo, (_event, request: unknown) =>
    videoEditors.undo(request)
  );
  ipcMain.handle(videoEditorIpcChannels.redo, (_event, request: unknown) =>
    videoEditors.redo(request)
  );
  ipcMain.handle(videoEditorIpcChannels.copy, (_event, request: unknown) =>
    videoEditors.copy(request)
  );
  ipcMain.handle(
    videoEditorIpcChannels.selectSource,
    (_event, request: unknown) => videoEditorMedia.selectSource(request)
  );
  ipcMain.handle(
    videoEditorIpcChannels.attachWork,
    (_event, request: unknown) => videoEditorMedia.attachWork(request)
  );
  ipcMain.handle(
    videoEditorIpcChannels.getSourceStatus,
    (_event, request: unknown) => videoEditorMedia.getSourceStatus(request)
  );
  ipcMain.handle(
    videoEditorIpcChannels.prepareRelink,
    (_event, request: unknown) => videoEditorMedia.prepareRelink(request)
  );
  ipcMain.handle(
    videoEditorIpcChannels.confirmRelink,
    (_event, request: unknown) => videoEditorMedia.confirmRelink(request)
  );
  ipcMain.handle(
    videoEditorIpcChannels.selectBackgroundMusic,
    (_event, request: unknown) => videoEditorMedia.selectBackgroundMusic(request)
  );
  ipcMain.handle(
    videoEditorIpcChannels.selectCoverImage,
    (_event, request: unknown) => videoEditorMedia.selectCoverImage(request)
  );
  ipcMain.handle(
    videoEditorIpcChannels.attachCoverWork,
    (_event, request: unknown) => videoEditorMedia.attachCoverWork(request)
  );
  ipcMain.handle(
    videoEditorIpcChannels.createSourcePreview,
    (_event, request: unknown) => videoEditorMedia.createSourcePreview(request)
  );
  ipcMain.handle(
    videoEditorIpcChannels.requestPreviewArtifact,
    (_event, request: unknown) => videoEditorMedia.requestPreviewArtifact(request)
  );
  ipcMain.handle(videoEditorIpcChannels.clearPreviewCache, () =>
    videoEditorMedia.clearPreviewCache()
  );
  ipcMain.handle(videoEditorIpcChannels.preflightExport, (_event, request: unknown) =>
    videoExports.preflightExport(request)
  );
  ipcMain.handle(videoEditorIpcChannels.startExport, (_event, request: unknown) =>
    videoExports.startExport(request)
  );
  ipcMain.handle(videoEditorIpcChannels.getExport, (_event, request: unknown) =>
    videoExports.getExport(request)
  );
  ipcMain.handle(videoEditorIpcChannels.cancelExport, (_event, request: unknown) =>
    videoExports.cancelExport(request)
  );
  ipcMain.handle(videoEditorIpcChannels.retryExport, (_event, request: unknown) =>
    videoExports.retryExport(request)
  );
  ipcMain.handle(videoEditorIpcChannels.recoverExports, () =>
    videoExports.recoverExports()
  );
  ipcMain.handle(
    videoWorkspaceIpcChannels.selectMaterial,
    (_event, request: unknown) => videoReferenceMedia.selectMaterial(request)
  );
  ipcMain.handle(
    videoWorkspaceIpcChannels.getMaterial,
    (_event, request: unknown) => videoReferenceMedia.getMaterial(request)
  );
  ipcMain.handle(
    videoWorkspaceIpcChannels.clearMaterial,
    (_event, request: unknown) => videoReferenceMedia.clearMaterial(request)
  );
  ipcMain.handle(
    videoWorkspaceIpcChannels.createMaterialPreview,
    (_event, request: unknown) =>
      videoReferenceMedia.createMaterialPreview(request)
  );
  return {
    resolveEntry: (token) => mediaHandles.resolveEntry(token),
    get activeExportCount() {
      return videoExports.activeExportCount;
    },
    async interruptActiveExports(reason) {
      const [count] = await Promise.all([
        videoExports.interruptActiveExports(reason),
        previewAdapter.interrupt?.()
      ]);
      return count;
    },
    async dispose() {
      await Promise.all([
        videoExports.interruptActiveExports('application_shutdown'),
        previewAdapter.dispose?.(),
        imageFeatures.waitForOperations(),
          promptEnhance.waitForOperations(),
        videoFeatures.waitForOperations()
      ]);
      await videoExports.waitForExports();
      projectStorageMonitor.dispose();
      mediaHandles.clear();
    }
  };
}

class ProjectStorageChangeMonitor {
  private readonly watchers = new Map<
    string,
    { readonly rootDirectory: string; readonly watcher: FSWatcher }
  >();
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private syncOperation: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly catalog: ProjectCatalogService,
    private readonly invalidate: () => void,
    private readonly notify: () => void
  ) {}

  start(): void {
    if (this.disposed) return;
    void this.sync();
    this.refreshTimer = setInterval(() => {
      void this.sync();
      this.publishNow();
    }, 60_000);
    this.refreshTimer.unref?.();
  }

  sync(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.syncOperation) return this.syncOperation;
    this.syncOperation = this.syncWatchers()
      .catch(() => undefined)
      .finally(() => {
        this.syncOperation = undefined;
      });
    return this.syncOperation;
  }

  publishNow(): void {
    if (this.disposed) return;
    this.invalidate();
    this.notify();
  }

  dispose(): void {
    this.disposed = true;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const item of this.watchers.values()) item.watcher.close();
    this.watchers.clear();
  }

  private async syncWatchers(): Promise<void> {
    const entries = await this.catalog.getEntries();
    if (this.disposed) return;
    const activeIds = new Set<string>(entries.map((entry) => entry.projectId));
    for (const [projectId, item] of this.watchers) {
      const entry = entries.find((candidate) => candidate.projectId === projectId);
      if (!activeIds.has(projectId) || entry?.rootDirectory !== item.rootDirectory) {
        item.watcher.close();
        this.watchers.delete(projectId);
      }
    }
    for (const entry of entries) {
      if (this.disposed) return;
      if (this.watchers.has(entry.projectId)) continue;
      try {
        const watcher = watch(entry.rootDirectory, { recursive: true }, () => {
          this.scheduleChange();
        });
        watcher.on('error', () => {
          const current = this.watchers.get(entry.projectId);
          if (current?.watcher === watcher) {
            watcher.close();
            this.watchers.delete(entry.projectId);
          }
          this.scheduleChange();
        });
        this.watchers.set(entry.projectId, {
          rootDirectory: entry.rootDirectory,
          watcher
        });
      } catch {
        // The periodic refresh still covers unavailable or unsupported directories.
      }
    }
  }

  private scheduleChange(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.publishNow();
    }, 750);
    this.changeTimer.unref?.();
  }
}

const denyRuntimeAuthorization: ProviderCandidateRuntimeAuthorizationPort = {
  async checkAccess() {
    return {
      allowed: false,
      operation: 'submit' as const,
      reason: 'no_matching_policy' as const
    };
  }
};

function hasSubmissionAuthorization(
  value: ProviderCandidateRuntimeAuthorizationPort &
    Partial<RuntimeAuthorizationOrchestrationPort>
): value is ProviderCandidateRuntimeAuthorizationPort &
  RuntimeAuthorizationOrchestrationPort {
  return (
    typeof value.claimSubmission === 'function' &&
    typeof value.markRequestStarted === 'function' &&
    typeof value.releaseBeforeRequest === 'function' &&
    typeof value.recordOutcome === 'function'
  );
}
