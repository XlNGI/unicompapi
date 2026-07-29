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
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <TitleBar onNavigate={onNavigate} />
      <div className="app-body">
        <Sidebar
          activeItemId={activeItemId}
          activeSubItemId={activeSubItemId}
          onNavigate={onNavigate}
          onSecondaryNavigate={onSecondaryNavigate}
        />
        <main className="workspace" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
