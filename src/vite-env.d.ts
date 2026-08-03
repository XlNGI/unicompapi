/// <reference types="vite/client" />

import type { StorageApi } from './shared/storage-ipc';
import type { ProviderApi } from './shared/provider-ipc';
import type { ImageWorkspaceApi } from './shared/image-workspace-ipc';
import type { ImageSubmissionApi } from './shared/image-submission-ipc';
import type { ImageFeatureApi } from './shared/image-feature-ipc';
import type { VideoWorkspaceApi } from './shared/video-workspace-ipc';
import type { VideoSubmissionApi } from './shared/video-submission-ipc';
import type { VideoEditorApi } from './shared/video-editor-ipc';
import type { SettingsApi } from './shared/settings-ipc';
import type { ChatContextApi } from './shared/chat-context-ipc';

declare global {
  interface Window {
    unicomp?: {
      chatContexts: ChatContextApi;
      imageFeatures: ImageFeatureApi;
      imageWorkspaces: ImageWorkspaceApi;
      imageSubmissions: ImageSubmissionApi;
      videoSubmissions: VideoSubmissionApi;
      videoEditors: VideoEditorApi;
      videoWorkspaces: VideoWorkspaceApi;
      platform: NodeJS.Platform;
      providers: ProviderApi;
      settings: SettingsApi;
      storage: StorageApi;
      windowControls: {
        minimize: () => void;
        toggleMaximize: () => void;
        close: () => void;
        isMaximized: () => Promise<boolean>;
        onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
      };
    };
  }
}

export {};
