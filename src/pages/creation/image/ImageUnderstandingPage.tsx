import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageUnderstandingPage({
  onNavigateToImageMode
}: {
  readonly onNavigateToImageMode?: (
    mode: 'professional_image' | 'image_editing' | 'image_to_prompt'
  ) => void;
}) {
  const mode = imageCreationModes[2];
  return (
    <ImageWorkbenchPage
      mode={mode}
      onNavigateToImageMode={onNavigateToImageMode}
    />
  );
}
