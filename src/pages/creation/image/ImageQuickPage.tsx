import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageQuickPage({
  onNavigateToProfessional,
  onVideoDraftCreated,
  onNavigateToProviders,
  preferredDraftId
}: {
  readonly onNavigateToProfessional?: () => void;
  readonly onNavigateToProviders?: () => void;
  readonly onVideoDraftCreated?: (draftId: string) => void;
  readonly preferredDraftId?: string;
}) {
  const mode = imageCreationModes[0];
  return (
    <ImageWorkbenchPage
      mode={mode}
      onNavigateToProviders={onNavigateToProviders}
      onNavigateToProfessional={onNavigateToProfessional}
      onVideoDraftCreated={onVideoDraftCreated}
      preferredDraftId={preferredDraftId}
    />
  );
}
