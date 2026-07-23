import { imageCreationModes } from '../creationModes';
import { ImageWorkbenchPage } from './ImageWorkbenchPage';

export function ImageProfessionalPage() {
  const mode = imageCreationModes[1];
  return <ImageWorkbenchPage mode={mode} />;
}
