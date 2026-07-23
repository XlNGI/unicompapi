import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageUnderstandingPage() {
  const mode = imageCreationModes[2];
  return <ImageWorkbenchPage mode={mode} />;
}
