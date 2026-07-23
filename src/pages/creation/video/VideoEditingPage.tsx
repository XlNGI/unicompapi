import { videoCreationModes } from '../creationModes';
import { VideoWorkbenchPage } from './VideoWorkbenchPage';

export function VideoEditingPage() {
  return <VideoWorkbenchPage mode={videoCreationModes[3]} />;
}
