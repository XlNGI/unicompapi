import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import { buildFallbackPresentationDesignIR, buildPresentationArtDirectionInput, parsePresentationDesignIR,
  type PresentationDesignTree, type ProductionPresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';

export const autonomousOutline: DocumentOutline = { kind: 'ppt', title: 'Atlas 试点成果', sections: [{
  heading: '更快交付，保留客户', level: 1, blocks: [
    { type: 'paragraph', text: '客户续费率达到 92%' }, { type: 'paragraph', text: '交付时间缩短 35%' },
    { type: 'paragraph', text: '持续改进交付体验' }
  ]
}] };
/** Synthetic planner fixtures, never a production fallback or a page template. */
export function authoredFixtureDesign(outline = autonomousOutline, bodyTree?: PresentationDesignTree): ProductionPresentationDesignIR {
  const base = buildFallbackPresentationDesignIR(outline);
  const inventory = buildPresentationArtDirectionInput({ outline, userRequirement: 'Synthetic autonomous design test' });
  return parsePresentationDesignIR({ ...base, globalDesign: { ...base.globalDesign,
    visualSystem: { palette: { background: 'FFFFFF', surface: 'F1F5F9', text: '172A3A', muted: '475569', accent: '1F5FBF', secondaryAccent: '148070' } } },
    pages: base.pages.map((page, index) => {
      const refs = inventory.outline.pages[index].contentRefs;
      const leaves = refs.filter(ref => !refs.some(child => child.startsWith(ref + '.')));
      return { ...page, designTree: page.pageNumber === 2 && bodyTree ? bodyTree : { schemaVersion: 1,
        root: { nodeId: 'page-root', type: 'column', gap: 0.02, children: leaves.map((contentRef, item) => ({
          nodeId: `content-${item}`, type: 'content', contentRef,
          style: { fontSize: contentRef === 'outline.title' ? 40 : contentRef.endsWith('.heading') ? 30 : 22,
            fontWeight: contentRef === 'outline.title' || contentRef.endsWith('.heading') ? 700 : 400,
            alignment: page.pageNumber === 1 || page.pageRole === 'closing' ? 'center' : 'left' }
        })) } } };
    }) }, { outline });
}
export const bodyRefs = ['outline.sections[0].heading', ...[0, 1, 2].map(i => `outline.sections[0].blocks[${i}]`)];
export function splitTree(leftWeight = 65): PresentationDesignTree {
  return { schemaVersion: 1, root: { nodeId: 'split', type: 'row', gap: 0.03, children: [
    { nodeId: 'main', type: 'column', weight: leftWeight, gap: 0.04, children: [
      { nodeId: 'heading', type: 'content', contentRef: bodyRefs[0], style: { fontSize: 34, fontWeight: 700 } },
      { nodeId: 'metric', type: 'content', contentRef: bodyRefs[1], style: { fontSize: 24, color: '1F5FBF' },
        textSpans: [{ start: 8, end: 11, style: { fontWeight: 700, fontSize: 38 } }] }
    ] },
    { nodeId: 'evidence', type: 'column', weight: 100 - leftWeight, gap: 0.04, padding: 0.04,
      style: { fill: 'F1F5F9', borderColor: 'CBD5E1', borderWidth: 1 }, children: [
        { nodeId: 'delivery', type: 'content', contentRef: bodyRefs[2], style: { fontSize: 24 } },
        { nodeId: 'action', type: 'content', contentRef: bodyRefs[3], style: { fontSize: 24 } }
      ] }
  ] } };
}
