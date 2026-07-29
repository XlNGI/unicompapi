import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageQuickPage({
  onNavigateToProfessional,
  onVideoDraftCreated
}: {
  readonly onNavigateToProfessional?: () => void;
  readonly onVideoDraftCreated?: (draftId: string) => void;
}) {
  const mode = imageCreationModes[0];
  return (
    <ImageWorkbenchPage
      mode={mode}
      onNavigateToProfessional={onNavigateToProfessional}
      onVideoDraftCreated={onVideoDraftCreated}
    />
  );
}
