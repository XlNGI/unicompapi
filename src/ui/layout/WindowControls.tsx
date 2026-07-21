import { useEffect, useState } from 'react';

export function WindowControls() {
  const controls = window.unicomp?.windowControls;
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!controls) {
      return undefined;
    }

    void controls.isMaximized().then(setIsMaximized);
    return controls.onMaximizedChange(setIsMaximized);
  }, [controls]);

  if (!controls) {
    return null;
  }

  return (
    <div className="window-controls" aria-label="窗口控制">
      <button
        type="button"
        className="window-control"
        aria-label="最小化窗口"
        title="最小化"
        onClick={controls.minimize}
      >
        <span className="windows-caption-icon" aria-hidden="true">&#xE921;</span>
      </button>
      <button
        type="button"
        className="window-control"
        aria-label="最大化或还原窗口"
        title="最大化或还原"
        onClick={controls.toggleMaximize}
      >
        <span className="windows-caption-icon" aria-hidden="true">
          {isMaximized ? '\uE923' : '\uE922'}
        </span>
      </button>
      <button
        type="button"
        className="window-control window-control--close"
        aria-label="关闭窗口"
        title="关闭"
        onClick={controls.close}
      >
        <span className="windows-caption-icon" aria-hidden="true">&#xE8BB;</span>
      </button>
    </div>
  );
}
