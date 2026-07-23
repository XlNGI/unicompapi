import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageEditingPage() {
  const mode = imageCreationModes[3];
  return <ImageWorkbenchPage mode={mode} />;
}
