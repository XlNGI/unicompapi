import JSZip from 'jszip';
import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import { buildFallbackPresentationDesignIR, parsePresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import { fixedBodyTexts, fixedDesignDirections, fixedDesignOutline } from './presentation-design-directions';

/** A second semantic page makes a layout-only repair's scope observable. */
export const repairProductionOutline: DocumentOutline = {
  ...fixedDesignOutline,
  title: 'Atlas 受控布局修正',
  sections: [fixedDesignOutline.sections[0], {
    heading: '实施边界', level: 1,
    blocks: [{ type: 'paragraph', text: '保留已经确认的流程和所有试点数据' }],
    takeaway: '调整版式不能调整事实', action: '确认后扩大试点'
  }]
};

export function repairProductionDesign() {
  const design = buildFallbackPresentationDesignIR(repairProductionOutline);
  return parsePresentationDesignIR({ ...design,
    globalDesign: fixedDesignDirections().editorial.globalDesign,
    pages: [design.pages[0], fixedDesignDirections().editorial.pages[1], ...design.pages.slice(2)]
  }, { outline: repairProductionOutline });
}

export const repairProductionFacts = [...fixedBodyTexts,
  repairProductionOutline.sections[1].heading, repairProductionOutline.sections[1].takeaway!,
  '保留已经确认的流程和所有试点数据', repairProductionOutline.sections[1].action!];

/** Inspect the actual saved OOXML, rather than a planner's claimed geometry. */
export async function readRepairArtifact(buffer: Uint8Array) {
  const zip = await JSZip.loadAsync(buffer);
  const slides = await Promise.all(Object.keys(zip.files)
    .filter(part => /^ppt\/slides\/slide\d+\.xml$/u.test(part))
    .sort((left, right) => Number(left.match(/slide(\d+)/u)![1]) - Number(right.match(/slide(\d+)/u)![1]))
    .map(async part => {
      const xml = await zip.file(part)!.async('string');
      const shapes = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/gu)].map(match => ({
        text: [...match[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)].map(item => decode(item[1])).join(''),
        geometry: match[0].match(/<a:xfrm[\s\S]*?<\/a:xfrm>/u)?.[0]
      })).filter(shape => shape.text.length > 0);
      return { part, xml, shapes };
    }));
  return { slides, text: slides.flatMap(slide => slide.shapes.map(shape => shape.text)).join('\n') };
}

function decode(value: string): string {
  return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'").replace(/&amp;/gu, '&');
}
