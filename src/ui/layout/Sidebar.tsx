import { useEffect, useState } from 'react';
import type { IconType } from 'react-icons';
import {
  LuBoxes,
  LuChevronRight,
  LuClapperboard,
  LuFolderKanban,
  LuImage,
  LuImagePlay,
  LuLibrary,
  LuListChecks,
  LuMessageCircle,
  LuScanSearch,
  LuScanText,
  LuScissors,
  LuSettings,
  LuSlidersHorizontal,
  LuType,
  LuZap
} from 'react-icons/lu';
import {
  getSecondaryNavigationItems,
  navigationItems,
  type NavigationItemId,
  type SecondaryNavigationItemId
} from '../navigation/navigationItems';

const navigationIcons: Record<NavigationItemId, IconType> = {
  chat: LuMessageCircle,
  projects: LuFolderKanban,
  'image-creation': LuImage,
  'video-creation': LuClapperboard,
  tasks: LuListChecks,
  library: LuLibrary,
  providers: LuBoxes,
  settings: LuSettings
};

const secondaryNavigationIcons: Record<SecondaryNavigationItemId, IconType> = {
  'quick-image': LuZap,
  'professional-image': LuSlidersHorizontal,
  'image-understanding': LuScanSearch,
  'image-editing': LuImage,
  'image-to-prompt': LuScanText,
  'quick-video': LuClapperboard,
  'text-to-video': LuType,
  'image-to-video': LuImagePlay,
  'video-editing': LuScissors
};

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
  const [openMenuId, setOpenMenuId] = useState<NavigationItemId | undefined>(
    activeSubItemId ? activeItemId : undefined
  );

  useEffect(() => {
    if (activeSubItemId) {
      setOpenMenuId(activeItemId);
    }
  }, [activeItemId, activeSubItemId]);

  return (
    <aside className="sidebar">
      <nav className="nav-list" aria-label="主导航">
        {navigationItems.map((item) => {
          const isActive = item.id === activeItemId;
          const subItems = getSecondaryNavigationItems(item.id);
          const hasSubItems = subItems.length > 0;
          const isMenuOpen = hasSubItems && openMenuId === item.id;
          const ItemIcon = navigationIcons[item.id];

          return (
            <div className="nav-group" key={item.id}>
              <button
                id={`${item.id}-navigation-trigger`}
                type="button"
                className={isActive ? 'nav-item active' : 'nav-item'}
                aria-controls={hasSubItems ? `${item.id}-navigation` : undefined}
                aria-current={isActive && !hasSubItems ? 'page' : undefined}
                aria-expanded={hasSubItems ? isMenuOpen : undefined}
                aria-haspopup={hasSubItems ? 'menu' : undefined}
                title={item.label}
                onClick={() => {
                  if (hasSubItems) {
                    setOpenMenuId(isMenuOpen ? undefined : item.id);
                  } else {
                    setOpenMenuId(undefined);
                  }

                  if (!hasSubItems || !isActive) {
                    onNavigate(item.id);
                  }
                }}
              >
                <span className="nav-item__content">
                  <ItemIcon className="nav-item__icon" aria-hidden="true" />
                  <span>{item.label}</span>
                </span>
                {hasSubItems && (
                  <LuChevronRight
                    className={
                      isMenuOpen
                        ? 'nav-item-indicator nav-item-indicator--open'
                        : 'nav-item-indicator'
                    }
                    aria-hidden="true"
                  />
                )}
              </button>

              {isMenuOpen && (
                <div
                  className="nav-sublist"
                  id={`${item.id}-navigation`}
                  role="group"
                  aria-label={`${item.label}二级导航`}
                >
                  {subItems.map((subItem) => {
                    const isSubItemActive = subItem.id === activeSubItemId;
                    const SubItemIcon = secondaryNavigationIcons[subItem.id];

                    return (
                      <button
                        type="button"
                        className={
                          isSubItemActive ? 'nav-subitem active' : 'nav-subitem'
                        }
                        aria-current={isSubItemActive ? 'page' : undefined}
                        key={subItem.id}
                        title={subItem.label}
                        onClick={() =>
                          onSecondaryNavigate(item.id, subItem.id)
                        }
                      >
                        <span className="nav-subitem__icon" aria-hidden="true">
                          <SubItemIcon />
                        </span>
                        <span>{subItem.label}</span>
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
