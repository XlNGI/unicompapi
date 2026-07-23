import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageToPromptPage() {
  const mode = imageCreationModes[4];
  return <ImageWorkbenchPage mode={mode} />;
}
