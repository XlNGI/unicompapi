import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import {
  buildFallbackPresentationDesignIR,
  parsePresentationDesignIR,
  type PresentationDesignIRPage,
  type ProductionPresentationDesignIR
} from '../../src/domain/entities/presentation-design-contract';

/** Identical facts and template for every direction; only Art Direction changes. */
export const fixedDesignOutline: DocumentOutline = {
  kind: 'ppt', title: 'Atlas 产品价值验证', sections: [{
    heading: '投入更少，价值更快', level: 1, pageKind: 'insight',
    takeaway: '让团队把时间用于客户',
    blocks: [
      { type: 'bullets', items: ['交付时间缩短 35%', '客户续费率达到 92%'] },
      { type: 'paragraph', text: '基于 24 家试点客户的季度数据' },
      { type: 'paragraph', text: '统一工作流减少重复交接' }
    ],
    action: '下季度扩至 50 家客户'
  }]
};
const prefix = 'outline.sections[0]';
export const fixedContentRefs = {
  title: prefix + '.heading', takeaway: prefix + '.takeaway',
  firstMetric: prefix + '.blocks[0].items[0]', secondMetric: prefix + '.blocks[0].items[1]',
  evidence: prefix + '.blocks[1]', body: prefix + '.blocks[2]', action: prefix + '.action'
};
export const fixedBodyTexts = [fixedDesignOutline.sections[0].heading,
  fixedDesignOutline.sections[0].takeaway!, '交付时间缩短 35%', '客户续费率达到 92%',
  '基于 24 家试点客户的季度数据', '统一工作流减少重复交接', fixedDesignOutline.sections[0].action!];

export function fixedDesignDirections(): Record<'editorial' | 'dashboard' | 'narrative', ProductionPresentationDesignIR> {
  const base = buildFallbackPresentationDesignIR(fixedDesignOutline);
  const refs = fixedContentRefs;
  const page = base.pages[1];
  const contentRoles: PresentationDesignIRPage['contentRoles'] = {
    title: [refs.title], body: [refs.takeaway, refs.body, refs.action], metric: [refs.firstMetric, refs.secondMetric],
    evidence: [refs.evidence], image: [], chart: []
  };
  const direction = (body: PresentationDesignIRPage, global: Partial<ProductionPresentationDesignIR['globalDesign']>) => parsePresentationDesignIR({
    ...base, globalDesign: { ...base.globalDesign, ...global }, pages: [base.pages[0], body, base.pages[2]]
  }, { outline: fixedDesignOutline });
  return {
    editorial: direction({ ...page, pageRole: 'statement', pageIntent: 'Lead with one conclusion and generous whitespace',
      hierarchy: { primary: [refs.takeaway], secondary: [refs.title, refs.secondMetric], supporting: [refs.firstMetric, refs.evidence, refs.body, refs.action] },
      composition: { principle: 'single-focus', focalArea: 'center', balance: 'weighted', flow: 'left-to-right' },
      density: 'sparse', whitespace: 'generous', emphasis: { target: refs.takeaway, strength: 'dominant' },
      contentRoles, visualStrategy: 'A single editorial statement followed by small supporting facts'
    }, { visualTone: 'editorial', density: 'sparse', whitespace: 'generous', typographyDirection: 'display-led' }),
    dashboard: direction({ ...page, pageRole: 'metric', pageIntent: 'Compare the metrics with compact evidence',
      hierarchy: { primary: [refs.secondMetric], secondary: [refs.firstMetric, refs.title], supporting: [refs.takeaway, refs.evidence, refs.body, refs.action] },
      composition: { principle: 'grid', focalArea: 'right', balance: 'symmetric', flow: 'left-to-right' },
      density: 'dense', whitespace: 'minimal', emphasis: { target: refs.secondMetric, strength: 'dominant' },
      contentRoles, visualStrategy: 'A compact metric grid with the second metric as the visual focus'
    }, { visualTone: 'bold', density: 'dense', whitespace: 'minimal', typographyDirection: 'data-led' }),
    narrative: direction({ ...page, pageRole: 'evidence', pageIntent: 'Lead the reader from evidence to its implications',
      hierarchy: { primary: [refs.evidence], secondary: [refs.title, refs.takeaway, refs.secondMetric], supporting: [refs.firstMetric, refs.body, refs.action] },
      composition: { principle: 'evidence-led', focalArea: 'right', balance: 'asymmetric-right', flow: 'top-to-bottom' },
      density: 'balanced', whitespace: 'balanced', emphasis: { target: refs.evidence, strength: 'strong' },
      contentRoles, visualStrategy: 'Asymmetric evidence region beside a vertical explanatory narrative'
    }, { visualTone: 'minimal', density: 'balanced', whitespace: 'balanced', typographyDirection: 'balanced' })
  };
}
