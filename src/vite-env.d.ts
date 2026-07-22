/// <reference types="vite/client" />

import type { StorageApi } from './shared/storage-ipc';

declare global {
  interface Window {
    unicomp?: {
      platform: NodeJS.Platform;
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
