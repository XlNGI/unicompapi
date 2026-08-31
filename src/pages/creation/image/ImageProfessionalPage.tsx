import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageProfessionalPage({
  onVideoDraftCreated,
  preferredDraftId
}: {
  readonly onVideoDraftCreated?: (draftId: string) => void;
  readonly preferredDraftId?: string;
}) {
  const mode = imageCreationModes[1];
  return (
    <ImageWorkbenchPage
      mode={mode}
      onVideoDraftCreated={onVideoDraftCreated}
      preferredDraftId={preferredDraftId}
    />
  );
}
