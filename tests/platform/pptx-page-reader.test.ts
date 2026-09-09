import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { readPptxPage } from '../../src/platform/documents/pptx-page-reader';

let presentationBytes: Uint8Array;

beforeAll(async () => {
  const presentation = new PptxGenJS();
  for (let page = 1; page <= 7; page++) {
    const slide = presentation.addSlide();
    slide.addText(page === 1 ? '封面' : `物理页 ${page} 的独有内容`, { x: 1, y: 1, w: 6, h: 1 });
    if (page === 5) slide.addTable([
      [{ text: '季度' }, { text: '营收' }], [{ text: 'Q1' }, { text: '1200 万' }]
    ], { x: 1, y: 3, w: 6 });
  }
  presentationBytes = await presentation.write({ outputType: 'nodebuffer' }) as Buffer;
});

async function modifyPackage(change: (zip: JSZip) => Promise<void> | void): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(presentationBytes);
  await change(zip);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

const SLIDE_START = '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">';

describe('readPptxPage', () => {
  it('reads exactly physical page five, including table text, from a real generated presentation', async () => {
    const result = await readPptxPage(presentationBytes, 5);
    expect(result).toMatchObject({ pageNumber: 5, totalPages: 7, hidden: false });
    expect(result.text).toContain('物理页 5 的独有内容');
    expect(result.text).toContain('季度\n营收\nQ1\n1200 万');
    expect(result.text).not.toMatch(/物理页 [2467]|封面/);
    expect(await readPptxPage(presentationBytes, 1)).toMatchObject({ text: '封面' });
  });

  it('uses presentation order when the fifth relation points at slide7.xml', async () => {
    const bytes = await modifyPackage(async (zip) => {
      const name = 'ppt/_rels/presentation.xml.rels';
      const xml = await zip.file(name)!.async('string');
      zip.file(name, xml.replace('Target="slides/slide5.xml"', 'Target="slides/reordered.xml"')
        .replace('Target="slides/slide7.xml"', 'Target="slides/slide5.xml"')
        .replace('Target="slides/reordered.xml"', 'Target="slides/slide7.xml"'));
    });
    expect(await readPptxPage(bytes, 5)).toMatchObject({ text: '物理页 7 的独有内容', pageNumber: 5 });
    expect((await readPptxPage(bytes, 7)).text).toContain('物理页 5 的独有内容');
  });

  it('follows reordered sldIdLst entries instead of relation or filename order', async () => {
    const bytes = await modifyPackage(async (zip) => {
      const name = 'ppt/presentation.xml';
      const xml = await zip.file(name)!.async('string');
      const entries = [...xml.matchAll(/<p:sldId\s[^>]*\/>/g)].map((match) => match[0]);
      expect(entries).toHaveLength(7);
      zip.file(name, xml.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
        `<p:sldIdLst>${[...entries.slice(0, 4), entries[6], entries[5], entries[4]].join('')}</p:sldIdLst>`));
    });
    expect((await readPptxPage(bytes, 5)).text).toBe('物理页 7 的独有内容');
  });

  it('preserves a blank fifth page without substituting the following page', async () => {
    const bytes = await modifyPackage((zip) => {
      zip.file('ppt/slides/slide5.xml', `${SLIDE_START}<p:cSld><p:spTree/></p:cSld></p:sld>`);
    });
    expect(await readPptxPage(bytes, 5)).toEqual({ pageNumber: 5, totalPages: 7, text: '', hidden: false });
    expect((await readPptxPage(bytes, 6)).text).toBe('物理页 6 的独有内容');
  });

  it.each(['0', 'false'])('counts hidden slides and reports visibility show=%s', async (show) => {
    const bytes = await modifyPackage(async (zip) => {
      const name = 'ppt/slides/slide5.xml';
      zip.file(name, (await zip.file(name)!.async('string')).replace('<p:sld ', `<p:sld show="${show}" `));
    });
    expect(await readPptxPage(bytes, 5)).toMatchObject({ hidden: true, totalPages: 7 });
    expect((await readPptxPage(bytes, 6)).text).toBe('物理页 6 的独有内容');
  });

  it('decodes XML text without losing run spacing, paragraphs, breaks, or namespace aliases', async () => {
    const bytes = await modifyPackage((zip) => {
      zip.file('ppt/slides/slide5.xml', SLIDE_START +
        '<p:cSld><p:spTree><p:sp><p:txBody>' +
        '<a:p><a:r><a:t xml:space="preserve">  A &amp; B </a:t></a:r>' +
        '<a:r><a:t>&lt;标签&gt; &quot;引号&quot; &apos;单引号&apos; &#49; &#x1F409;</a:t></a:r>' +
        '<a:br/><a:r><a:t><![CDATA[原样 <&>]]></a:t></a:r></a:p>' +
        '<d:p xmlns:d="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<d:r><d:t>下一段</d:t></d:r></d:p>' +
        '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
    });
    expect((await readPptxPage(bytes, 5)).text).toBe('  A & B <标签> "引号" \'单引号\' 1 🐉\n原样 <&>\n下一段');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid page number %s', async (page) => {
      await expect(readPptxPage(presentationBytes, page)).rejects.toThrow('invalid page number');
    });

  it('rejects a page beyond the physical slide count', async () => {
    await expect(readPptxPage(presentationBytes, 8)).rejects.toMatchObject({ code: 'page_out_of_range' });
  });

  it.each([
    ['wrong relation type', 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide5.xml"', 'Type="invalid" Target="slides/slide5.xml"'],
    ['external relation', 'Target="slides/slide5.xml"', 'TargetMode="External" Target="https://example.invalid/slide5.xml"'],
    ['traversal target', 'Target="slides/slide5.xml"', 'Target="../../../secret.xml"'],
    ['encoded traversal', 'Target="slides/slide5.xml"', 'Target="slides/%2e%2e/secret.xml"'],
    ['missing slide', 'Target="slides/slide5.xml"', 'Target="slides/missing.xml"']
  ])('fails closed for %s', async (_description, original, replacement) => {
    const bytes = await modifyPackage(async (zip) => {
      const name = 'ppt/_rels/presentation.xml.rels';
      const xml = await zip.file(name)!.async('string');
      expect(xml).toContain(original);
      zip.file(name, xml.replace(original, replacement));
    });
    await expect(readPptxPage(bytes, 5)).rejects.toThrow();
  });

  it('rejects missing and duplicated relationship IDs', async () => {
    for (const duplicate of [false, true]) {
      const bytes = await modifyPackage(async (zip) => {
        const name = 'ppt/_rels/presentation.xml.rels';
        const xml = await zip.file(name)!.async('string');
        const relation = xml.match(/<Relationship\s[^>]*Target="slides\/slide5\.xml"[^>]*\/>/)![0];
        zip.file(name, xml.replace(relation, duplicate ? relation + relation : ''));
      });
      await expect(readPptxPage(bytes, 5)).rejects.toThrow();
    }
  });

  it.each(['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'ppt/slides/slide5.xml'])(
    'fails closed when a required package part is missing: %s', async (name) => {
      await expect(readPptxPage(await modifyPackage((zip) => { zip.remove(name); }), 5)).rejects.toThrow();
    });

  it.each([
    `${SLIDE_START}<a:p><a:r><a:t>第五页</a:r></a:t></a:p></p:sld>`,
    `${SLIDE_START}<a:p><a:r><a:t>&unknown;</a:t></a:r></a:p></p:sld>`,
    `${SLIDE_START}<a:p><a:r><a:t>&#0;</a:t></a:r></a:p></p:sld>`,
    `<!DOCTYPE p:sld [<!ENTITY injected SYSTEM "file:///secret">]>${SLIDE_START}</p:sld>`,
    `${SLIDE_START}<a:p><a:r><a:t>unclosed</a:t></a:r></a:p>`,
    `${SLIDE_START}<a:p xmlns:a="untrusted"><a:t>&bad;</a:t></a:p></p:sld>`
  ])('rejects malformed or unsafe target XML %#', async (xml) => {
    const bytes = await modifyPackage((zip) => { zip.file('ppt/slides/slide5.xml', xml); });
    await expect(readPptxPage(bytes, 5)).rejects.toThrow();
  });

  it('does not parse or recover text from an unrelated following slide', async () => {
    const bytes = await modifyPackage((zip) => { zip.file('ppt/slides/slide6.xml', 'broken XML'); });
    expect((await readPptxPage(bytes, 5)).text).toContain('物理页 5 的独有内容');
    await expect(readPptxPage(bytes, 6)).rejects.toThrow();
  });

  it('rejects unsafe ZIP paths before JSZip normalizes them', async () => {
    const bytes = await modifyPackage((zip) => { zip.file('../outside.xml', '<root/>'); });
    await expect(readPptxPage(bytes, 5)).rejects.toThrow('unsafe ZIP entry path');
  });

  it('enforces package and ZIP entry limits', async () => {
    await expect(readPptxPage(new Uint8Array(20 * 1024 * 1024 + 1), 1)).rejects.toMatchObject({ code: 'scope_exceeded' });
    const bytes = await modifyPackage((zip) => {
      for (let index = 0; index < 501; index++) zip.file(`extra${index}.txt`, '');
    });
    await expect(readPptxPage(bytes, 1)).rejects.toMatchObject({ code: 'scope_exceeded' });
  });

  it('rejects oversized compressed XML before extracting its contents', async () => {
    const bytes = await modifyPackage((zip) => { zip.file('ppt/slides/slide5.xml', ' '.repeat(10 * 1024 * 1024 + 1)); });
    await expect(readPptxPage(bytes, 5)).rejects.toMatchObject({ code: 'scope_exceeded' });
  });

  it('stops decompression even when corrupt metadata understates the XML size', async () => {
    const bytes = Buffer.from(await modifyPackage((zip) => {
      zip.file('ppt/slides/slide5.xml', ' '.repeat(10 * 1024 * 1024 + 65_536));
    }));
    const marker = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    let cursor = bytes.indexOf(marker);
    let changed = false;
    while (cursor >= 0) {
      const nameLength = bytes.readUInt16LE(cursor + 28);
      if (bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString() === 'ppt/slides/slide5.xml') {
        bytes.writeUInt32LE(64, cursor + 24);
        changed = true;
        break;
      }
      cursor = bytes.indexOf(marker, cursor + 4);
    }
    expect(changed).toBe(true);
    await expect(readPptxPage(bytes, 5)).rejects.toMatchObject({ code: 'scope_exceeded' });
  });

  it('rejects non-ZIP and truncated packages', async () => {
    await expect(readPptxPage(Buffer.from('not a presentation'), 1)).rejects.toThrow();
    await expect(readPptxPage(presentationBytes.slice(0, -10), 1)).rejects.toThrow();
  });
});
