import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

export interface ExtractedThemeColors {
  readonly accent: string;
  readonly background: string;
  readonly text: string;
  readonly muted: string;
}

export async function extractPptxThemeColors(
  absolutePath: string
): Promise<ExtractedThemeColors | undefined> {
  const buffer = await readFile(absolutePath);
  const zip = await JSZip.loadAsync(buffer);
  const themeName = Object.keys(zip.files).find((name) =>
    /^ppt\/theme\/theme\d+\.xml$/.test(name)
  );
  if (!themeName) return undefined;
  const xml = await zip.files[themeName].async('string');
  const schemeMatch = /<a:clrScheme[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(xml);
  if (!schemeMatch) return undefined;
  const colorOf = (name: string): string | undefined => {
    const match = new RegExp(
      `<a:${name}>\\s*<a:(?:srgbClr|sysClr)[^>]*?(?:val|lastClr)="([0-9A-Fa-f]{6})"`
    ).exec(schemeMatch[1]);
    return match ? match[1].toUpperCase() : undefined;
  };
  const accent = colorOf('accent1') ?? colorOf('accent2') ?? colorOf('accent3');
  const text = colorOf('dk1');
  const background = colorOf('lt1');
  if (!accent || !text || !background) return undefined;
  return {
    accent,
    background,
    text,
    muted: colorOf('accent2') ?? '666666'
  };
}
