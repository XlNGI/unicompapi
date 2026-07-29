import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageProfessionalPage({
  onVideoDraftCreated
}: {
  readonly onVideoDraftCreated?: (draftId: string) => void;
}) {
  const mode = imageCreationModes[1];
  return (
    <ImageWorkbenchPage
      mode={mode}
      onVideoDraftCreated={onVideoDraftCreated}
    />
  );
}
