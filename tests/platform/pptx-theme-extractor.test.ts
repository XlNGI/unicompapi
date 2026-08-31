import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { extractPptxThemeColors } from '../../src/platform';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function writeThemePptx(colors: {
  accent1: string;
  dk1: string;
  lt1: string;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-theme-'));
  temporaryRoots.push(root);
  const theme = `<?xml version="1.0" encoding="UTF-8"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="${colors.dk1}"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="${colors.lt1}"/></a:lt1>
      <a:accent1><a:srgbClr val="${colors.accent1}"/></a:accent1>
      <a:accent2><a:srgbClr val="999999"/></a:accent2>
    </a:clrScheme>
  </a:themeElements>
</a:theme>`;
  const zip = new JSZip();
  zip.file('ppt/theme/theme1.xml', theme);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const filePath = path.join(root, 'template.pptx');
  await writeFile(filePath, Buffer.from(buffer));
  return filePath;
}

describe('pptx theme extractor', () => {
  it('extracts theme colors from a pptx theme part', async () => {
    const filePath = await writeThemePptx({
      accent1: '1F5FBF',
      dk1: '111111',
      lt1: 'FFFFFF'
    });
    const colors = await extractPptxThemeColors(filePath);
    expect(colors).toEqual({
      accent: '1F5FBF',
      background: 'FFFFFF',
      text: '111111',
      muted: '999999'
    });
  });
});
