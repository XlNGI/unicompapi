import { CreationModePage } from '../CreationModePage';
import { videoCreationModes } from '../creationModes';

export function VideoEditingPage() {
  const mode = videoCreationModes[3];
  return <CreationModePage {...mode} title={mode.label} />;
}
