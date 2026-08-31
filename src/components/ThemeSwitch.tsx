import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
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
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    menuRef.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus();

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
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
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []
    );
    if (options.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length)
          % options.length;
    options[next]?.focus();
  };

  const ActiveThemeIcon = themeIcons[preference];

  return (
    <div className="theme-switch" ref={containerRef}>
      <button
        type="button"
        className="theme-switch__trigger"
        aria-controls="theme-switch-menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={`切换主题，当前为${themeLabels[preference]}`}
        ref={triggerRef}
        title={`当前视觉：${themeLabels[resolvedTheme]}`}
        onClick={() => setIsOpen((open) => !open)}
      >
        <ActiveThemeIcon className="theme-switch__icon" size={16} aria-hidden="true" />
        <span>{themeLabels[preference]}</span>
        <LuChevronDown className="theme-switch__chevron" size={16} aria-hidden="true" />
      </button>

      {isOpen ? (
        <div
          aria-label="主题模式"
          className="theme-switch__menu"
          id="theme-switch-menu"
          onKeyDown={handleMenuKeyDown}
          ref={menuRef}
          role="menu"
        >
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
