import { videoCreationModes } from '../creationModes';
import { VideoWorkbenchPage } from './VideoWorkbenchPage';

export function VideoQuickPage() {
  return <VideoWorkbenchPage mode={videoCreationModes[0]} />;
}
