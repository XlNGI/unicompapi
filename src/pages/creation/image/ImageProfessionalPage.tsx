import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageProfessionalPage({
  onVideoDraftCreated,
  onNavigateToProviders,
  preferredDraftId
}: {
  readonly onNavigateToProviders?: () => void;
  readonly onVideoDraftCreated?: (draftId: string) => void;
  readonly preferredDraftId?: string;
}) {
  const mode = imageCreationModes[1];
  return (
    <ImageWorkbenchPage
      mode={mode}
      onNavigateToProviders={onNavigateToProviders}
      onVideoDraftCreated={onVideoDraftCreated}
      preferredDraftId={preferredDraftId}
    />
  );
}
