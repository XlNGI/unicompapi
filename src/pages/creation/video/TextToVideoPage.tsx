import { videoCreationModes } from '../creationModes';
import { VideoWorkbenchPage } from './VideoWorkbenchPage';

export function TextToVideoPage() {
  return <VideoWorkbenchPage mode={videoCreationModes[1]} />;
}
