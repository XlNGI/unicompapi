import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageQuickPage() {
  const mode = imageCreationModes[0];
  return <ImageWorkbenchPage mode={mode} />;
}
