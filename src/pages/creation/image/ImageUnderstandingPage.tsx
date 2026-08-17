import { imageCreationModes } from '../creationModes';
import type { ImageWorkspaceDtoMode } from '../../../shared/image-workspace-ipc';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageUnderstandingPage({
  onNavigateToImageMode,
  preferredDraftId
}: {
  readonly onNavigateToImageMode?: (mode: ImageWorkspaceDtoMode) => void;
  readonly preferredDraftId?: string;
}) {
  const mode = imageCreationModes[2];
  return (
    <ImageWorkbenchPage
      mode={mode}
      onNavigateToImageMode={onNavigateToImageMode}
      preferredDraftId={preferredDraftId}
    />
  );
}
