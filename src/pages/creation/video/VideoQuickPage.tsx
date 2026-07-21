import { CreationModePage } from '../CreationModePage';
import { videoCreationModes } from '../creationModes';

export function VideoQuickPage() {
  const mode = videoCreationModes[0];
  return <CreationModePage {...mode} title={mode.label} />;
}
