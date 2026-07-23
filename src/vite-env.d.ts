/// <reference types="vite/client" />

import type { StorageApi } from './shared/storage-ipc';
import type { ProviderApi } from './shared/provider-ipc';
import type { ImageWorkspaceApi } from './shared/image-workspace-ipc';

declare global {
  interface Window {
    unicomp?: {
      imageWorkspaces: ImageWorkspaceApi;
      platform: NodeJS.Platform;
      providers: ProviderApi;
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
