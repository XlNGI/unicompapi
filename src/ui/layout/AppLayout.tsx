import type { ReactNode } from 'react';
import type {
  NavigationItemId,
  SecondaryNavigationItemId
} from '../navigation/navigationItems';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';

interface AppLayoutProps {
  activeItemId: NavigationItemId;
  activeSubItemId?: SecondaryNavigationItemId;
  children: ReactNode;
  onNavigate: (itemId: NavigationItemId) => void;
  onSecondaryNavigate: (
    itemId: NavigationItemId,
    subItemId: SecondaryNavigationItemId
  ) => void;
}

export function AppLayout({
  activeItemId,
  activeSubItemId,
  children,
  onNavigate,
  onSecondaryNavigate
}: AppLayoutProps) {
  return (
    <main className="app-shell">
      <TitleBar />
      <div className="app-body">
        <Sidebar
          activeItemId={activeItemId}
          activeSubItemId={activeSubItemId}
          onNavigate={onNavigate}
          onSecondaryNavigate={onSecondaryNavigate}
        />
        <section className="workspace">{children}</section>
      </div>
    </main>
  );
}
