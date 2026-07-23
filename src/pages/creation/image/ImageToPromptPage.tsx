import type { ImageWorkspaceDtoMode } from '../../../shared/image-workspace-ipc';
import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageToPromptPage({
  onNavigateToImageMode
}: {
  readonly onNavigateToImageMode?: (mode: ImageWorkspaceDtoMode) => void;
}) {
  const mode = imageCreationModes[4];
  return (
    <ImageWorkbenchPage
      mode={mode}
      onNavigateToImageMode={onNavigateToImageMode}
    />
  );
}
