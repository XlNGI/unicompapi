/// <reference types="vite/client" />

interface Window {
  unicomp?: {
    platform: NodeJS.Platform;
    windowControls: {
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
      isMaximized: () => Promise<boolean>;
      onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
    };
  };
}
