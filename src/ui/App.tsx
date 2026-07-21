import { useState } from 'react';
import type { ComponentType } from 'react';
import { ChatPage } from '../pages/chat/ChatPage';
import { ImageCreationPage } from '../pages/image-creation/ImageCreationPage';
import { LibraryPage } from '../pages/library/LibraryPage';
import { ProjectsPage } from '../pages/projects/ProjectsPage';
import { ProvidersPage } from '../pages/providers/ProvidersPage';
import { SettingsPage } from '../pages/settings/SettingsPage';
import { TasksPage } from '../pages/tasks/TasksPage';
import { VideoCreationPage } from '../pages/video-creation/VideoCreationPage';
import { AppLayout } from './layout/AppLayout';
import {
  defaultNavigationItemId,
  type NavigationItemId
} from './navigation/navigationItems';

const pagesByNavigationItem: Record<NavigationItemId, ComponentType> = {
  chat: ChatPage,
  projects: ProjectsPage,
  'image-creation': ImageCreationPage,
  'video-creation': VideoCreationPage,
  tasks: TasksPage,
  library: LibraryPage,
  providers: ProvidersPage,
  settings: SettingsPage
};

export function App() {
  const [activeItemId, setActiveItemId] = useState<NavigationItemId>(
    defaultNavigationItemId
  );
  const ActivePage = pagesByNavigationItem[activeItemId];

  return (
    <AppLayout activeItemId={activeItemId} onNavigate={setActiveItemId}>
      <ActivePage />
    </AppLayout>
  );
}
