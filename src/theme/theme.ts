export const THEME_STORAGE_KEY = 'unicomp.theme';

export type ThemePreference = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export const themePreferences: readonly ThemePreference[] = ['system', 'dark', 'light'];

export function isThemePreference(value: string | null): value is ThemePreference {
  return value !== null && themePreferences.includes(value as ThemePreference);
}

export function readThemePreference(): ThemePreference {
  const storedPreference = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(storedPreference) ? storedPreference : 'dark';
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
): ResolvedTheme {
  if (preference !== 'system') {
    return preference;
  }

  return prefersDark ? 'dark' : 'light';
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolvedTheme = resolveTheme(preference);
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.style.colorScheme = resolvedTheme;
  return resolvedTheme;
}

export function initializeTheme(): ThemePreference {
  const preference = readThemePreference();
  applyTheme(preference);
  return preference;
}
