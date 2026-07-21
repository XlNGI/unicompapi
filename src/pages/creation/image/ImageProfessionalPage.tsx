import { CreationModePage } from '../CreationModePage';
import { imageCreationModes } from '../creationModes';

export function ImageProfessionalPage() {
  const mode = imageCreationModes[1];
  return <CreationModePage {...mode} title={mode.label} />;
}
