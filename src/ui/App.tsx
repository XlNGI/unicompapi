import { useState } from 'react';
import { AppLayout } from './layout/AppLayout';
import { PageShell } from './layout/PageShell';
import {
  defaultNavigationItemId,
  navigationItems,
  type NavigationItemId
} from './navigation/navigationItems';

export function App() {
  const [activeItemId, setActiveItemId] = useState<NavigationItemId>(
    defaultNavigationItemId
  );
  const activeItem =
    navigationItems.find((item) => item.id === activeItemId) ?? navigationItems[0];

  return (
    <AppLayout activeItemId={activeItem.id} onNavigate={setActiveItemId}>
      <PageShell title={activeItem.label} description={activeItem.description} />
    </AppLayout>
  );
}
