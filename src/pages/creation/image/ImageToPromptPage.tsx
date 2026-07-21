import { CreationModePage } from '../CreationModePage';
import { imageCreationModes } from '../creationModes';

export function ImageToPromptPage() {
  const mode = imageCreationModes[4];
  return <CreationModePage {...mode} title={mode.label} />;
}
