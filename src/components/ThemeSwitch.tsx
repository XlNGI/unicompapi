import { useEffect, useRef, useState } from 'react';
import { LuCheck, LuChevronDown, LuMonitor, LuMoon, LuSun } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { themePreferences } from '../theme/theme';
import type { ThemePreference } from '../theme/theme';
import { useTheme } from '../theme/useTheme';

const themeLabels: Record<ThemePreference, string> = {
  system: '跟随系统',
  dark: '深色',
  light: '浅色'
};

const themeIcons: Record<ThemePreference, IconType> = {
  system: LuMonitor,
  dark: LuMoon,
  light: LuSun
};

export function ThemeSwitch() {
  const { preference, resolvedTheme, setPreference } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  const selectTheme = (nextPreference: ThemePreference) => {
    setPreference(nextPreference);
    setIsOpen(false);
  };

  const ActiveThemeIcon = themeIcons[preference];

  return (
    <div className="theme-switch" ref={containerRef}>
      <button
        type="button"
        className="theme-switch__trigger"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={`切换主题，当前为${themeLabels[preference]}`}
        title={`当前视觉：${themeLabels[resolvedTheme]}`}
        onClick={() => setIsOpen((open) => !open)}
      >
        <ActiveThemeIcon className="theme-switch__icon" size={16} aria-hidden="true" />
        <span>{themeLabels[preference]}</span>
        <LuChevronDown className="theme-switch__chevron" size={16} aria-hidden="true" />
      </button>

      {isOpen ? (
        <div className="theme-switch__menu" role="menu" aria-label="主题模式">
          {themePreferences.map((option) => {
            const OptionIcon = themeIcons[option];
            const isSelected = preference === option;

            return (
              <button
                type="button"
                className="theme-switch__option"
                role="menuitemradio"
                aria-checked={isSelected}
                key={option}
                onClick={() => selectTheme(option)}
              >
                <span className="theme-switch__check" aria-hidden="true">
                  {isSelected ? <LuCheck size={16} /> : null}
                </span>
                <OptionIcon className="theme-switch__icon" size={16} aria-hidden="true" />
                <span>{themeLabels[option]}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
