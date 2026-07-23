import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageQuickPage({
  onNavigateToProfessional
}: {
  readonly onNavigateToProfessional?: () => void;
}) {
  const mode = imageCreationModes[0];
  return (
    <ImageWorkbenchPage
      mode={mode}
      onNavigateToProfessional={onNavigateToProfessional}
    />
  );
}
