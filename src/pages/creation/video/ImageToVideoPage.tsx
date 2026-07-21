import { CreationModePage } from '../CreationModePage';
import { videoCreationModes } from '../creationModes';

export function ImageToVideoPage() {
  const mode = videoCreationModes[2];
  return <CreationModePage {...mode} title={mode.label} />;
}
