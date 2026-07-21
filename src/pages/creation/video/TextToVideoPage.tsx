import { CreationModePage } from '../CreationModePage';
import { videoCreationModes } from '../creationModes';

export function TextToVideoPage() {
  const mode = videoCreationModes[1];
  return <CreationModePage {...mode} title={mode.label} />;
}
