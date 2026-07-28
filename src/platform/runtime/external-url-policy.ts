export function normalizeTrustedExternalUrl(rawUrl: string): string | undefined {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4_096) return undefined;
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      !url.hostname
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
