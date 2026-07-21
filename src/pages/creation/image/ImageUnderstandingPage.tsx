import { CreationModePage } from '../CreationModePage';
import { imageCreationModes } from '../creationModes';

export function ImageUnderstandingPage() {
  const mode = imageCreationModes[2];
  return <CreationModePage {...mode} title={mode.label} />;
}
