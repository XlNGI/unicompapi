import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import {
  StorageIpcController,
  JsonProjectCatalogStore,
  GlobalReadModelController,
  ControlledLocalMediaController,
  ImageLocalMediaController,
  ImageSubmissionController,
  ImageWorkspaceController,
  ImageWorkspaceMutationCoordinator,
  ProjectSessionController,
  ProjectCatalogService,
  JsonProviderRegistryStore,
  LocalMediaHandleRegistry,
  StorageProjectSessionRegistry,
  VideoReferenceMediaController,
  VideoSubmissionController,
  VideoWorkspaceController,
  VideoWorkspaceMutationCoordinator
} from '../../src/platform';
import { storageIpcChannels } from '../../src/shared/storage-ipc';
import { imageWorkspaceIpcChannels } from '../../src/shared/image-workspace-ipc';
import { imageSubmissionIpcChannels } from '../../src/shared/image-submission-ipc';
import { videoWorkspaceIpcChannels } from '../../src/shared/video-workspace-ipc';
import { videoSubmissionIpcChannels } from '../../src/shared/video-submission-ipc';

export function registerStorageIpcHandlers(): LocalMediaHandleRegistry {
  const sessionRegistry = new StorageProjectSessionRegistry();
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
  const providerRegistry = new JsonProviderRegistryStore(
    path.join(app.getPath('userData'), 'provider-registry.json')
  );
  const imageWorkspaces = new ImageWorkspaceController({
    getSession: () => sessionRegistry.get(),
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
    mutations: imageMutations
  });
  const videoWorkspaces = new VideoWorkspaceController({
    getSession: () => sessionRegistry.get(),
    mutations: videoMutations
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
    mutations: videoMutations
  });
  const catalog = new ProjectCatalogService(
    new JsonProjectCatalogStore(path.join(app.getPath('userData'), 'project-catalog.json'))
  );
  const readModels = new GlobalReadModelController(catalog);
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
        videoWorkspaces.waitForMutations()
      ]);
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
  return mediaHandles;
}
