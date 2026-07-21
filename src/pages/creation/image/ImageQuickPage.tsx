import { CreationModePage } from '../CreationModePage';
import { imageCreationModes } from '../creationModes';

export function ImageQuickPage() {
  const mode = imageCreationModes[0];
  return <CreationModePage {...mode} title={mode.label} />;
}
