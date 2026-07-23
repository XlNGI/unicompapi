import { imageCreationModes } from '../creationModes';
import type { ImageWorkspaceDtoMode } from '../../../shared/image-workspace-ipc';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageUnderstandingPage({
  onNavigateToImageMode
}: {
  readonly onNavigateToImageMode?: (mode: ImageWorkspaceDtoMode) => void;
}) {
  const mode = imageCreationModes[2];
  return (
    <ImageWorkbenchPage
      mode={mode}
      onNavigateToImageMode={onNavigateToImageMode}
    />
  );
}
