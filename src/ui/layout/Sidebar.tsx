import {
  navigationItems,
  type NavigationItemId
} from '../navigation/navigationItems';

interface SidebarProps {
  activeItemId: NavigationItemId;
  onNavigate: (itemId: NavigationItemId) => void;
}

export function Sidebar({ activeItemId, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <nav className="nav-list" aria-label="主导航">
        {navigationItems.map((item) => {
          const isActive = item.id === activeItemId;

          return (
            <button
              type="button"
              className={isActive ? 'nav-item active' : 'nav-item'}
              aria-current={isActive ? 'page' : undefined}
              key={item.id}
              onClick={() => onNavigate(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
