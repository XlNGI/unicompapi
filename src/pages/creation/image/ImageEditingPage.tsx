import { CreationModePage } from '../CreationModePage';
import { imageCreationModes } from '../creationModes';

export function ImageEditingPage() {
  const mode = imageCreationModes[3];
  return <CreationModePage {...mode} title={mode.label} />;
}
