import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ThemeContext } from './theme-context';
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY
} from './theme';
import type { ResolvedTheme, ThemePreference } from './theme';

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(preference)
  );

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    setResolvedTheme(applyTheme(preference));

    if (preference !== 'system') {
      return undefined;
    }

    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = () => {
      setResolvedTheme(applyTheme('system'));
    };

    systemTheme.addEventListener('change', handleSystemThemeChange);
    return () => systemTheme.removeEventListener('change', handleSystemThemeChange);
  }, [preference]);

  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
