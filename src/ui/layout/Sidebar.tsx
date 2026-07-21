import {
  getSecondaryNavigationItems,
  navigationItems,
  type NavigationItemId,
  type SecondaryNavigationItemId
} from '../navigation/navigationItems';

interface SidebarProps {
  activeItemId: NavigationItemId;
  activeSubItemId?: SecondaryNavigationItemId;
  onNavigate: (itemId: NavigationItemId) => void;
  onSecondaryNavigate: (
    itemId: NavigationItemId,
    subItemId: SecondaryNavigationItemId
  ) => void;
}

export function Sidebar({
  activeItemId,
  activeSubItemId,
  onNavigate,
  onSecondaryNavigate
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <nav className="nav-list" aria-label="主导航">
        {navigationItems.map((item) => {
          const isActive = item.id === activeItemId;
          const subItems = getSecondaryNavigationItems(item.id);
          const hasSubItems = subItems.length > 0;

          return (
            <div className="nav-group" key={item.id}>
              <button
                type="button"
                className={isActive ? 'nav-item active' : 'nav-item'}
                aria-controls={hasSubItems ? `${item.id}-navigation` : undefined}
                aria-current={isActive && !hasSubItems ? 'page' : undefined}
                aria-expanded={hasSubItems ? isActive : undefined}
                onClick={() => onNavigate(item.id)}
              >
                <span>{item.label}</span>
                {hasSubItems && (
                  <span className="nav-item-indicator" aria-hidden="true">
                    {isActive ? '−' : '+'}
                  </span>
                )}
              </button>

              {hasSubItems && isActive && (
                <div className="nav-sublist" id={`${item.id}-navigation`}>
                  {subItems.map((subItem) => {
                    const isSubItemActive = subItem.id === activeSubItemId;

                    return (
                      <button
                        type="button"
                        className={
                          isSubItemActive ? 'nav-subitem active' : 'nav-subitem'
                        }
                        aria-current={isSubItemActive ? 'page' : undefined}
                        key={subItem.id}
                        onClick={() => onSecondaryNavigate(item.id, subItem.id)}
                      >
                        {subItem.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
