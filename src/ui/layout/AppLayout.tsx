import type { ReactNode } from 'react';
import type { NavigationItemId } from '../navigation/navigationItems';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';

interface AppLayoutProps {
  activeItemId: NavigationItemId;
  children: ReactNode;
  onNavigate: (itemId: NavigationItemId) => void;
}

export function AppLayout({ activeItemId, children, onNavigate }: AppLayoutProps) {
  return (
    <main className="app-shell">
      <TitleBar />
      <div className="app-body">
        <Sidebar activeItemId={activeItemId} onNavigate={onNavigate} />
        <section className="workspace">{children}</section>
      </div>
    </main>
  );
}
