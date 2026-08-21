/// <reference types="vite/client" />

import type { StorageApi } from './shared/storage-ipc';
import type { ProviderApi } from './shared/provider-ipc';
import type { ImageWorkspaceApi } from './shared/image-workspace-ipc';
import type { ImageSubmissionApi } from './shared/image-submission-ipc';
import type { ImageFeatureApi } from './shared/image-feature-ipc';
import type { PromptEnhanceApi } from './shared/prompt-enhance-ipc';
import type { VideoFeatureApi } from './shared/video-feature-ipc';
import type { VideoWorkspaceApi } from './shared/video-workspace-ipc';
import type { VideoEditorApi } from './shared/video-editor-ipc';
import type { SettingsApi } from './shared/settings-ipc';
import type { ChatContextApi } from './shared/chat-context-ipc';
import type { AutosaveDiagnosticsApi } from './shared/autosave-diagnostics-ipc';
import type { DocumentAttachmentApi } from './shared/document-attachment-ipc';
import type { DocumentGenerationApi } from './shared/document-generation-ipc';

declare global {
  interface Window {
    unicomp?: {
      autosaveDiagnostics: AutosaveDiagnosticsApi;
      chatContexts: ChatContextApi;
      documentAttachments: DocumentAttachmentApi;
      documentGeneration: DocumentGenerationApi;
      imageFeatures: ImageFeatureApi;
      promptEnhance: PromptEnhanceApi;
      imagePromptEnhance: PromptEnhanceApi;
      videoFeatures: VideoFeatureApi;
      imageWorkspaces: ImageWorkspaceApi;
      imageSubmissions: ImageSubmissionApi;
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
