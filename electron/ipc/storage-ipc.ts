import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
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
  ImageSubmissionController,
  ImageWorkspaceController,
  ImageWorkspaceMutationCoordinator,
  ProjectSessionController,
  ProjectCatalogService,
  JsonProviderRegistryStore,
  JsonAssetRepository,
  JsonImageWorkspaceRepository,
  JsonVideoWorkspaceRepository,
  JsonProjectContextRepository,
  LocalMediaHandleRegistry,
  NodeProjectStorage,
  StorageProjectSessionRegistry,
  VideoReferenceMediaController,
  VideoSubmissionController,
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
  ProjectImageFeatureSubjectResolver,
  ProjectVideoFeatureSubjectResolver,
  ProviderFeatureCandidateService,
  ProviderFeatureContractRegistry,
  ProviderPackageRegistry,
  RegistryFeatureCandidateSource,
  RouteSelectionTokenVault,
  type ProviderCandidateRuntimeAuthorizationPort,
  createImageProviderFeatureContracts,
  createVideoProviderFeatureContracts,
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
import { videoWorkspaceIpcChannels } from '../../src/shared/video-workspace-ipc';
import { videoFeatureIpcChannels } from '../../src/shared/video-feature-ipc';
import { videoSubmissionIpcChannels } from '../../src/shared/video-submission-ipc';
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
  readonly runtimeAuthorization?: ProviderCandidateRuntimeAuthorizationPort;
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
    videoMutations
  });
  const imageWorkspaces = new ImageWorkspaceController({
    getSession: () => sessionRegistry.get(),
    mutations: imageMutations
  });
  const imageFeatureContracts = new ProviderFeatureContractRegistry(
    createImageProviderFeatureContracts()
  );
  let imageFeatureRuntime: {
    readonly projectId: string;
    readonly rootDirectory: string;
    readonly value: {
      readonly drafts: JsonImageWorkspaceRepository;
      readonly candidates: ProviderFeatureCandidateService;
    };
  } | undefined;
  const getImageFeatureRuntime = (session: StorageProjectSession) => {
    if (
      imageFeatureRuntime?.projectId === session.projectId &&
      imageFeatureRuntime.rootDirectory === session.rootDirectory
    ) {
      return imageFeatureRuntime.value;
    }
    const storage = new NodeProjectStorage(session.rootDirectory);
    const drafts = new JsonImageWorkspaceRepository(storage, session.projectId);
    const contexts = new JsonProjectContextRepository(storage, session.projectId);
    const assets = new JsonAssetRepository(storage, session.projectId);
    const candidates = new ProviderFeatureCandidateService(
      new ProjectImageFeatureSubjectResolver(
        session.projectId,
        drafts,
        contexts,
        assets
      ),
      new RegistryFeatureCandidateSource(
        providerRegistry,
        providerPackages,
        imageFeatureContracts,
        options.runtimeAuthorization ?? denyRuntimeAuthorization
      ),
      new RouteSelectionTokenVault()
    );
    imageFeatureRuntime = {
      projectId: session.projectId,
      rootDirectory: session.rootDirectory,
      value: { drafts, candidates }
    };
    return imageFeatureRuntime.value;
  };
  const imageFeatures = new ImageFeatureController({
    getSession: () => sessionRegistry.get(),
    getRuntime: getImageFeatureRuntime,
    mutations: imageMutations
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
  const videoFeatureContracts = new ProviderFeatureContractRegistry(
    createVideoProviderFeatureContracts()
  );
  let videoFeatureRuntime: {
    readonly projectId: string;
    readonly rootDirectory: string;
    readonly value: {
      readonly drafts: JsonVideoWorkspaceRepository;
      readonly candidates: ProviderFeatureCandidateService;
    };
  } | undefined;
  const getVideoFeatureRuntime = (session: StorageProjectSession) => {
    if (
      videoFeatureRuntime?.projectId === session.projectId &&
      videoFeatureRuntime.rootDirectory === session.rootDirectory
    ) {
      return videoFeatureRuntime.value;
    }
    const storage = new NodeProjectStorage(session.rootDirectory);
    const drafts = new JsonVideoWorkspaceRepository(storage, session.projectId);
    const contexts = new JsonProjectContextRepository(storage, session.projectId);
    const assets = new JsonAssetRepository(storage, session.projectId);
    const candidates = new ProviderFeatureCandidateService(
      new ProjectVideoFeatureSubjectResolver(
        session.projectId,
        drafts,
        contexts,
        assets
      ),
      new RegistryFeatureCandidateSource(
        providerRegistry,
        providerPackages,
        videoFeatureContracts,
        options.runtimeAuthorization ?? denyRuntimeAuthorization
      ),
      new RouteSelectionTokenVault()
    );
    videoFeatureRuntime = {
      projectId: session.projectId,
      rootDirectory: session.rootDirectory,
      value: { drafts, candidates }
    };
    return videoFeatureRuntime.value;
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
  const videoSubmissions = new VideoSubmissionController({
    getSession: () => sessionRegistry.get(),
    providerRegistry,
    mutations: videoMutations,
    operationPort: providerOperations?.video,
    asyncOperationPort: providerOperations?.videoAsync,
    resultReceiver: providerOperations?.videoResultReceiver
  });
  const catalog = new ProjectCatalogService(
    new JsonProjectCatalogStore(path.join(app.getPath('userData'), 'project-catalog.json'))
  );
  const readModels = new GlobalReadModelController(catalog);
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
        videoWorkspaces.waitForMutations(),
        videoFeatures.waitForOperations(),
        videoEditors.waitForMutations(),
        ...(options.additionalSessionChangeGuards ?? []).map((guard) => guard())
      ]);
    },
    afterSessionChange: async () => {
      imageFeatureRuntime = undefined;
      videoFeatureRuntime = undefined;
      await videoExports.recoverExports();
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
  ipcMain.handle(storageIpcChannels.createProject, (_event, request: unknown) =>
    projectController.createProject(request)
  );
  ipcMain.handle(storageIpcChannels.listProjects, () =>
    projectController.listProjects()
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
  ipcMain.handle(
    videoSubmissionIpcChannels.preflight,
    (_event, request: unknown) => videoSubmissions.preflight(request)
  );
  ipcMain.handle(
    videoSubmissionIpcChannels.createTask,
    (_event, request: unknown) => videoSubmissions.createTask(request)
  );
  ipcMain.handle(
    videoSubmissionIpcChannels.createExecution,
    (_event, request: unknown) => videoSubmissions.createExecution(request)
  );
  ipcMain.handle(
    videoSubmissionIpcChannels.invokeExecution,
    (_event, request: unknown) => videoSubmissions.invokeExecution(request)
  );
  ipcMain.handle(
    videoSubmissionIpcChannels.refreshExecution,
    (_event, request: unknown) => videoSubmissions.refreshExecution(request)
  );
  ipcMain.handle(
    videoSubmissionIpcChannels.cancelExecution,
    (_event, request: unknown) => videoSubmissions.cancelExecution(request)
  );
  ipcMain.handle(
    videoSubmissionIpcChannels.recoverExecutions,
    (_event, request: unknown) => videoSubmissions.recoverExecutions(request)
  );
  ipcMain.handle(
    videoSubmissionIpcChannels.receiveResult,
    (_event, request: unknown) => videoSubmissions.receiveResult(request)
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
        videoFeatures.waitForOperations()
      ]);
      await videoExports.waitForExports();
      mediaHandles.clear();
    }
  };
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
