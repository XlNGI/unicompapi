/// <reference types="vite/client" />

import type { StorageRecoveryApi } from './platform';

declare global {
  interface Window {
    unicomp?: {
      platform: NodeJS.Platform;
      storageRecovery: StorageRecoveryApi;
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
