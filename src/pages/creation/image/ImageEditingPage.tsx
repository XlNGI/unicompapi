import { imageCreationModes } from '../creationModes';
import type { ImageWorkspaceDtoMode } from '../../../shared/image-workspace-ipc';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageEditingPage({
  onNavigateToImageMode,
  onVideoDraftCreated,
  preferredDraftId
}: {
  readonly onNavigateToImageMode?: (mode: ImageWorkspaceDtoMode) => void;
  readonly onVideoDraftCreated?: (draftId: string) => void;
  readonly preferredDraftId?: string;
}) {
  const mode = imageCreationModes[3];
  return (
    <ImageWorkbenchPage
      mode={mode}
      onNavigateToImageMode={onNavigateToImageMode}
      onVideoDraftCreated={onVideoDraftCreated}
      preferredDraftId={preferredDraftId}
    />
  );
}
